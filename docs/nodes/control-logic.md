# Control and logic

Routing, conversion and signal shaping: the glue between other families. All new code; nothing is borrowed from Flow. Each node lands in the first milestone that needs it, except Delay Edge, which is part of M1.

| Node | What it does | Milestone |
| --- | --- | --- |
| Gate | Passes events while Open is on and the Gate Signal, read at each event's time on its channel, is at or above Level (unwired: everything passes); Open off blocks everything. To pass at or below a level, negate the signal with Math (Multiply, Constant −1) and use a negative Level | M2 (Paint mode) |
| Switch / Select | Routes events to one of 4 outputs, chosen by the Index knob/cable or latched by the Select input (`value` picks the output, no value steps to the next), whichever changed last; a contact stays on the output its down picked | M2 (tool-mode examples) |
| Merge / Split Channels | Combines or separates per-pointer channels | As needed |
| Counter | Counts events; wraps at N; outputs count as a Signal | As needed |
| Random | Seeded random value per event, or a smooth random Signal | M3 (slow time) |
| Sample & Hold | Captures a Signal's value at each event (adapter: Event → Signal) | M1 (adapter offer) |
| Envelope | Event → ADSR Signal (adapter: Event → Signal) | As needed |
| LFO | Sine, triangle, saw, square or random; tempo-synced or free | M3 (slow time) |
| Ramp | Rises or falls between two values over a set number of bars or seconds (up to many minutes), started, restarted or reversed by Events; outputs a Signal and an Event at the end | M3 (slow time) |
| Scene | Chooses the patch's current scene: advances on an Event, after N bars, with a probability, or by weights from one scene to the next; outputs the scene as a Value and an Event on each change. Recalling a scene sets or morphs the knob values saved in it | M4 |
| Math / Map Range / Curve / Smooth | Arithmetic and shaping for Signals | M2 (mode patches) |
| Threshold / Change | Signal → Event when a level is crossed or a value changes (adapter: Signal → Event) | M1 (adapter offer) |
| Get Field | Pulls one payload field out of an event as a Signal | M2 (mode patches) |
| Delay Edge | Explicit fixed delay (10 ms to 2 s) that closes cycles | M1 |

## Rules for this family

- **Adapters.** Sample & Hold, Envelope, Threshold and Change are the adapters the editor offers when a cable joins incompatible types. M1 needs at least one adapter in each direction for that offer to work.
- **Delay Edge** is the only way, besides Field reads, to close a cycle ([ADR 0010](../decisions/0010-explicit-feedback.md)). Its delay is a fixed time, at least 10 ms, not "one window": the runtime keeps every query window no wider than the shortest delay in the patch, so a cycle gives the same events whatever the window size. The compiler treats it specially, so it gets compiler tests as well as node tests.
- **Merge / Split.** Most cables carry one channel, so the editor hides Merge / Split until a patch needs them ([ADR 0009](../decisions/0009-channels-from-day-one.md)).
- **Seeded randomness.** Random and LFO's random shape use the seeded RNG.
- **Smooth's Channels cap.** Smooth keeps a filter for channels 0 to Channels − 1 only; channels at or above Channels pass through unsmoothed. Live Pointer channels are raw pointerIds (a Chrome mouse is 1, and touch ids keep growing), so set Channels (at most 8) above the ids you expect until Pointer maps ids to small reused slots (#74).
