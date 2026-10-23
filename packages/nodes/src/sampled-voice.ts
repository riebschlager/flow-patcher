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
// - Glide comes from the previous note on the same channel: the one with the
//   latest time before the note's own (ties: the highest pitch) that
//   wasn't withdrawn. It depends only on the set of notes, never on the order
//   they were delivered in, so a rewind or swap that re-sends some notes glides the same
//   (ADR 0019). Notes at the same time on one channel (a chord) don't glide
//   from each other. A note's bend is fixed when it is scheduled: if the note
//   it glided from is withdrawn later and the note itself is kept, its bend
//   stays. Only notes scheduled afterwards see the change.
// - Glide survives a rebuild (a param change, ADR 0023): each instance
//   publishes its recent notes in `state.glide`, which the new instance reads.
import {
  isNoteEvent,
  STEAL_FADE,
  voiceEnd,
  type AudioBufferSourceNodeLike,
  type AudioNodeLike,
  type EngineEvent,
  type NodeDefinition,
  type NodeState,
  type NodeStatus,
  type VoiceHandle,
} from '@flow-patcher/engine';
import { arpEnvelope, arpGlide } from './arpeggiator';
import { findZone, instrumentCache, zonePlayback } from './instruments';
import { INSTRUMENT_KEYS, instrumentFor } from './music';

/** Notes this node skipped because its instrument wasn't loaded, as the editor reads them from the node's state. */
export const skippedNotes = (state: Readonly<NodeState> | undefined): number => {
  const n = state?.skippedNotes;
  return typeof n === 'number' ? n : 0;
};

/** A note's time and pitch, for glide: plain data, so it can live in `state`. */
type GlideNote = [time: number, pitch: number];

/**
 * `state.glide`: the notes each instance on this node could glide from, so a
 * rebuilt instance glides its first notes from the old instance's last ones.
 * `live[id][channel]` is an instance's recent notes (every note not yet over,
 * and its latest), rewritten whenever it schedules or withdraws a note, so a
 * withdrawn note leaves it straight away, whichever instance withdraws it.
 * `base[channel]` is the latest note of instances already disposed: their notes
 * are final, as the runtime disposes an instance only after its last note.
 */
interface GlideState {
  next: number;
  /** GlideNote per channel. Typed loosely: state is shared, so each entry is checked when read. */
  base: Record<string, unknown>;
  /** Per instance id, GlideNote[] per channel. */
  live: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isGlideNote = (v: unknown): v is GlideNote => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** The node's glide state, repaired if it is missing or malformed. */
function glideState(state: NodeState): GlideState {
  const g = state.glide;
  if (isRecord(g) && typeof g.next === 'number' && Number.isFinite(g.next) && isRecord(g.base) && isRecord(g.live)) return g as unknown as GlideState;
  const fresh: GlideState = { next: 0, base: {}, live: {} };
  state.glide = fresh as unknown as NodeState[string];
  return fresh;
}

/** The later of two glide candidates; on equal times the higher pitch, so the order they are looked at in never matters. */
const later = (a: GlideNote | null, b: GlideNote): GlideNote => (a && (a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])) ? a : b);


interface Voice {
  source: AudioBufferSourceNodeLike;
  nodes: AudioNodeLike[];
  handle: VoiceHandle;
  channel: number;
  time: number;
  pitch: number;
}

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
  status({ audio, params }): NodeStatus | null {
    const key = params.instrument as string;
    const name = (instrumentFor(key)?.name ?? key).toLowerCase();
    switch (instrumentCache.status(audio, key)) {
      case 'loading': return { kind: 'loading', message: `Loading ${name}` };
      case 'error': return { kind: 'error', message: `Couldn't load ${name}. Check your connection, then retry.`, action: 'Retry' };
      default: return null;
    }
  },
  retry({ audio, params, services }) {
    // A load already under way or done is returned as is, so this only retries a failed one.
    instrumentCache.load(audio, params.instrument as string, services.samples).catch(() => {});
  },
  watchStatus({ audio }, listener) {
    // Any instrument on this context: a param change can switch which one the node shows.
    return instrumentCache.subscribe((changed) => {
      if (changed === audio) listener();
    });
  },
  audio({ audio, params, param, state, voices: pool, services }) {
    const out = audio.createGain();
    const key = params.instrument as string;
    // Start loading now so the first notes find it ready. A failure shows in the
    // cache's status; notes until then are skipped, and a rebuilt node retries.
    instrumentCache.load(audio, key, services.samples).catch(() => {});
    // Voices by the event that scheduled them, so cancel() can find them (ADR 0019).
    const voices = new Map<EngineEvent, Voice>();
    // Per channel, this instance's recent notes in schedule order, for glide.
    const history = new Map<number, Voice[]>();
    // Once disposed, the instance never writes to the shared state again.
    let disposed = false;
    const glide = glideState(state), id = String(glide.next++);
    const skip = () => { state.skippedNotes = skippedNotes(state) + 1; };

    /** The pitch of the latest note before `time` on the channel, from this instance and every other on the node. */
    const previous = (channel: number, time: number): number | null => {
      let best: GlideNote | null = null;
      const consider = (note: GlideNote) => { if (note[0] < time) best = later(best, note); };
      // State from other instances is checked at every level: weird state gives no glide, never an exception.
      const base = glide.base[channel];
      if (isGlideNote(base)) consider(base);
      for (const [other, channels] of Object.entries(glide.live)) {
        if (other === id || !isRecord(channels)) continue;
        const notes = channels[channel];
        if (Array.isArray(notes)) for (const note of notes) if (isGlideNote(note)) consider(note);
      }
      for (const voice of history.get(channel) ?? []) consider([voice.time, voice.pitch]);
      return best === null ? null : (best as GlideNote)[1];
    };
    /** Writes this instance's recent notes into state.glide. */
    const publish = () => {
      if (disposed) return;
      const channels: Record<string, GlideNote[]> = {};
      for (const [channel, list] of history) if (list.length) channels[channel] = list.map((v) => [v.time, v.pitch]);
      glide.live[id] = channels;
    };
    const prune = () => {
      const now = audio.currentTime;
      for (const [event, voice] of voices) if (voiceEnd(voice) < now) voices.delete(event);
      // Notes still to come, or still sounding, can be the latest before a new note
      // (every new note is at or after now). Of the rest, only the latest in time can.
      for (const [channel, list] of history) {
        let latest: Voice | null = null;
        for (const v of list) if (v.time < now && (!latest || v.time >= latest.time)) latest = v;
        history.set(channel, list.filter((v) => v === latest || v.time >= now || voiceEnd(v) >= now));
      }
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
        publish();
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
        publish();
      },
      idleAt() {
        // The last voice's end, or its steal's fade: a removed or rebuilt node is disposed after it.
        let end = 0;
        for (const voice of voices.values()) end = Math.max(end, voiceEnd(voice));
        return end;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const voice of voices.values()) {
          for (const node of voice.nodes) node.disconnect();
          pool.release(voice.handle);
        }
        voices.clear();
        // This instance's notes are final now: fold its latest per channel into the base.
        for (const [channel, list] of history) {
          for (const v of list) {
            const base = glide.base[channel];
            glide.base[channel] = later(isGlideNote(base) ? base : null, [v.time, v.pitch]);
          }
        }
        delete glide.live[id];
        history.clear();
        out.disconnect();
      },
    };
  },
};
