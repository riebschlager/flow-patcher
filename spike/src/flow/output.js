// Copied raw from ../flow/public/output.js (Flow, GPL-3.0): the output stage — makeup, limiter, peak guard, master.
// M0 spike only; the clean port happens in M1.
// @ts-nocheck

// A fixed gain correction keeps quiet performances expressive: no automatic
// gain riding, which would lift silence/tails or undo Conduct gestures.
export const DEFAULT_MASTER_VOLUME=70;
export const OUTPUT_MAKEUP=1.6; // +4.1 dB after the existing mix compressor.
export const OUTPUT_CEILING=.9;
export function masterLevel(percent){const value=Number(percent);return Number.isFinite(value)?Math.max(0,Math.min(100,value))/100:DEFAULT_MASTER_VOLUME/100;}
export function createOutputStage(context,input,master){
 const makeup=context.createGain();makeup.gain.value=OUTPUT_MAKEUP;
 const limiter=context.createDynamicsCompressor();limiter.threshold.value=-3;limiter.knee.value=3;limiter.ratio.value=20;limiter.attack.value=.003;limiter.release.value=.25;
 // Web Audio's compressor can overshoot on fast attacks. This final guard is
 // exactly linear below the ceiling and catches only remaining sample peaks.
 const guard=context.createWaveShaper(),curve=new Float32Array(4097);
 for(let i=0;i<curve.length;i++){const x=2*i/(curve.length-1)-1;curve[i]=Math.max(-OUTPUT_CEILING,Math.min(OUTPUT_CEILING,x));}
 guard.curve=curve;guard.oversample='none';
 input.connect(makeup);makeup.connect(limiter);limiter.connect(guard);guard.connect(master);
 return {makeup,limiter,guard};
}
