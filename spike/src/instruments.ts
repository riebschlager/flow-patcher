import { instruments, softEnvelope } from './flow/music.js';

// Loads Flow's WebAudioFont player and instrument presets on demand, once per page.
// Adapted from AmbientAudio.load in ../flow/public/music.js; files are served from ../flow (see vite.config.ts).

export type InstrumentKey = keyof typeof instruments;
export const instrumentKeys = Object.keys(instruments) as InstrumentKey[];

let player: Promise<WebAudioFontPlayer> | null = null;
const presets = new Map<InstrumentKey, Promise<WebAudioFontPreset>>();

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.append(script);
  });

export function loadPlayer() {
  player ??= loadScript('/vendor/WebAudioFontPlayer.js').then(() => {
    if (!window.WebAudioFontPlayer) throw new Error('WebAudioFontPlayer missing: is ../flow checked out next to this repo? (see spike/vite.config.ts)');
    return new window.WebAudioFontPlayer();
  });
  player.catch(() => { player = null; }); // let a later attempt retry
  return player;
}

export function loadInstrument(ctx: AudioContext, key: InstrumentKey) {
  let preset = presets.get(key);
  if (!preset) {
    preset = (async () => {
      const p = await loadPlayer();
      const { file, attack } = instruments[key] as { file: string; attack?: number };
      const variable = `_tone_${file}_FluidR3_GM_sf2_file` as const;
      if (!window[variable]) await loadScript(`/vendor/${file}_FluidR3_GM_sf2_file.js`);
      const preset = window[variable];
      if (!preset) throw new Error(`Instrument ${file} missing from /vendor`);
      await Promise.all(preset.zones.map(async (zone) => {
        if (!zone.buffer && zone.file) {
          const data = Uint8Array.from(atob(zone.file), (c) => c.charCodeAt(0));
          zone.buffer = await ctx.decodeAudioData(data.buffer);
        }
      }));
      p.adjustPreset(ctx, preset);
      if (attack) for (const zone of preset.zones) zone.ahdsr = softEnvelope(instruments[key]);
      return preset;
    })();
    preset.catch(() => presets.delete(key)); // let a later attempt retry
    presets.set(key, preset);
  }
  return preset;
}
