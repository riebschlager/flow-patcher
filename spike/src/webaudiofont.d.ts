// The parts of Flow's vendored WebAudioFontPlayer (loaded as a script from /vendor) the spike uses.
type WebAudioFontZone = { buffer?: AudioBuffer; file?: string; ahdsr?: unknown };
type WebAudioFontPreset = { zones: WebAudioFontZone[] };
type WebAudioFontEnvelope = GainNode & {
  when: number;
  duration: number;
  /** The node this envelope plays into; the player reuses envelopes per target. */
  target: AudioNode;
  audioBufferSourceNode?: AudioBufferSourceNode | null;
  /** Set by the spike's voice stealing, as Flow does: this voice is fading out. */
  performanceReleasing?: boolean;
  cancel(): void;
};

declare class WebAudioFontPlayer {
  envelopes: WebAudioFontEnvelope[];
  adjustPreset(ctx: AudioContext, preset: WebAudioFontPreset): void;
  queueWaveTable(ctx: AudioContext, target: AudioNode, preset: WebAudioFontPreset, when: number, pitch: number, duration: number, volume: number): WebAudioFontEnvelope | null;
}

interface Window {
  WebAudioFontPlayer?: typeof WebAudioFontPlayer;
  [preset: `_tone_${string}`]: WebAudioFontPreset | undefined;
}
