# Effects and mix

Audio → Audio, ending at the single Output. Design: "Node catalog".

| Node | What it does | Flow source | Milestone |
| --- | --- | --- | --- |
| Reverb ★ | Convolution with the generated impulse | *Locate* (impulse generator in Flow's audio code) | M2 (Space and Orbit modes) |
| Delay ★ | Tempo-synced filtered feedback delay, divisions from 1/64 to two bars; feedback capped at 0.42 | `timing.js` (divisions); *locate* the delay chain | M2 (Space and Orbit modes) |
| Filter | Low-pass, high-pass or band-pass; cutoff (log-scaled, 20 Hz–20 kHz) and Q modulatable | New | M2 (Conduct mode) |
| Pan / Gain / Mixer | Basic routing and levels | New | M2 (Conduct and Orbit modes) |
| Output ★ | Limiter (unity gain below −9 dBFS), soft-knee peak guard, master level. Always exactly one per patch | `output.js`, adapted (see Reuse from Flow) | M1 |

## Rules for this family

- **Output is special.** Every patch has exactly one Output, and it can't be deleted. It enforces the peak guard and limiter whatever reaches it ([ADR 0011](../decisions/0011-runtime-safety-limits.md)). The graph compiler rejects a patch with zero or two Outputs.
- **Delay feedback is capped at 0.42** in the node, even when the knob is modulated past it.
- **Modulation.** Modulatable params ramp, never jump, so live edits don't click: a cabled param follows its Signal in `automate` (`paramAutomation`), a knob edit ramps in place through `liveParams` and `update` (`editRamp`) ([ADR 0031](../decisions/0031-audio-automation-and-in-place-edits.md)).
- **Frequencies and times are log-scaled.** Filter's cutoff, and Delay's time and Reverb's params when they land (#81), set `scale: 'log'`: the knob gives every octave the same travel, and a cable's depth into the param is in octaves, value = base × 2^(Σ depth × signal), clamped to the range. Depth 1 on a 0–1 Signal sweeps one octave up from the knob; 3.17 sweeps 300 Hz to 2.7 kHz. Ramps between grid points and knob edits stay linear in Hz ([ADR 0032](../decisions/0032-log-knobs-depth-in-octaves.md)).
- **Audio is the exception to "no cycles".** Audio cables don't carry events, so audio feedback loops go through Web Audio's own delay handling. Don't route them through the event cycle checker.
