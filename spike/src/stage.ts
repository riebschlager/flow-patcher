// The performance canvas, which PerformanceCanvas registers and the Fluid and Renderer nodes use: one canvas per patch.
let canvas: HTMLCanvasElement | null = null;

export const setStage = (c: HTMLCanvasElement | null) => { canvas = c; };
export const stage = () => canvas;

/** Flow's mobile test: a narrow window or a coarse pointer gets the smaller grid. */
export const isMobile = () => window.innerWidth <= 720 || !!window.matchMedia?.('(pointer: coarse)').matches;
