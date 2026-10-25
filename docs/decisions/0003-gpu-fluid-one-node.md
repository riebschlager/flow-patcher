# 0003 · GPU fluid, one Fluid node per patch

Status: Accepted · 2026-10-21 · Amended by [0036](0036-refocus-after-m2.md) (GPU solver parked)

## Context
Flow's fluid solver runs on the CPU, at about 8 ms per step at 35,000 cells. Flow Patcher also needs the main thread for the editor and the scheduler.

## Decision
- The solver runs on the GPU as WebGL2 shader passes, sharing a context with the display.
- Flow's CPU solver stays as the test reference and as the fallback on weak devices.
- A patch has at most one Fluid node. The GPU simulation layer is shared rather than Fluid-specific, so later field nodes (e.g. particles) can sit beside it.
- Readers (Probe, Region Stats, Density Onset) use async readback one frame late, so they never stall the frame.

## Consequences
- GPU output isn't bit-exact across machines. Test it against the CPU reference within a tolerance. Only the CPU solver has bit-exact golden frames.
- The graph compiler rejects a second Fluid node.
- Grid budget: 35,000 cells on desktop, 16,128 on mobile.
