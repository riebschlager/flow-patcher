# 0034 · The Transport cable carries the tempo with the beat

Status: Accepted · 2026-10-25 · Amends [0018](0018-transport-on-a-cable.md)

## Context
ADR 0018 has Clock's Transport output give the beat position as a number. Delay (#81) syncs its time to the tempo: a division in seconds is its length in beats divided by beats per second. Reading the tempo back from the beat would be inexact. The beat is piecewise linear, so differencing two reads blends the old and new tempo across a change, and a modulated tempo changes at every tick (0021).

## Decision
- The Transport Value is a **transport reading** (`TransportReading`, transport.ts), produced by `readTransport(transport, t)`. It holds the beat at t, plus the tempo of the anchor in effect at t: `beatsPerSecond`, `stepBeats`, `swing`, and `since`, when that tempo took effect. Reads before a change keep the old tempo, as the beat already does.
- Readers don't take the object apart themselves. `transportBeat(ctx, port, t)` gives the beat, and `transportTempo(ctx, port, t)` gives the tempo and `since`, or null with no cable. `transportBeat` also accepts a bare number, so a source that sends only the beat still works.
- Before a Clock's first query there is no transport, and it sends 0. `transportBeat` reads that as beat 0, and `transportTempo` reads it as null.

## Consequences
- Everything else in 0018 holds: an ordinary Value cable, one Clock per reader, beat 0 and the hint when unwired.
- Probes show the reading as "beat n" with its fields. Event logs and goldens don't change, because no event carries the Value itself.
- A node that read the Transport Value as a number now gets an object. Every reader in the repo goes through `transportBeat`.
