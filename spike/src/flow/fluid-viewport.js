// Copied raw from ../flow/public/fluid-viewport.js (Flow, GPL-3.0): grid sizing and resampling on resize.
// M0 spike only; the clean port happens in M1.
// @ts-nocheck

const channels=['u','v','r','g','b'];
// Keep solver cells approximately square in CSS space, independently of DPR.
// Budgets stay near the former 224×156 desktop / 144×112 mobile workloads.
export function fluidGridSize(width,height,{mobile=false}={}){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return null;
 const budget=mobile?16128:35000,maxSide=mobile?224:384;
 const spacing=Math.max(Math.sqrt(width*height/budget),width/maxSide,height/maxSide);
 return {w:Math.max(8,Math.floor(width/spacing)),h:Math.max(8,Math.floor(height/spacing))};
}

// Resample dye smoothly and preserve velocity in normalized canvas units.
// Scratch pressure/advection buffers belong to the destination and stay clear.
export function resampleFluidState(source,target){
 const sw=source.w,sh=source.h,tw=target.w,th=target.h;
 for(let y=0;y<th;y++){
  const sy=Math.max(0,Math.min(sh-1,(y+.5)*sh/th-.5)),y0=Math.floor(sy),y1=Math.min(sh-1,y0+1),fy=sy-y0;
  for(let x=0;x<tw;x++){
   const sx=Math.max(0,Math.min(sw-1,(x+.5)*sw/tw-.5)),x0=Math.floor(sx),x1=Math.min(sw-1,x0+1),fx=sx-x0,i=x+y*tw;
   for(const key of channels){
    const a=source[key],value=(a[x0+y0*sw]*(1-fx)+a[x1+y0*sw]*fx)*(1-fy)+(a[x0+y1*sw]*(1-fx)+a[x1+y1*sw]*fx)*fy;
    target[key][i]=key==='u'?Math.max(-1000,Math.min(1000,value*tw/sw)):key==='v'?Math.max(-1000,Math.min(1000,value*th/sh)):value;
   }
  }
 }
}
