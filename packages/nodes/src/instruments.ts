// The instrument cache behind Sampled Voice, and WebAudioFont's zone playback.
//
// Flow loaded each instrument by adding vendor/<file>.js as a <script>, which
// set a global preset, then decoded every zone's base64 MP3 and handed the
// preset to WebAudioFontPlayer (AmbientAudio.load in ../flow/public/music.js).
// Here the host's `samples` service returns the file's text, `parseSampleFile`
// reads the zones out of it as data (never evaluated), and the zones decode
// through the context's decodeAudioData. Nothing loads WebAudioFontPlayer.js.
//
// `findZone` and `zonePlayback` port the parts of WebAudioFontPlayer.js
// (queueWaveTable, findZone, adjustZone) that pick a zone and set the source's
// playbackRate and loop. WebAudioFont is by Sergey Surikov,
// https://github.com/surikov/webaudiofont, GPL-3.0 (vendor/LICENSE-WebAudioFont.md).
// Changes from WebAudioFont:
// - A pitch outside every zone gets the nearest zone; WebAudioFont fell back to
//   the first zone in the file, whatever its range.
// - Zones decode before the instrument is ready, so a zone never plays without
//   its buffer (WebAudioFont decoded in the background and skipped the note).
//
// One cache serves every Sampled Voice: entries are keyed by audio context
// (weakly, so a closed context's buffers can go) and instrument key, so a
// second instance, or one rebuilt by a hot swap, reuses what is loaded. It
// lives in module scope on purpose: it holds decoded audio, not node state.
import type { AudioBufferLike, AudioContextLike } from '@flow-patcher/engine';
import { instrumentFile, instrumentFor } from './music';

/** One zone of a WebAudioFont preset, as the sample file holds it. */
export interface SampleZone {
  midi: number;
  /** Pitch the sample was recorded at, in cents (MIDI × 100). */
  originalPitch: number;
  /** MIDI pitches the zone covers. */
  keyRangeLow: number;
  keyRangeHigh: number;
  /** Loop points in sample frames at `sampleRate`. No loop unless 1 ≤ loopStart < loopEnd. */
  loopStart: number;
  loopEnd: number;
  /** Semitones. */
  coarseTune: number;
  /** Cents. */
  fineTune: number;
  sampleRate: number;
  /** The sample, an encoded audio file (MP3) in base64. */
  file: string;
}

/** A zone with its sample decoded. */
export interface LoadedZone extends Omit<SampleZone, 'file'> {
  buffer: AudioBufferLike;
}

export interface LoadedInstrument {
  key: string;
  zones: readonly LoadedZone[];
}

// ---- Parsing ----

/** Thrown for a sample file that isn't a WebAudioFont preset. */
export class SampleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleFileError';
  }
}

type Literal = number | string | boolean;

/**
 * Reads the zones of a WebAudioFont preset file without running it: finds
 * `zones:[` and reads each `{key: value, …}` in it, where a value is a number,
 * a quoted string or true/false. Comments are skipped. Fields WebAudioFont
 * treats as optional get its defaults. Throws SampleFileError on anything else.
 */
