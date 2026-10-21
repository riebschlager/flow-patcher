// Copied raw from ../flow/public/rhythm.js (Flow, GPL-3.0): the Euclidean pattern helpers.
// M0 spike only; the clean port happens in M3.
// @ts-nocheck

const clamp=(v,lo,hi,fallback)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Number(v))):fallback;
export function rotatePattern(steps,offset=1){const n=steps.length,k=((Math.round(offset)%n)+n)%n;return steps.map((_,i)=>steps[(i-k+n)%n]);}
export function euclidean(hits=4,rotation=0){hits=Math.round(clamp(hits,0,16,4));const p=Array.from({length:16},(_,i)=>(i*hits)%16<hits?(i%4===0?1:.65):0);return rotatePattern(p,rotation);}
