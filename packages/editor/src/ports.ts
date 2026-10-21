import type { NodeCategory, PortType } from '@flow-patcher/engine';

/** Port colors decide what can connect to what at a glance (design.md, Core concepts). Tokens come from the flow-patcher-design skill. */
export const PORT_COLORS: Record<PortType, string> = {
  event: 'var(--fp-event)',
  note: 'var(--fp-note)',
  signal: 'var(--fp-signal)',
  audio: 'var(--fp-audio)',
  field: 'var(--fp-field)',
  value: 'var(--fp-value)',
};

/** Port shape footprint in px, [width, height]. Shape backs up color so the graph reads in grayscale. */
export const PORT_SIZE: Record<PortType, [number, number]> = {
  event: [9, 9],
  note: [9, 9],
  signal: [10, 10],
  audio: [13, 8],
  field: [10, 10],
  value: [10, 10],
};

/** Cable stroke per type; `inner` draws a canvas-colored core so Field cables read as a hollow tube. */
export const CABLE_STYLES: Record<PortType, { width: number; dash?: string; cap?: 'round'; inner?: number }> = {
  event: { width: 1.5, dash: '3 3' },
  note: { width: 1.5, dash: '8 3' },
  signal: { width: 1.5, cap: 'round' },
  audio: { width: 3, cap: 'round' },
  field: { width: 5, inner: 1.6 },
  value: { width: 1.8, dash: '0.1 4.5', cap: 'round' },
};

/** One Lucide glyph per node family. */
export const FAMILY_ICONS: Record<NodeCategory, string> = {
  'canvas-sources': 'mouse-pointer-2',
  'gesture-recognizers': 'hand',
  'time-rhythm': 'timer',
  'harmony-pitch': 'music',
  'control-logic': 'git-fork',
  instruments: 'piano',
  'effects-mix': 'audio-waveform',
  visual: 'droplets',
};
