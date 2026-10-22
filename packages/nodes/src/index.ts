import type { NodeDefinition } from '@flow-patcher/engine';
import { clock } from './clock';
import { delayEdge } from './delay-edge';
import { fluid } from './fluid';
import { makeNote } from './make-note';
import { output } from './output';
import { probability } from './probability';
import { simpleSynth } from './simple-synth';

export { clock, delayEdge, fluid, makeNote, output, probability, simpleSynth };

/** Every node type, in palette order. Add new node files here. */
export const nodeDefinitions: readonly NodeDefinition[] = [clock, probability, delayEdge, makeNote, simpleSynth, output, fluid];

export const nodeRegistry: ReadonlyMap<string, NodeDefinition> = new Map(nodeDefinitions.map((d) => [d.type, d]));
