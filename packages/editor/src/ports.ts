import type { NodeCategory, NodeDefinition, PortType } from '@flow-patcher/engine';

/** Port colors decide what can connect to what at a glance (design.md, Core concepts). Tokens come from the flow-patcher-design skill. */
export const PORT_COLORS: Record<PortType, string> = {
  event: 'var(--fp-event)',
  note: 'var(--fp-note)',
  signal: 'var(--fp-signal)',
  audio: 'var(--fp-audio)',
  field: 'var(--fp-field)',
  value: 'var(--fp-value)',
};

/** Tinted fills per type, for chips that name a type (the palette's "Accepts note"). */
export const PORT_SOFT_COLORS: Record<PortType, string> = {
  event: 'var(--fp-event-soft)',
  note: 'var(--fp-note-soft)',
  signal: 'var(--fp-signal-soft)',
  audio: 'var(--fp-audio-soft)',
  field: 'var(--fp-field-soft)',
  value: 'var(--fp-value-soft)',
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

/** A node's glyph: its family's, except Output, which has its own (design system: family glyphs). */
export const nodeIcon = (definition: NodeDefinition) => (definition.type === 'output' ? 'speaker' : FAMILY_ICONS[definition.category]);

/** Short family names, as the palette lists them (design system FamilyChip). */
export const FAMILY_LABELS: Record<NodeCategory, string> = {
  'canvas-sources': 'Sources',
  'gesture-recognizers': 'Gestures',
  'time-rhythm': 'Time',
  'harmony-pitch': 'Harmony',
  'control-logic': 'Control',
  instruments: 'Instruments',
  'effects-mix': 'Effects',
  visual: 'Visual',
};
