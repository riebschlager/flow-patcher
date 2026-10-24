import type { NodeDefinition } from '@flow-patcher/engine';
import { chordTone } from './chord-tone';
import { clock } from './clock';
import { curve } from './curve';
import { delayEdge } from './delay-edge';
import { drag } from './drag';
import { euclidean } from './euclidean';
import { flick } from './flick';
import { fluid } from './fluid';
import { force } from './force';
import { getField } from './get-field';
import { hold } from './hold';
import { makeNote } from './make-note';
import { mapRange } from './map-range';
import { midiIn } from './midi-in';
import { math } from './math';
import { orbitRings } from './orbit-rings';
import { output } from './output';
import { pinch } from './pinch';
import { pointer } from './pointer';
import { pointerHighRate } from './pointer-high-rate';
import { probability } from './probability';
import { progression } from './progression';
import { renderer } from './renderer';
import { sampleAndHold } from './sample-and-hold';
import { sampledVoice } from './sampled-voice';
import { simpleSynth } from './simple-synth';
import { smooth } from './smooth';
import { splat } from './splat';
import { tap } from './tap';
import { thresholdChange } from './threshold-change';

export { rendererImage } from './renderer';
export { InstrumentCache, instrumentCache, type InstrumentListener, type InstrumentStatus } from './instruments';
export { skippedNotes } from './sampled-voice';
export { INSTRUMENTS, INSTRUMENT_GROUPS, INSTRUMENT_KEYS, instrumentFile } from './music';
export { chordTone, clock, curve, delayEdge, drag, euclidean, flick, fluid, force, getField, hold, makeNote, mapRange, math, midiIn, orbitRings, output, pinch, pointer, pointerHighRate, probability, progression, renderer, sampleAndHold, sampledVoice, simpleSynth, smooth, splat, tap, thresholdChange };

/** Every node type, in palette order. Add new node files here. */
export const nodeDefinitions: readonly NodeDefinition[] = [pointer, pointerHighRate, midiIn, drag, tap, hold, flick, pinch, clock, euclidean, probability, delayEdge, sampleAndHold, thresholdChange, math, mapRange, curve, smooth, getField, progression, chordTone, makeNote, sampledVoice, simpleSynth, output, fluid, splat, force, orbitRings, renderer];

export const nodeRegistry: ReadonlyMap<string, NodeDefinition> = new Map(nodeDefinitions.map((d) => [d.type, d]));
