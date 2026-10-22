import type { NodeDefinition } from '@flow-patcher/engine';
import { clock } from './clock';
import { delayEdge } from './delay-edge';
import { fluid } from './fluid';
import { makeNote } from './make-note';
import { output } from './output';
import { probability } from './probability';
import { sampleAndHold } from './sample-and-hold';
import { simpleSynth } from './simple-synth';
import { thresholdChange } from './threshold-change';

export { clock, delayEdge, fluid, makeNote, output, probability, sampleAndHold, simpleSynth, thresholdChange };

/** Every node type, in palette order. Add new node files here. */
export const nodeDefinitions: readonly NodeDefinition[] = [clock, probability, delayEdge, sampleAndHold, thresholdChange, makeNote, simpleSynth, output, fluid];

export const nodeRegistry: ReadonlyMap<string, NodeDefinition> = new Map(nodeDefinitions.map((d) => [d.type, d]));
