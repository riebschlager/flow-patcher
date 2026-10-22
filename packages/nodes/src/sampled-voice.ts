// Sampled Voice: Flow's WebAudioFont instruments as a node. Voice playback is
// extracted from AmbientAudio.note (../flow/public/music.js), zone playback is
// WebAudioFont's (instruments.ts), and each note's envelope and glide come from
// arpEnvelope and arpGlide (arpeggiator.ts). Changes from Flow:
// - Voices come from the runtime's pool (ADR 0011) instead of a count over
//   WebAudioFont's envelopes; a stolen voice fades over STEAL_FADE as Flow's did.
// - Every note gets the node's envelope (Flow's arp model, with the release
//   after the note) and its filter. Instruments with a tone sweep keep it,
//   scaled by the cutoff as Flow's gesture tone did; Q is the node's Q, not the
//   sweep's own.
// - No random level variation: Flow scaled each note by .85 + random × .15.
//   The audio setup has no seed to key a seeded draw on, so velocity and level
//   alone set the loudness.
// - A note that arrives while its instrument loads (or failed to) is skipped
//   and counted in `state.skippedNotes`, where Flow waited for the load and
//   played it late.
// - Glide comes from the previous note on the same channel, the latest one
//   scheduled at or before it that wasn't withdrawn.
import {
  isNoteEvent,
  type AudioBufferSourceNodeLike,
  type AudioNodeLike,
  type EngineEvent,
  type NodeDefinition,
  type NodeState,
  type VoiceHandle,
} from '@flow-patcher/engine';
import { arpEnvelope, arpGlide } from './arpeggiator';
import { findZone, instrumentCache, zonePlayback } from './instruments';
import { INSTRUMENT_KEYS, instrumentFor } from './music';

/** Seconds a stolen voice takes to fade before its source stops (Flow's 64-voice cut). */
export const STEAL_FADE = 0.05;

/** Notes this node skipped because its instrument wasn't loaded, as the editor reads them from the node's state. */
export const skippedNotes = (state: Readonly<NodeState> | undefined): number => {
  const n = state?.skippedNotes;
  return typeof n === 'number' ? n : 0;
};

interface Voice {
  source: AudioBufferSourceNodeLike;
  nodes: AudioNodeLike[];
  handle: VoiceHandle;
  channel: number;
  time: number;
  pitch: number;
}

/** When a voice is silent: its release end, or its steal plus the fade. */
const voiceEnd = (voice: Voice) => (voice.handle.stolen ? voice.handle.end + STEAL_FADE : voice.handle.end);

