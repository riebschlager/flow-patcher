import { ramp } from '../audio';
import { instruments, noteName } from '../flow/music.js';
import { instrumentKeys, loadInstrument, loadPlayer } from '../instruments';
import { menu } from '../menu';
import type { NodeType } from '../registry';
import { recordSunk, recordTap, stats } from '../stats';

const MAX_VOICES = 64;

/** Plays each note on one of Flow's WebAudioFont instruments, at the note's time. Loads the instrument when chosen. */
export const sampledVoice: NodeType = {
  type: 'sampled-voice',
  label: 'Sampled Voice',
  inputs: [{ name: 'in', label: 'Notes', type: 'note' }],
  outputs: [{ name: 'out', label: 'Out', type: 'audio' }],
  knobs: [
    menu('instrument', 'Instrument', instrumentKeys.map((k) => instruments[k].name)),
    { name: 'level', label: 'Level', min: 0, max: 2, default: 1 },
  ],
  create(ctx) {
    const out = new GainNode(ctx, { gain: 1 });
    let key = instrumentKeys[0];
    let preset: WebAudioFontPreset | null = null;
    let player: WebAudioFontPlayer | null = null;
    loadPlayer().then((p) => { player = p; }, (e) => console.error('[spike]', e));

    const choose = (k: typeof key) => {
      key = k;
      preset = null; // notes are dropped until the new instrument is ready, rather than played on the old one
      loadInstrument(ctx, k).then((loaded) => { if (key === k) preset = loaded; }, (e) => console.error('[spike]', e));
    };
    choose(key);

    return {
      outputs: { out },
      query(_t0, _t1, inputs) {
        for (const note of inputs.events('in')) {
          if (typeof note.pitch !== 'number') {
            console.log('[spike] event dropped: Sampled Voice needs notes with a pitch');
            continue;
          }
          if (!preset || !player) {
            console.log('[spike] note dropped: instrument still loading');
            continue;
          }
          let when = note.time;
          if (when < ctx.currentTime) {
            stats.late++;
            when = ctx.currentTime;
          }
          stealIfFull(player, ctx);
          const instrument = instruments[key] as { gain: number; duration?: number };
          const velocity = typeof note.velocity === 'number' ? note.velocity : 1;
          const envelope = player.queueWaveTable(ctx, out, preset, when, note.pitch, instrument.duration ?? 2.7, instrument.gain * velocity);
          // The player reuses envelopes per target, so a stolen one may come back: it's sounding again.
          if (envelope) envelope.performanceReleasing = false;
          stats.voices = player.envelopes.filter((e) => !e.performanceReleasing && e.when + e.duration > ctx.currentTime).length;
          stats.peakVoices = Math.max(stats.peakVoices, stats.voices);
          recordSunk(when);
          if (typeof note.inputAt === 'number') {
            const latency = (ctx.outputLatency || ctx.baseLatency) * 1000;
            recordTap(`${noteName(note.pitch)}  tap-to-sound ${((when - note.inputAt) * 1000).toFixed(1)} ms (gate ≤ 20), + output latency ${latency.toFixed(1)} ms${note.cold ? ' (cold start)' : ''}`);
          }
        }
      },
      set(knob, value) {
        if (knob === 'instrument' && instrumentKeys[value] !== key) choose(instrumentKeys[value]);
        if (knob === 'level') ramp(out.gain, value);
      },
      dispose() {
        // From AmbientAudio.releaseTarget in Flow: the shared player would otherwise keep this node's envelopes forever.
        if (player) {
          player.envelopes = player.envelopes.filter((e) => {
            if (e.target !== out) return true;
            try { e.audioBufferSourceNode?.stop(); } catch { /* already stopped */ }
            e.disconnect();
            return false;
          });
        }
        out.disconnect();
      },
    };
  },
};

/**
 * At 64 sounding voices, fade the oldest out quickly (from AmbientAudio.note in Flow).
 * A stolen voice is flagged so it isn't counted or stolen again while it fades.
 */
function stealIfFull(player: WebAudioFontPlayer, ctx: AudioContext) {
  const now = ctx.currentTime;
  const sounding = player.envelopes.filter((e) => !e.performanceReleasing && e.when + e.duration > now);
  if (sounding.length < MAX_VOICES) return;
  const oldest = sounding.reduce((a, b) => (b.when < a.when ? b : a));
  oldest.performanceReleasing = true;
  // Hold the current gain first, so cancelling a ramp mid-attack doesn't jump and click.
  if (oldest.gain.cancelAndHoldAtTime) oldest.gain.cancelAndHoldAtTime(now);
  else { oldest.gain.cancelScheduledValues(now); oldest.gain.setValueAtTime(oldest.gain.value, now); }
  oldest.gain.setTargetAtTime(0.00001, now, 0.01);
  oldest.audioBufferSourceNode?.stop(now + 0.05);
  oldest.when = now;
  oldest.duration = 0.05;
}
