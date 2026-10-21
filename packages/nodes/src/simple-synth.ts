import { isNoteEvent, type NodeDefinition } from '@flow-patcher/engine';

export const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);

export const simpleSynth: NodeDefinition = {
  type: 'simple-synth',
  version: 1,
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
  audio({ audio, params }) {
    const out = audio.createGain();
    const attack = params.attack as number, release = params.release as number, level = params.level as number;
    return {
      outputs: { audio: out },
      schedule(_port, events) {
        for (const note of events) {
          if (!isNoteEvent(note)) continue;
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
        }
      },
      dispose() {
        out.disconnect();
      },
    };
  },
};
