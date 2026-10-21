// Offline audio for headless runs and tests, on node-web-audio-api's native
// OfflineAudioContext (the same Web Audio API the browser has).
import { OfflineAudioContext } from 'node-web-audio-api';
import type { AudioContextLike } from '@flow-patcher/engine';

export const SAMPLE_RATE = 48000;

export interface RenderedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Builds a graph with `setup`, renders `seconds` of it and returns the samples. */
export async function renderOffline(
  seconds: number,
  setup: (context: AudioContextLike) => void,
  { channels = 2, sampleRate = SAMPLE_RATE } = {},
): Promise<RenderedAudio> {
  const context = new OfflineAudioContext(channels, Math.max(1, Math.round(seconds * sampleRate)), sampleRate);
  setup(context as unknown as AudioContextLike);
  const buffer = await context.startRendering();
  return {
    sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice()),
  };
}

export function peak(audio: RenderedAudio): number {
  let max = 0;
  for (const data of audio.channels) for (const v of data) max = Math.max(max, Math.abs(v));
  return max;
}

/** RMS per block of `blockSeconds`, averaged across channels, rounded to 1e-6. */
export function blockLoudness(audio: RenderedAudio, blockSeconds = 0.05): number[] {
  const size = Math.round(blockSeconds * audio.sampleRate), length = audio.channels[0]?.length ?? 0, out: number[] = [];
  for (let start = 0; start < length; start += size) {
    let sum = 0, count = 0;
    for (const data of audio.channels) for (let i = start; i < Math.min(length, start + size); i++, count++) sum += data[i]! * data[i]!;
    out.push(Math.round(Math.sqrt(sum / Math.max(1, count)) * 1e6) / 1e6);
  }
  return out;
}

/** Longest run of samples (in seconds) where every channel is below `threshold`. */
export function longestSilence(audio: RenderedAudio, threshold = 1e-4, from = 0, to = Infinity): number {
  const length = audio.channels[0]?.length ?? 0;
  const first = Math.max(0, Math.floor(from * audio.sampleRate)), last = Math.min(length, Math.ceil(to * audio.sampleRate));
  let run = 0, longest = 0;
  for (let i = first; i < last; i++) {
    run = audio.channels.every((data) => Math.abs(data[i]!) < threshold) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest / audio.sampleRate;
}

/** 16-bit PCM WAV. */
export function encodeWav(audio: RenderedAudio): Uint8Array {
  const channels = audio.channels.length, frames = audio.channels[0]?.length ?? 0, dataBytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const data of audio.channels) {
      const v = Math.max(-1, Math.min(1, data[i]!));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(view.buffer);
}
