# Harmony and pitch

Chords, scales and turning events into notes. Design: "Node catalog".

| Node | What it does | Flow source | Milestone |
| --- | --- | --- | --- |
| Progression ★ | Parses chord strings (maj9, m9, dim7, sus2…); outputs the current chord as a Value, changing on the beat of its Transport input | `music.js`: `parseChord`, progressions | M1 |
| Scale | Root and mode; outputs a pitch set | `music.js` scale data | As needed |
| Chord Tone ★ | Maps a Signal (such as pointer x) to a chord tone across an octave range (Flow's horizontal pitch) | `music.js`: `pitchesForRange`, `pitchForPosition` | M1 |
| Arpeggio ★ | Up, down, up/down, outside-in or random-without-repeat, over a pool of 1–16 notes | `arpeggiator.js`: `arpNotes`, `patternOrder` | M3 |
| Transpose / Octave | Shifts pitch by a fixed amount or a Signal | New | As needed |
| Snap to Scale | Moves any pitch to the nearest note in a set | New | As needed |
| Make Note | Event + pitch + velocity + length → Note, every field modulatable | New | M1 |

## Rules for this family

- **Chords and scales are Values.** Progression and Scale output Values. Nodes that consume them read the current Value at each event's time.
- **Arpeggio state survives edits.** Arpeggio keeps its position per channel across hot-patch edits. Random-without-repeat uses the seeded RNG.
- **`arpEnvelope` and `arpGlide` go to Sampled Voice**, not Arpeggio ([instruments.md](instruments.md)).
- **Pitch is MIDI note numbers.** Pitches are numbers on Note events, so Transpose and Snap stay simple arithmetic.
