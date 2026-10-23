# Visual: fluid, overlays and look

A fixed set of music-shaped building blocks around one fluid field, not a general shader graph ([ADR 0012](../decisions/0012-fixed-visual-vocabulary.md)). Design: "Visual system".

## Fluid

| Node | What it does | Flow source | Milestone |
| --- | --- | --- | --- |
| Fluid | Owns the solver; outputs a Field. Knobs: vorticity, dissipation (color persistence), viscosity, grid budget | `fluid.js`, `fluid-viewport.js`, ported to WebGL2 passes | M1 (CPU), M3 (GPU) |
| Splat | Writer: dye + impulse at a point, from any Event with x/y | `fluid.js` splat | M1 |
| Force | Writer: a continuous push following a Signal pair | `fluid.js` force | M2 (mode patches) |
| Stir ★ | Writer: Flow's percussion roll, sweep and eddy impulses | `percussion-visuals.js` | M3 |
| Clear / Fade | Writer: clears or fades the field | New | As needed |
| Probe | Reader: density, speed and curl at a point, as Signals | `fluid.js` probe | As needed |
| Region Stats | Reader: average density or motion over a zone | New | As needed |
| Density Onset | Reader: fires an Event when local density crosses a threshold | New | As needed |

- **One Fluid node per patch.** The GPU simulation layer is shared, so later field nodes can sit beside it ([ADR 0003](../decisions/0003-gpu-fluid-one-node.md)).
- **Solver.** Semi-Lagrangian advection, 20 Gauss-Seidel pressure iterations, vorticity confinement, and an aspect-following grid capped at 35,000 cells on desktop and 16,128 on mobile.
- **Readers return the previous frame.** On the GPU they use async readback one frame late. On the CPU solver, which runs in a Worker, the engine latches the last finished step's values at each frame, so a read returns the previous frame's latched values ([ADR 0016](../decisions/0016-main-thread-budget.md)). That delay is what makes Field → Signal feedback legal ([ADR 0010](../decisions/0010-explicit-feedback.md)).
- **Testing.** The CPU solver has bit-exact golden frames. The GPU solver is tested against the CPU solver within a tolerance.

## Overlay and look

| Node | What it draws | Flow source | Milestone |
| --- | --- | --- | --- |
| Ripple ★ | Expanding rings at an event's position; size and life from velocity and duration | *Locate* (likely `visible-sound.js`) | M3 |
| Droplet ★ | A falling drop that lands at the event's time (pairs with Quantize) | *Locate* | M3 |
| Halo ★ | Envelope-shaped glow tied to a note's sound | `visible-sound.js` | M3 |
| Motes ★ | Particles carried by the fluid's velocity | `visible-sound.js` | M3 |
| Trace | A line following a pointer channel, with persistence | New | As needed |
| Orbit Rings ★ | Flow's rotating ellipses, driven by an Angle signal | `orbit-rings.js` | M2 (Orbit mode) |
| Text ★ | Dye lettering (Flow's title card) | `dye-text.js` | M3 |
| Palette ★ | Four-color palette as a Value; also an Index → Color node for color-by-channel or color-by-voice | `palettes.js` | M3 |
| Lighting ★ | Chord atmosphere: color cast, light direction and energy, from a chord Value | `chord-atmosphere.js` | M3 |
| Renderer ★ | WebGL2 display with bloom, refraction and grain, falling back to Canvas2D. One per patch | `fluid-renderer.js`, `gpu-fluid-renderer.js`, `water-surface.js` | M1 (basic), M3 (full) |

## Rules for this family

- **Frame clock.** Visual nodes implement `frame()`. Each frame they read the events whose timestamps fell in the frame interval, so a Ripple fed by a note appears as the note sounds, even though it was scheduled 120 ms earlier.
- **Writers and readers.** A writer's Write output returns a `FluidWriter` from `field()`; Fluid calls its `write(target)` once a frame, before stepping. Readers get Fluid's `FluidField`, whose `image()` is the step latched at the frame's start. The contract is in `packages/engine/src/fluid/field.ts`.
- **Separate drawing from state.** Flow's visual modules read Flow's app state directly. Borrowing them means separating the drawing code from that state, and taking palette and energy as inputs.
- **Reduced motion.** Every overlay obeys reduced-motion: it keeps color and drops added motion.
- **One Renderer** per patch, and one canvas ([ADR 0005](../decisions/0005-single-canvas.md)).
- **Golden renders.** Palette renders are byte-exact goldens generated in this repo.
