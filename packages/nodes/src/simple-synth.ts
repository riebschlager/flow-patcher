import { isNoteEvent, type AudioNodeLike, type EngineEvent, type NodeDefinition, type VoiceHandle } from '@flow-patcher/engine';
import { STEAL_FADE } from './sampled-voice';

export const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

interface Voice {
  nodes: AudioNodeLike[];
  handle: VoiceHandle;
}

/** When a voice is silent: its release end, or its steal plus the fade. */
const voiceEnd = (voice: Voice) => (voice.handle.stolen ? voice.handle.end + STEAL_FADE : voice.handle.end);

export const simpleSynth: NodeDefinition = {
  type: 'simple-synth',
  version: 2,
  label: 'Simple Synth',
  category: 'instruments',
  description: 'One oscillator per note with an attack/release envelope.',
  ports: [
    { name: 'note', type: 'note', direction: 'in', label: 'Note' },
    { name: 'audio', type: 'audio', direction: 'out', label: 'Audio' },
  ],
  params: [
    { name: 'wave', kind: 'enum', options: ['sine', 'triangle', 'sawtooth', 'square'], default: 'triangle', label: 'Wave' },
    { name: 'attack', kind: 'number', min: 0.001, max: 2, default: 0.005, unit: 's', label: 'Attack' },
    { name: 'release', kind: 'number', min: 0.01, max: 4, default: 0.3, unit: 's', label: 'Release' },
    { name: 'level', kind: 'number', min: 0, max: 1, default: 0.3, label: 'Level' },
  ],
  audio({ audio, params, param, voices: pool }) {
    const out = audio.createGain();
    // Voices by the event that scheduled them, so a rewind can withdraw them (ADR 0019).
    // Audio handles stay here in the closure, out of the node's state. Each one
    // holds a slot in the runtime's voice pool (ADR 0011, 0024).
    const voices = new Map<EngineEvent, Voice>();
    return {
      outputs: { audio: out },
      schedule(_port, events) {
        for (const [event, voice] of voices) if (voiceEnd(voice) < audio.currentTime) voices.delete(event);
        for (const note of events) {
          if (!isNoteEvent(note) || !Number.isFinite(note.time) || !Number.isFinite(note.pitch)) continue;
          // Envelope params are sampled once per note, at its start.
          const attack = param('attack', note.time, note.channel), release = param('release', note.time, note.channel);
          const velocity = Number.isFinite(note.velocity) ? Math.max(0, Math.min(1, note.velocity)) : 1;
          const peak = param('level', note.time, note.channel) * velocity;
          const duration = Number.isFinite(note.duration) ? note.duration : 0;
          const start = note.time, hold = start + Math.max(duration, attack), end = hold + release;
          // Oscillator → envelope → fade → out. The fade gain is the pool's steal: it
          // stays at 1 until stop(at), so the envelope's ramps stay intact. Everything
          // is built and started before claim(), which may steal this voice at once.
          const osc = audio.createOscillator(), env = audio.createGain(), fade = audio.createGain();
          osc.type = params.wave as string;
          osc.frequency.value = midiToHz(note.pitch);
          env.gain.setValueAtTime(0, start);
          env.gain.linearRampToValueAtTime(peak, start + attack);
          env.gain.setValueAtTime(peak, hold);
          env.gain.linearRampToValueAtTime(0, end);
          osc.connect(env);
          env.connect(fade);
          fade.connect(out);
          osc.start(start);
          const handle = pool.claim({
            // A note scheduled late sounds from now, so that is where its voice starts.
            start: Math.max(start, audio.currentTime),
            end,
            stop(cut) {
              fade.gain.setValueAtTime(1, cut);
              fade.gain.setTargetAtTime(0, cut, STEAL_FADE / 5);
              osc.stop(cut + STEAL_FADE);
            },
          });
          if (!handle.stolen) osc.stop(end);
          voices.set(note, { nodes: [osc, env, fade], handle });
        }
      },
      cancel(_port, events) {
        // A withdrawn note hasn't started yet, so cutting it off keeps it silent, and its slot frees.
        for (const event of events) {
          const voice = voices.get(event);
          if (!voice) continue;
          for (const node of voice.nodes) node.disconnect();
          pool.release(voice.handle);
          voices.delete(event);
        }
      },
      idleAt() {
        // When the last note's release, or its steal's fade, ends; a removed or rebuilt synth is disposed after it.
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
        out.disconnect();
      },
    };
  },
};