export function parseSampleFile(text: string): SampleZone[] {
  const start = /\bzones\s*:\s*\[/.exec(text);
  if (!start) throw new SampleFileError('no zones');
  let i = start.index + start[0].length;

  const skip = () => {
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i]!)) i++;
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end + 1;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) throw new SampleFileError('unclosed comment');
        i = end + 2;
      } else return;
    }
  };
  const value = (): Literal => {
    const quote = text[i];
    if (quote === "'" || quote === '"') {
      const end = text.indexOf(quote, i + 1);
      if (end < 0) throw new SampleFileError('unclosed string');
      const s = text.slice(i + 1, end);
      if (s.includes('\\')) throw new SampleFileError('escapes in strings are not supported');
      i = end + 1;
      return s;
    }
    const m = /^(?:true|false|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(text.slice(i, i + 40));
    if (!m) throw new SampleFileError(`unexpected value at ${i}`);
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0]);
  };

  const zones: SampleZone[] = [];
  for (;;) {
    skip();
    if (text[i] === ']') break;
    if (text[i] !== '{') throw new SampleFileError(`expected a zone at ${i}`);
    i++;
    const fields: Record<string, Literal> = {};
    for (;;) {
      skip();
      if (text[i] === '}') { i++; break; }
      const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64));
      if (!key) throw new SampleFileError(`expected a field at ${i}`);
      i += key[0].length;
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== ':') throw new SampleFileError(`expected ':' after ${key[0]}`);
      i++;
      while (/\s/.test(text[i] ?? '')) i++;
      fields[key[0]] = value();
    }
    zones.push(zoneFrom(fields));
  }
  if (!zones.length) throw new SampleFileError('no zones');
  return zones;
}

