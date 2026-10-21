# 0010 · Feedback needs a delay edge

Status: Accepted · 2026-10-21

## Decision
Cycles in the graph are allowed only through a delay edge: the Delay Edge node, or any Field → Signal read, which returns the previous frame's value. The graph compiler rejects a cycle without one at connect time, and the cable flashes red.

## Consequences
- The compiler marks delay edges in the sorted plan and checks every new cable for cycles.
- Fluid readers must never return the current frame's value.
- The fluid can feed back into the music safely, because that feedback always arrives one frame late.
