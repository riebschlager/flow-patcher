import type { KnobDef } from './registry';

// Kept out of registry.ts: node files import it, and registry.ts imports the node files.

/** A menu knob over a list: min/max/step come from the list. */
export const menu = (name: string, label: string, options: string[], initial = 0): KnobDef =>
  ({ name, label, min: 0, max: options.length - 1, default: initial, step: 1, options });
