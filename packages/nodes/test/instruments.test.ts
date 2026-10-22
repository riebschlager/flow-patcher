// The sample-file parser, WebAudioFont's zone playback and the shared cache.
// The vendor-file checks port Flow's checks/soundscapes.test.mjs, which ran
// each file in node:vm; here vm is only the test's oracle for the parser.
// The loading checks port the cache parts of checks/chaos-voices.test.mjs
// (shared and retryable loading) and audio-lifetime.test.mjs (decoded
// instruments stay reusable).
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import type { AudioContextLike } from '@flow-patcher/engine';
import { decodeBase64, findZone, InstrumentCache, parseSampleFile, SampleFileError, zonePlayback, type InstrumentStatus } from '../src/instruments';
import { INSTRUMENT_KEYS, INSTRUMENTS, instrumentFile } from '../src/music';
import { vendorSamples } from './helpers';

const VENDOR = new URL('../../../vendor/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, VENDOR), 'utf8');
const context = () => new OfflineAudioContext(1, 128, 48000) as unknown as AudioContextLike;

describe('parseSampleFile', () => {
  const files = readdirSync(VENDOR).filter((f) => f.endsWith('_FluidR3_GM_sf2_file.js'));

  it('covers every instrument, and vendor/ holds exactly their files', () => {
    expect(files.sort()).toEqual(INSTRUMENT_KEYS.map((k) => instrumentFile(INSTRUMENTS[k]!)).sort());
  });

  it.each(files)('reads the same zones as running %s', (file) => {
    const text = read(file);
    const sandbox = vm.createContext({ console: { log() {} } });
    vm.runInContext(text, sandbox);
    const preset = sandbox[`_tone_${file.replace(/\.js$/, '')}`] as { zones: Record<string, unknown>[] };
    const zones = parseSampleFile(text);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones).toHaveLength(preset.zones.length);
    zones.forEach((zone, k) => {
      const expected = preset.zones[k]!;
      for (const field of ['midi', 'originalPitch', 'keyRangeLow', 'keyRangeHigh', 'loopStart', 'loopEnd', 'coarseTune', 'fineTune', 'sampleRate', 'file'] as const) {
        expect(zone[field], `${file} zone ${k} ${field}`).toBe(expected[field]);
      }
      expect(zone.file.length).toBeGreaterThan(100);
    });
  });

  it('applies WebAudioFont defaults and rejects what is not a preset', () => {
    const [zone] = parseSampleFile("var x={zones:[{keyRangeLow:0,keyRangeHigh:127,file:'AAAA' /* c */}]}; // done");
    expect(zone).toEqual({ midi: 0, originalPitch: 6000, keyRangeLow: 0, keyRangeHigh: 127, loopStart: 0, loopEnd: 0, coarseTune: 0, fineTune: 0, sampleRate: 44100, file: 'AAAA' });
    // A comment marker inside a string is data, as base64 often has "//".
    expect(parseSampleFile("zones:[{keyRangeLow:1,keyRangeHigh:2,file:'//tA//'}]")[0]!.file).toBe('//tA//');
    for (const bad of ['', 'zones:[]', 'zones:[{keyRangeLow:0,keyRangeHigh:1}]', "zones:[{keyRangeHigh:1,file:'A'}]", "zones:[{keyRangeLow:x,keyRangeHigh:1,file:'A'}]", "zones:[{file:'A", '<html>404</html>']) {
      expect(() => parseSampleFile(bad), bad).toThrow(SampleFileError);
    }
  });
});

describe('decodeBase64', () => {
  it('decodes what Node encodes, with or without padding', () => {
    for (const bytes of [[], [0], [1, 2], [255, 254, 253], [...Array(1000).keys()].map((n) => (n * 37) % 256)]) {
      const text = Buffer.from(bytes).toString('base64');
      expect([...new Uint8Array(decodeBase64(text))]).toEqual(bytes);
      expect([...new Uint8Array(decodeBase64(text.replace(/=+$/, '')))]).toEqual(bytes);
    }
    expect(() => decodeBase64('ab$c')).toThrow(SampleFileError);
  });
});

describe('findZone', () => {
  const zones = [{ keyRangeLow: 0, keyRangeHigh: 40 }, { keyRangeLow: 41, keyRangeHigh: 60 }, { keyRangeLow: 70, keyRangeHigh: 80 }];

  it('picks the last zone holding the pitch, reaching one key past its top as WebAudioFont does', () => {
    expect(findZone(zones, 10)).toBe(zones[0]);
    expect(findZone(zones, 50)).toBe(zones[1]);
    expect(findZone(zones, 41)).toBe(zones[1]);
    expect(findZone(zones, 61)).toBe(zones[1]);
  });

  it('falls back to the nearest zone outside every range', () => {
    expect(findZone(zones, 68)).toBe(zones[2]);
    expect(findZone(zones, 64)).toBe(zones[1]);
    expect(findZone(zones, 127)).toBe(zones[2]);
    expect(findZone([], 60)).toBeUndefined();
  });

  it('covers every MIDI pitch in every instrument', () => {
    for (const key of INSTRUMENT_KEYS) {
      const parsed = parseSampleFile(read(instrumentFile(INSTRUMENTS[key]!)));
      for (let pitch = 0; pitch <= 127; pitch++) expect(findZone(parsed, pitch)).toBeDefined();
    }
  });
});

