import { isNoteEvent, type EngineEvent, type GainNodeLike, type NodeDefinition, type OscillatorNodeLike } from '@flow-patcher/engine';

export const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

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
  audio({ audio, params, param }) {
    const out = audio.createGain();
    // Voices by the event that scheduled them, so a rewind can withdraw them (ADR 0019).
    // Audio handles stay here in the closure, out of the node's state.
    const voices = new Map<EngineEvent, { osc: OscillatorNodeLike; env: GainNodeLike; end: number }>();
    return {
      outputs: { audio: out },
      schedule(_port, events) {
        for (const [event, voice] of voices) if (voice.end < audio.currentTime) voices.delete(event);
        for (const note of events) {
          if (!isNoteEvent(note)) continue;
          // Envelope params are sampled once per note, at its start.
          const attack = param('attack', note.time, note.channel), release = param('release', note.time, note.channel);
          const level = param('level', note.time, note.channel);
          const start = note.time, hold = start + Math.max(note.duration, attack), end = hold + release;
          const osc = audio.createOscillator(), env = audio.createGain();
          osc.type = params.wave as string;
          osc.frequency.value = midiToHz(note.pitch);
          env.gain.setValueAtTime(0, start);
          env.gain.linearRampToValueAtTime(level * Math.max(0, Math.min(1, note.velocity)), start + attack);
          env.gain.setValueAtTime(level * Math.max(0, Math.min(1, note.velocity)), hold);
          env.gain.linearRampToValueAtTime(0, end);
          osc.connect(env);
          env.connect(out);
          osc.start(start);
          osc.stop(end);
          voices.set(note, { osc, env, end });
        }
      },
      cancel(_port, events) {
        // A withdrawn note hasn't started yet, so cutting it off keeps it silent.
        for (const event of events) {
          const voice = voices.get(event);
          if (!voice) continue;
          voice.env.disconnect();
          voice.osc.disconnect();
          voices.delete(event);
        }
      },
      dispose() {
        voices.clear();
        out.disconnect();
      },
    };
  },
};
