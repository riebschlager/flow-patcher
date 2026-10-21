// Copied raw from ../flow/public/fluid-renderer.js (Flow, GPL-3.0): the Canvas2D dye renderer.
// M0 spike only; the clean port happens in M1. Imports drop Flow's ?rev= cache busters.
// @ts-nocheck

import {canonicalDyes,getPalette,hexRGB} from './palettes.js';
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

// Interpret the original RGB dye as a point in the four-color palette polygon.
// Capped solver channels can drift outside that polygon. Project those mixtures
// onto its nearest edge, rather than extrapolating negative colors and clipping.
const vertices=canonicalDyes.map(c=>{const sum=c[0]+c[1]+c[2];return [c[0]/sum,c[1]/sum];});
const triangles=[[0,1,3],[0,3,2]].map(indices=>{
 const [a,b,c]=indices.map(i=>vertices[i]),den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
 return {indices,a,b,c,den};
});
const edges=[[0,1],[1,3],[3,2],[2,0]].map(([a,b])=>{const start=vertices[a],dx=vertices[b][0]-start[0],dy=vertices[b][1]-start[1];return {a,b,start,dx,dy,length:dx*dx+dy*dy};});
function createPigmentMapper(palette){
 const colors=getPalette(palette).colors.map(c=>hexRGB(c.hex));
 return (r,g,b,out)=>{
  const sum=r+g+b,x=r/sum,y=g/sum;
  for(const {indices,a,b,c,den} of triangles){
   const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den,v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den,w=1-u-v;
   if(u>=0&&v>=0&&w>=0){for(let j=0;j<3;j++)out[j]=colors[indices[0]][j]*u+colors[indices[1]][j]*v+colors[indices[2]][j]*w;return;}
  }
  let distance=Infinity,bestEdge=edges[0],bestT=0;
  for(const edge of edges){const {start,dx,dy,length}=edge,t=clamp(((x-start[0])*dx+(y-start[1])*dy)/length,0,1),ex=x-start[0]-t*dx,ey=y-start[1]-t*dy,d=ex*ex+ey*ey;if(d<distance){distance=d;bestEdge=edge;bestT=t;}}
  for(let j=0;j<3;j++)out[j]=colors[bestEdge.a][j]*(1-bestT)+colors[bestEdge.b][j]*bestT;
 };
}

// Palette colors are already display-ready sRGB. Keep their channel ratios and
// saturation; density only controls coverage over the dark background.
export function createFluidColorizer(palette){
 const mapDye=createPigmentMapper(palette),mapped=[0,0,0];
 return function colorize(r,g,b,lighting,gradient,out,offset=0){
  const density=Math.max(r,g,b);
  if(density<1e-10){out[offset]=7;out[offset+1]=10;out[offset+2]=17;return;}
  mapDye(r,g,b,mapped);
  const coverage=-Math.expm1(-density*1.65),ridge=Math.max(0,gradient);
  // Lighting can gently darken pigment or recover its original brightness. It
  // cannot oversaturate a swatch, normalize its channels, or add white to it.
  const brightness=Math.min(1,.84+.16*clamp(lighting,0,1)+.02*ridge/(1+ridge));
  const scale=255*coverage*brightness,remaining=1-coverage;
  out[offset]=7*remaining+mapped[0]*scale;
  out[offset+1]=10*remaining+mapped[1]*scale;
  out[offset+2]=17*remaining+mapped[2]*scale;
 };
}

// A one-cell Gaussian reconstruction softens solver-grid boundaries before
// nonlinear density/color mapping. No per-frame buffers or solver mutations.
function smooth(field,i,left,right,up,down){
 return (field[i]*4+(field[i+left]+field[i+right]+field[i+up]+field[i+down])*2+field[i+up+left]+field[i+up+right]+field[i+down+left]+field[i+down+right])/16;
}
// Geometry is immutable between resizes. Store exact double-precision lighting
// phases and integer neighbor offsets once rather than rebuild them per pixel.
const geometries=new WeakMap();
function geometry(sim){let cached=geometries.get(sim);if(cached?.w===sim.w&&cached?.h===sim.h)return cached;
 const {w,h}=sim,n=w*h,phase=new Float64Array(n),left=new Int16Array(n),right=new Int16Array(n),up=new Int16Array(n),down=new Int16Array(n);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=x+y*w;phase[i]=x*.035+y*.03;left[i]=x>0?-1:0;right[i]=x<w-1?1:0;up[i]=y>0?-w:0;down[i]=y<h-1?w:0;}
 cached={w,h,phase,left,right,up,down};geometries.set(sim,cached);return cached;
}
export function renderFluidPixels(sim,pixels,time,colorize,{luminance=1}={}){
 if(sim.w*sim.h>16128)return renderCached(sim,pixels,time,colorize,luminance);
 for(let y=0;y<sim.h;y++)for(let x=0;x<sim.w;x++){
  const i=x+y*sim.w,left=x>0?-1:0,right=x<sim.w-1?1:0,up=y>0?-sim.w:0,down=y<sim.h-1?sim.w:0;
  const r=smooth(sim.r,i,left,right,up,down),g=smooth(sim.g,i,left,right,up,down),b=smooth(sim.b,i,left,right,up,down);
  const gradient=(sim.r[i+right]+sim.g[i+right]+sim.b[i+right])-(sim.r[i+left]+sim.g[i+left]+sim.b[i+left]);
  const lighting=(.82+.18*Math.sin(x*.035+y*.03+time*.12))*luminance;
  colorize(r,g,b,lighting,gradient,pixels,i*4);pixels[i*4+3]=255;
 }
 return pixels;
}

function renderCached(sim,pixels,time,colorize,luminance){
 const grid=geometry(sim),{phase}=grid;
 for(let i=0;i<sim.w*sim.h;i++){
  const left=grid.left[i],right=grid.right[i],up=grid.up[i],down=grid.down[i];
  const r=smooth(sim.r,i,left,right,up,down),g=smooth(sim.g,i,left,right,up,down),b=smooth(sim.b,i,left,right,up,down);
  const gradient=(sim.r[i+right]+sim.g[i+right]+sim.b[i+right])-(sim.r[i+left]+sim.g[i+left]+sim.b[i+left]);
  const lighting=(.82+.18*Math.sin(phase[i]+time*.12))*luminance;
  colorize(r,g,b,lighting,gradient,pixels,i*4);pixels[i*4+3]=255;
 }
 return pixels;
}
