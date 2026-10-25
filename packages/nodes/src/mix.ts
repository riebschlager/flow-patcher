// Shared by the insert effects (Reverb, Delay): one Mix knob between the dry and the wet signal.

/** Dry and wet gains for a mix of 0–1, equal-power, so a half mix of uncorrelated signals doesn't dip. */
export function mixGains(mix: number): { dry: number; wet: number } {
  const m = Number.isFinite(mix) ? Math.max(0, Math.min(1, mix)) : 0;
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) };
}
