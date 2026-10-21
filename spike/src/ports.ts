import type { PortType } from './registry';

// Copied from packages/editor/src/ports.ts (spike can't import packages/): color and stroke per port type.
export const PORT_COLORS: Record<PortType, string> = {
  event: 'var(--fp-event)',
  note: 'var(--fp-note)',
  signal: 'var(--fp-signal)',
  audio: 'var(--fp-audio)',
  value: 'var(--fp-value)',
};

export const CABLE_STYLES: Record<PortType, { width: number; dash?: string; cap?: 'round' }> = {
  event: { width: 1.5, dash: '3 3' },
  note: { width: 1.5, dash: '8 3' },
  signal: { width: 1.5, cap: 'round' },
  audio: { width: 3, cap: 'round' },
  value: { width: 1.8, dash: '0.1 4.5', cap: 'round' },
};
