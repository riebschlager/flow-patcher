import type { NodeDefinition } from '@flow-patcher/engine';
import { chordTone } from './chord-tone';
import { clock } from './clock';
import { delayEdge } from './delay-edge';
import { euclidean } from './euclidean';
import { fluid } from './fluid';
import { makeNote } from './make-note';
import { output } from './output';
import { pointer } from './pointer';
import { probability } from './probability';
import { progression } from './progression';
import { sampleAndHold } from './sample-and-hold';
import { simpleSynth } from './simple-synth';
import { splat } from './splat';
import { thresholdChange } from './threshold-change';

export { chordTone, clock, delayEdge, euclidean, fluid, makeNote, output, pointer, probability, progression, sampleAndHold, simpleSynth, splat, thresholdChange };

/** Every node type, in palette order. Add new node files here. */
export const nodeDefinitions: readonly NodeDefinition[] = [pointer, clock, euclidean, probability, delayEdge, sampleAndHold, thresholdChange, progression, chordTone, makeNote, simpleSynth, output, fluid, splat];

export const nodeRegistry: ReadonlyMap<string, NodeDefinition> = new Map(nodeDefinitions.map((d) => [d.type, d]));