describe('zonePlayback', () => {
  const zone = { originalPitch: 6000, keyRangeLow: 0, keyRangeHigh: 127, loopStart: 4410, loopEnd: 8820, coarseTune: 0, fineTune: 0, sampleRate: 44100 };

  it('sets playbackRate from the original pitch and tuning', () => {
    expect(zonePlayback(zone, 60).playbackRate).toBe(1);
    expect(zonePlayback(zone, 72).playbackRate).toBeCloseTo(2, 12);
    expect(zonePlayback(zone, 48).playbackRate).toBeCloseTo(0.5, 12);
    // Coarse tune is semitones, fine tune cents: both raise the played pitch.
    expect(zonePlayback({ ...zone, coarseTune: 12 }, 60).playbackRate).toBeCloseTo(2, 12);
    expect(zonePlayback({ ...zone, fineTune: 1200 }, 60).playbackRate).toBeCloseTo(2, 12);
    expect(zonePlayback({ ...zone, originalPitch: 5700 }, 69).playbackRate).toBeCloseTo(2, 12);
  });

  it('loops between the loop points, in seconds, only when they make a loop', () => {
    expect(zonePlayback(zone, 60)).toMatchObject({ loop: true, loopStart: 0.1, loopEnd: 0.2 });
    expect(zonePlayback({ ...zone, loopStart: 0 }, 60).loop).toBe(false);
    expect(zonePlayback({ ...zone, loopStart: 9000 }, 60).loop).toBe(false);
  });
});

describe('InstrumentCache', () => {
  it('loads and decodes an instrument once per context, sharing it between callers', async () => {
    const cache = new InstrumentCache(), samples = vendorSamples(), audio = context();
    expect(cache.status(audio, 'vibes')).toBe('idle');
    const a = cache.load(audio, 'vibes', samples), b = cache.load(audio, 'vibes', samples);
    expect(cache.status(audio, 'vibes')).toBe('loading');
    expect(a).toBe(b);
    const instrument = await a;
    expect(cache.status(audio, 'vibes')).toBe('ready');
    expect(cache.get(audio, 'vibes')).toBe(instrument);
    expect(instrument.zones).toHaveLength(13);
    expect(instrument.zones.every((z) => z.buffer.length > 0 && z.buffer.duration > 0)).toBe(true);
    expect(await cache.load(audio, 'vibes', samples)).toBe(instrument);
    expect(samples.calls).toEqual(['0110_FluidR3_GM_sf2_file.js']);
    // Another context decodes its own copy.
    const other = context();
    expect(cache.status(other, 'vibes')).toBe('idle');
    await cache.load(other, 'vibes', samples);
    expect(samples.calls).toHaveLength(2);
  });

  it('reports a failed load and retries it on the next load', async () => {
    const cache = new InstrumentCache(), audio = context(), seen: InstrumentStatus[] = [];
    const unsubscribe = cache.subscribe((ctx, key, status) => { if (ctx === audio && key === 'synthstrings') seen.push(status); });
    let fail = true;
    const samples = vendorSamples();
    const flaky = async (file: string) => {
      if (fail) { fail = false; throw new Error('offline'); }
      return samples(file);
    };
    await expect(cache.load(audio, 'synthstrings', flaky)).rejects.toThrow('offline');
    expect(cache.status(audio, 'synthstrings')).toBe('error');
    expect(cache.error(audio, 'synthstrings')).toBe('offline');
    expect(cache.get(audio, 'synthstrings')).toBeUndefined();
    await cache.load(audio, 'synthstrings', flaky);
    expect(cache.status(audio, 'synthstrings')).toBe('ready');
    expect(cache.error(audio, 'synthstrings')).toBeUndefined();
    expect(seen).toEqual(['loading', 'error', 'loading', 'ready']);
    unsubscribe();
    await cache.load(context(), 'synthstrings', samples);
    expect(seen).toHaveLength(4);
  });

  it('fails for an unknown key, no samples service, a bad file or undecodable audio', async () => {
    const cache = new InstrumentCache(), audio = context();
    await expect(cache.load(audio, 'chaos', vendorSamples())).rejects.toThrow(/Unknown instrument/);
    await expect(cache.load(audio, 'vibes', undefined)).rejects.toThrow(/samples service/);
    await expect(cache.load(audio, 'piano', async () => 'not a preset')).rejects.toThrow(SampleFileError);
    await expect(cache.load(audio, 'rhodes', async () => "zones:[{keyRangeLow:0,keyRangeHigh:127,file:'AAAAAAAA'}]")).rejects.toThrow();
    for (const key of ['chaos', 'vibes', 'piano', 'rhodes']) expect(cache.status(audio, key)).toBe('error');
  });

  it('keeps other listeners when one throws', async () => {
    const cache = new InstrumentCache(), audio = context(), seen: string[] = [];
    cache.subscribe(() => { throw new Error('broken widget'); });
    cache.subscribe((_ctx, _key, status) => seen.push(status));
    await cache.load(audio, 'synthstrings', vendorSamples());
    expect(seen).toEqual(['loading', 'ready']);
  });
});