function zoneFrom(fields: Record<string, Literal>): SampleZone {
  const num = (name: string, fallback?: number): number => {
    const v = fields[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (fallback === undefined) throw new SampleFileError(`zone without ${name}`);
    return fallback;
  };
  const file = fields.file;
  if (typeof file !== 'string' || !file) throw new SampleFileError('zone without a sample file');
  // WebAudioFont's defaults (adjustZone's numValue calls).
  return {
    midi: num('midi', 0),
    originalPitch: num('originalPitch', 6000),
    keyRangeLow: num('keyRangeLow'),
    keyRangeHigh: num('keyRangeHigh'),
    loopStart: num('loopStart', 0),
    loopEnd: num('loopEnd', 0),
    coarseTune: num('coarseTune', 0),
    fineTune: num('fineTune', 0),
    sampleRate: num('sampleRate', 44100),
    file,
  };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = new Int16Array(128).fill(-1);
for (let k = 0; k < BASE64.length; k++) BASE64_INDEX[BASE64.charCodeAt(k)] = k;

/** Decodes base64 (padding and whitespace allowed) to a fresh ArrayBuffer. Here because the nodes package has no DOM or Node lib for atob/Buffer. */
export function decodeBase64(text: string): ArrayBuffer {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0, count = 0, n = 0;
  for (let k = 0; k < text.length; k++) {
    const code = text.charCodeAt(k);
    if (code === 61) break; // '='
    const v = code < 128 ? BASE64_INDEX[code]! : -1;
    if (v < 0) {
      if (code === 32 || code === 10 || code === 13 || code === 9) continue;
      throw new SampleFileError('bad base64');
    }
    bits = (bits << 6) | v;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[n++] = (bits >> count) & 0xff;
    }
  }
  return out.buffer.slice(0, n);
}

// ---- Playback (WebAudioFont) ----

/** The zone that plays `pitch`: the last zone whose range holds it (WebAudioFont lets a zone reach one key past its top), else the nearest. Undefined for no zones. */
export function findZone<Z extends Pick<SampleZone, 'keyRangeLow' | 'keyRangeHigh'>>(zones: readonly Z[], pitch: number): Z | undefined {
  for (let k = zones.length - 1; k >= 0; k--) {
    const zone = zones[k]!;
    if (zone.keyRangeLow <= pitch && zone.keyRangeHigh + 1 >= pitch) return zone;
  }
  let best: Z | undefined, distance = Infinity;
  for (const zone of zones) {
    const d = pitch < zone.keyRangeLow ? zone.keyRangeLow - pitch : pitch - zone.keyRangeHigh;
    if (d < distance) { best = zone; distance = d; }
  }
  return best;
}

export interface ZonePlayback {
  /** The source's playbackRate for the pitch. */
  playbackRate: number;
  loop: boolean;
  /** Seconds into the buffer. */
  loopStart: number;
  loopEnd: number;
}

/** How a zone plays a MIDI pitch, as queueWaveTable sets up its buffer source. */
export function zonePlayback(zone: Omit<SampleZone, 'file' | 'midi'>, pitch: number): ZonePlayback {
  const baseDetune = zone.originalPitch - 100 * zone.coarseTune - zone.fineTune;
  const playbackRate = 2 ** ((100 * pitch - baseDetune) / 1200);
  const loop = !(zone.loopStart < 1 || zone.loopStart >= zone.loopEnd);
  return { playbackRate, loop, loopStart: zone.loopStart / zone.sampleRate, loopEnd: zone.loopEnd / zone.sampleRate };
}

// ---- Cache ----

/** 'idle' until something asks for the instrument on that context. 'error' stays until a later `load` retries. */
export type InstrumentStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Called on every status change of any instrument on any context. */
export type InstrumentListener = (audio: AudioContextLike, key: string, status: InstrumentStatus) => void;

interface Entry {
  status: InstrumentStatus;
  promise: Promise<LoadedInstrument>;
  instrument?: LoadedInstrument;
  error?: string;
}

export class InstrumentCache {
  private readonly contexts = new WeakMap<AudioContextLike, Map<string, Entry>>();
  private readonly listeners = new Set<InstrumentListener>();

  /**
   * Starts loading an instrument on this context, or returns the load already
   * under way or done. Rejects for an unknown key, a missing `samples` service,
   * a missing or malformed file or a sample that won't decode; the entry then
   * reads 'error', and the next `load` tries again from scratch.
   */
  load(audio: AudioContextLike, key: string, samples: ((file: string) => Promise<string>) | undefined): Promise<LoadedInstrument> {
    const entries = this.entries(audio);
    const existing = entries.get(key);
    if (existing && existing.status !== 'error') return existing.promise;
    const entry: Entry = { status: 'loading', promise: undefined! };
    entry.promise = (async () => {
      const instrument = instrumentFor(key);
      if (!instrument) throw new Error(`Unknown instrument "${key}"`);
      if (!samples) throw new Error('No samples service: the host has to provide HostServices.samples');
      const zones = parseSampleFile(await samples(instrumentFile(instrument)));
      const loaded = await Promise.all(zones.map(async ({ file, ...zone }) => ({ ...zone, buffer: await audio.decodeAudioData(decodeBase64(file)) })));
      return { key, zones: loaded };
    })();
    entries.set(key, entry);
    this.emit(audio, key, 'loading');
    entry.promise.then(
      (instrument) => {
        if (entries.get(key) !== entry) return;
        entry.status = 'ready';
        entry.instrument = instrument;
        this.emit(audio, key, 'ready');
      },
      (error: unknown) => {
        if (entries.get(key) !== entry) return;
        entry.status = 'error';
        entry.error = error instanceof Error ? error.message : String(error);
        this.emit(audio, key, 'error');
      },
    );
    return entry.promise;
  }

  /** The instrument once it is ready on this context, else undefined. */
  get(audio: AudioContextLike, key: string): LoadedInstrument | undefined {
    return this.contexts.get(audio)?.get(key)?.instrument;
  }

  status(audio: AudioContextLike, key: string): InstrumentStatus {
    return this.contexts.get(audio)?.get(key)?.status ?? 'idle';
  }

  /** Why the last load failed, while the status is 'error'. */
  error(audio: AudioContextLike, key: string): string | undefined {
    const entry = this.contexts.get(audio)?.get(key);
    return entry?.status === 'error' ? entry.error : undefined;
  }

  /** Listens to status changes; returns the unsubscribe function. */
  subscribe(listener: InstrumentListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private entries(audio: AudioContextLike): Map<string, Entry> {
    let entries = this.contexts.get(audio);
    if (!entries) this.contexts.set(audio, (entries = new Map()));
    return entries;
  }

  private emit(audio: AudioContextLike, key: string, status: InstrumentStatus): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(audio, key, status);
      } catch {
        // A broken listener (an editor widget) must not stop loading or the others.
      }
    }
  }
}

/** The cache every Sampled Voice shares. */
export const instrumentCache = new InstrumentCache();
