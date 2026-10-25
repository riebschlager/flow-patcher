# Instruments

Note → Audio. Design: "Node catalog" and "Reuse from Flow".

| Node | What it does | Flow source | Milestone |
| --- | --- | --- | --- |
| Sampled Voice ★ | Any of Flow's 28 WebAudioFont instruments, with per-note envelope, glide and filter (cutoff log-scaled, [ADR 0032](../decisions/0032-log-knobs-depth-in-octaves.md)) | `AmbientAudio` (voice playback, lazy loading), `arpeggiator.js` (`arpEnvelope`, `arpGlide`), `music.js` instrument table, `vendor/` samples | M1 |
| Drum Voice ★ | Any of the 20 synthesized percussion voices, including the tuned objects | `PercussionSynth` (light wrapper) | M5 |
| Atmosphere ★ | The five seeded environment beds (rain, shore, wind, night, hearth) | `environment.js` (light wrapper) | M3 (drones) |
| Simple Synth | Oscillator + filter + envelope, for sounds Flow never had | New | As needed |
| Drone | A sustained source: several detuned oscillators with slow built-in drift, pitch from a Note or a Value, every main param modulatable (may extend Simple Synth instead; decided in its issue) | New | M3 (drones) |
| Granular | Grain clouds from a sampled instrument: position, density, grain size, pitch spray and pan spray, all modulatable, within the voice pool | New | M5 |

## Rules for this family

- **Shared instrument cache.** Sampled Voice loads instruments lazily into a cache shared by every Sampled Voice in the patch. Patches reference instruments by name and never embed samples. While an instrument loads, the node shows "loading" inline.
- **Extract only voice playback from `AmbientAudio`.** It mixes app-level state with voice playback; bring over the playback part only.
- **Voice pool.** Voices come from the runtime's 64-voice pool, oldest stolen first ([ADR 0011](../decisions/0011-runtime-safety-limits.md)). Instruments don't keep their own voice limits.
- **Seeded beds.** Atmosphere beds are seeded from the patch seed.
- **Cancel what you schedule.** An instrument whose `audio()` returns `schedule()` must also return `cancel(port, events)`, which withdraws the given events (the same objects it was handed) before they sound. A live event that rewinds a node replaces events already scheduled ([ADR 0019](../decisions/0019-live-events-rewind.md)); without `cancel()` they still play, and the runtime warns.
- **Audio out.** Outputs are Audio ports. Instruments never connect to the destination directly; everything reaches the speakers through Output.
- **Vendored samples.** WebAudioFont and FluidR3 samples keep their notices in `vendor/` ([ADR 0002](../decisions/0002-license-gpl-3.0.md)).
