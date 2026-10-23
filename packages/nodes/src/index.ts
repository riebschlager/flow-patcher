import type { NodeDefinition } from '@flow-patcher/engine';
import { chordTone } from './chord-tone';
import { clock } from './clock';
import { curve } from './curve';
import { delayEdge } from './delay-edge';
import { euclidean } from './euclidean';
import { fluid } from './fluid';
import { makeNote } from './make-note';
import { mapRange } from './map-range';
import { math } from './math';
import { output } from './output';
import { pointer } from './pointer';
import { probability } from './probability';
import { progression } from './progression';
import { renderer } from './renderer';
import { sampleAndHold } from './sample-and-hold';
import { sampledVoice } from './sampled-voice';
import { simpleSynth } from './simple-synth';
import { smooth } from './smooth';
import { splat } from './splat';
import { thresholdChange } from './threshold-change';

export { rendererImage } from './renderer';
export { InstrumentCache, instrumentCache, type InstrumentListener, type InstrumentStatus } from './instruments';
export { skippedNotes } from './sampled-voice';
export { INSTRUMENTS, INSTRUMENT_GROUPS, INSTRUMENT_KEYS, instrumentFile } from './music';
export { chordTone, clock, curve, delayEdge, euclidean, fluid, makeNote, mapRange, math, output, pointer, probability, progression, renderer, sampleAndHold, sampledVoice, simpleSynth, smooth, splat, thresholdChange };

/** Every node type, in palette order. Add new node files here. */
export const nodeDefinitions: readonly NodeDefinition[] = [pointer, clock, euclidean, probability, delayEdge, sampleAndHold, thresholdChange, math, mapRange, curve, smooth, progression, chordTone, makeNote, sampledVoice, simpleSynth, output, fluid, splat, renderer];

export const nodeRegistry: ReadonlyMap<string, NodeDefinition> = new Map(nodeDefinitions.map((d) => [d.type, d]));
