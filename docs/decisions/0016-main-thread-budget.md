# 0016 · Keep the main thread free while a patch plays

Status: Accepted · 2026-10-21

## Context
In the M0 spike, Flow's CPU fluid solver (about 8 ms a step) and colorizer ran on the main thread. A tap that arrived during a frame waited for them. That pushed the worst tap-to-sound over the 20 ms gate: 27.4 ms in desktop Chrome and 24.8 ms on the Surface. With the solver and colorizer in a Worker, the worst tap fell to 14.8 ms and 14.6 ms. See [spike-notes.md](../spike-notes.md).

## Decision
- No main-thread task longer than about 4 ms *(tune)* while a patch plays, so a pointerdown waits at most that long.
- Fluid work runs off the main thread. The GPU solver ([ADR 0003](0003-gpu-fluid-one-node.md)) does. Until it lands in M3, and as the fallback on weak devices, the CPU solver and its colorizer run in a Worker. The Worker hands back colored pixels in transferred buffers, and the main thread only draws them.
- Writers post their splats to the Worker. Readers get the previous step's values, as they already do on the GPU.

## Consequences
- With the CPU solver, visuals run at least one frame behind the fluid's input. On a slow device, the fluid steps less often than the display refreshes: about 30 fps on the Surface.
- The immediate-path checks run with the Fluid stepping and the Renderer drawing, not on an idle page.