export const sampledVoice: NodeDefinition = {
  type: 'sampled-voice',
  version: 1,
  label: 'Sampled Voice',
  category: 'instruments',
  description: "One of Flow's 28 sampled instruments, with a per-note envelope, glide and filter.",
  ports: [
    { name: 'note', type: 'note', direction: 'in', label: 'Note' },
    { name: 'audio', type: 'audio', direction: 'out', label: 'Audio' },
  ],
  params: [
    { name: 'instrument', kind: 'enum', options: INSTRUMENT_KEYS, default: 'vibes', label: 'Instrument' },
    { name: 'attack', kind: 'number', min: 0, max: 2, default: 0.02, unit: 's', label: 'Attack' },
    { name: 'decay', kind: 'number', min: 0, max: 2, default: 0.12, unit: 's', label: 'Decay' },
    { name: 'sustain', kind: 'number', min: 0, max: 1, default: 0.65, label: 'Sustain' },
    { name: 'release', kind: 'number', min: 0, max: 8, default: 0.3, unit: 's', label: 'Release' },
    { name: 'glideTime', kind: 'number', min: 0, max: 2, default: 0.18, unit: 's', label: 'Glide time' },
    { name: 'glide', kind: 'number', min: 0, max: 1, default: 0, label: 'Glide' },
    { name: 'cutoff', kind: 'number', min: 80, max: 20000, default: 11000, unit: 'Hz', label: 'Cutoff' },
    { name: 'q', kind: 'number', min: 0.1, max: 20, default: 0.55, label: 'Q' },
    { name: 'level', kind: 'number', min: 0, max: 2, default: 1, label: 'Level' },
  ],
  audio({ audio, params, param, state, voices: pool, services }) {
    const out = audio.createGain();
    const key = params.instrument as string;
    // Start loading now so the first notes find it ready. A failure shows in the
    // cache's status; notes until then are skipped, and a rebuilt node retries.
    instrumentCache.load(audio, key, services.samples).catch(() => {});
    // Voices by the event that scheduled them, so cancel() can find them (ADR 0019).
    const voices = new Map<EngineEvent, Voice>();
    // Per channel, the notes scheduled recently, for glide.
    const history = new Map<number, Voice[]>();
    const skip = () => { state.skippedNotes = skippedNotes(state) + 1; };

    const previous = (channel: number, time: number): number | null => {
      const list = history.get(channel) ?? [];
      for (let k = list.length - 1; k >= 0; k--) if (list[k]!.time <= time) return list[k]!.pitch;
      return null;
    };
    const prune = () => {
      const now = audio.currentTime;
      for (const [event, voice] of voices) if (voiceEnd(voice) < now) voices.delete(event);
      // Keep each channel's latest note even once it has ended: the next note glides from it.
      for (const [channel, list] of history) history.set(channel, list.filter((v, k) => k === list.length - 1 || voiceEnd(v) >= now));
    };

    return {
      outputs: { audio: out },
      schedule(_port, events) {
        prune();
        for (const note of events) {
          if (!isNoteEvent(note) || !Number.isFinite(note.pitch) || !Number.isFinite(note.time)) continue;
          const instrument = instrumentFor(key), loaded = instrumentCache.get(audio, key);
          if (!instrument || !loaded) { skip(); continue; }
          const pitch = Math.max(0, Math.min(127, note.pitch)), t = note.time, ch = note.channel;
          const zone = findZone(loaded.zones, pitch);
          if (!zone) { skip(); continue; }
          const playback = zonePlayback(zone, pitch);

          // Per-note params, sampled at the note's start on its channel.
          const shapeConfig = {
            length: 100,
            attack: param('attack', t, ch) * 1000,
            decay: param('decay', t, ch) * 1000,
            sustain: param('sustain', t, ch) * 100,
            release: param('release', t, ch) * 1000,
            glideEnabled: true,
            glideTime: param('glideTime', t, ch) * 1000,
            glideAmount: param('glide', t, ch) * 100,
          };
          const shape = arpEnvelope(shapeConfig, note.duration), glide = arpGlide(shapeConfig, note.duration);
          const cutoff = param('cutoff', t, ch), q = param('q', t, ch);
          const velocity = Number.isFinite(note.velocity) ? Math.max(0, Math.min(1, note.velocity)) : 1;
          const level = instrument.gain * param('level', t, ch) * velocity;
          const start = Math.max(t, audio.currentTime);

          // Source → filter → envelope → fade → out. The fade gain is the pool's
          // steal: it stays at 1 until stop(at). Built before claim(), which may steal this voice at once.
          const source = audio.createBufferSource(), filter = audio.createBiquadFilter();
          const env = audio.createGain(), fade = audio.createGain();
          source.buffer = zone.buffer;
          source.loop = playback.loop;
          if (playback.loop) {
            source.loopStart = playback.loopStart;
            source.loopEnd = playback.loopEnd;
          }
          let lowestRate = playback.playbackRate;
          source.playbackRate.setValueAtTime(playback.playbackRate, start);
          const from = previous(ch, t);
          if (glide.enabled && from !== null && from !== pitch) {
            // Flow's pitchGlide: bend in semitone space from the previous pitch to this one, exponentially.
            const seconds = Math.max(0, Math.min(shape.duration, glide.time));
            const semitones = Math.max(-127, Math.min(127, from - pitch)) * glide.amount;
            const bent = playback.playbackRate * 2 ** (semitones / 12);
            source.playbackRate.setValueAtTime(bent, start);
            source.playbackRate.exponentialRampToValueAtTime(playback.playbackRate, start + seconds);
            lowestRate = Math.min(lowestRate, bent);
          }

          const tone = instrument.tone, limit = audio.sampleRate * 0.45;
          const hz = (v: number) => Math.max(80, Math.min(limit, v));
          filter.type = tone?.type ?? 'lowpass';
          if (tone) {
            const scale = Math.max(0.25, cutoff / 14000);
            filter.frequency.setValueAtTime(hz(tone.from * scale), start);
            filter.frequency.exponentialRampToValueAtTime(hz(tone.to * scale), start + Math.min(tone.time, shape.duration * 0.8));
          } else filter.frequency.setValueAtTime(hz(cutoff), start);
          filter.Q.setValueAtTime(q, start);

          // The envelope's stages, as WebAudioFont's setupEnvelope ramps them.
          env.gain.setValueAtTime(0, start);
          let at = start;
          for (const stage of shape.envelope) {
            if (stage.duration <= 0) continue;
            at += stage.duration;
            env.gain.linearRampToValueAtTime(level * stage.volume, at);
          }
          // An unlooped sample ends on its own; the voice ends with it.
          const end = playback.loop ? start + shape.duration : Math.min(start + shape.duration, start + zone.buffer.duration / lowestRate);

          source.connect(filter);
          filter.connect(env);
          env.connect(fade);
          fade.connect(out);
          source.start(start);
          const handle = pool.claim({
            start,
            end,
            stop(cut) {
              fade.gain.setValueAtTime(1, cut);
              fade.gain.setTargetAtTime(0, cut, STEAL_FADE / 5);
              source.stop(cut + STEAL_FADE);
            },
          });
          if (!handle.stolen) source.stop(end);
          const voice: Voice = { source, nodes: [source, filter, env, fade], handle, channel: ch, time: t, pitch };
          source.onended = () => { for (const node of voice.nodes) node.disconnect(); };
          voices.set(note, voice);
          const list = history.get(ch) ?? [];
          list.push(voice);
          history.set(ch, list);
        }
      },
      cancel(_port, events) {
        // A withdrawn note hasn't started: disconnecting keeps it silent, and its slot frees.
        for (const event of events) {
          const voice = voices.get(event);
          if (!voice) continue;
          for (const node of voice.nodes) node.disconnect();
          pool.release(voice.handle);
          voices.delete(event);
          const list = history.get(voice.channel);
          if (list) history.set(voice.channel, list.filter((v) => v !== voice));
        }
      },
      idleAt() {
        // The last voice's end, or its steal's fade: a removed or rebuilt node is disposed after it.
        let end = 0;
        for (const voice of voices.values()) end = Math.max(end, voiceEnd(voice));
        return end;
      },
      dispose() {
        for (const voice of voices.values()) {
          for (const node of voice.nodes) node.disconnect();
          pool.release(voice.handle);
        }
        voices.clear();
        history.clear();
        out.disconnect();
      },
    };
  },
};
