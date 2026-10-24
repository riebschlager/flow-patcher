// The engine has no DOM lib, so it describes the slice of Web Audio it uses.
// A browser AudioContext, an OfflineAudioContext and node-web-audio-api all
// satisfy these structurally; the host passes one in.

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  /** `value` must be non-zero and share the current value's sign. */
  exponentialRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

/** Decoded sample data. The engine only passes it from decodeAudioData to a buffer source. */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  readonly playbackRate: AudioParamLike;
  loop: boolean;
  /** Seconds into the buffer. */
  loopStart: number;
  loopEnd: number;
  /** Starts at audio-clock time `when`, `offset` seconds into the buffer. */
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
  /** Called once playback has stopped. Typed loosely so the DOM's event handler fits. */
  onended: ((event: never) => unknown) | null;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  /** 'lowpass', 'highpass', 'bandpass', … as in Web Audio. */
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface StereoPannerNodeLike extends AudioNodeLike {
  /** −1 (left) to 1 (right), equal-power. */
  readonly pan: AudioParamLike;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

export interface WaveShaperNodeLike extends AudioNodeLike {
  curve: Float32Array | null;
  oversample: string;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  /** Seconds from the audio clock to the speakers, where the browser reports it (not OfflineAudioContext). */
  readonly outputLatency?: number;
  /** Seconds of processing latency, a lower bound when `outputLatency` is missing. */
  readonly baseLatency?: number;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createWaveShaper(): WaveShaperNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createStereoPanner(): StereoPannerNodeLike;
  /** Decodes an encoded file (MP3, Ogg, WAV, …). Rejects on data it can't decode. */
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}
