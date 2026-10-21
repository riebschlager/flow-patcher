# Time and rhythm

Event generators and event transformers. Design: "Timing and evaluation" and "Node catalog".

| Node | What it does | Flow source | Milestone |
| --- | --- | --- | --- |
| Clock | BPM, swing and a rate multiplier; emits ticks at a chosen division and a Phase signal | New | M1 |
| Euclidean ★ | Hits and steps knobs, Rotate; outputs hits on clock ticks | `rhythm.js`: `euclidean`, `rotatePattern` | M1 |
| Step Sequencer ★ | 16-step grid with off/ghost/hit/accent velocities (Flow's beat studio lane) | `rhythm.js`: grooves, kits, `varyPattern` | M3 |
| Probability ★ | Passes each event with chance p, from a separate seeded random stream | *Locate* (likely `ArpEngine` / `RhythmEngine`) | M1 |
| Quantize ★ | Delays events to the next grid line (quarter to 1/32, triplets) | `quantize.js` | M3 |
| Delay / Repeat | Shifts events in time; Repeat makes echo trains with decay | New | As needed |
| Humanize ★ | Timing and velocity jitter | *Locate* (likely `RhythmEngine`) | M3 |
| Divide / Every N | Passes every Nth event, with an offset | New | As needed |
| Burst | Turns one event into N events spread over a time span | New | As needed |

## Rules for this family

- **Absolute time.** Generators compute their events from absolute time, never from "events since I started". Querying 0–10 s in one call or in 25 ms steps must give identical events, and every node here gets that test.
- **Borrow the pure functions, not the engines.** Flow's `ArpEngine` and `RhythmEngine` own `setInterval` timers and schedule in one loop. Take the pure functions they use and rebuild the behavior as `query()` nodes ([ADR 0008](../decisions/0008-one-clock-window-queries.md)).
- **Seeded randomness.** Each random node (Probability, Humanize) uses its own seeded stream, derived from the patch seed and the node id. Other nodes can't shift its sequence.
- **Events that land in a later window.** Delay, Repeat, Quantize and Burst can produce events beyond `t1`. Each must emit them in the window that contains their time, and the result must still be window-independent.
