# Visual: fluid, overlays and look

A fixed set of music-shaped building blocks around one fluid field, not a general shader graph ([ADR 0012](../decisions/0012-fixed-visual-vocabulary.md)). Design: "Visual system".

## Fluid

| Node | What it does | Flow source | Milestone |
| --- | --- | --- | --- |
| Fluid | Owns the solver; outputs a Field. Knobs: vorticity, dissipation (color persistence), viscosity, grid budget | `fluid.js`, `fluid-viewport.js`, ported to WebGL2 passes | M1 (CPU), M3 (GPU) |
| Splat | Writer: dye + impulse at a point, from any Event with x/y | `fluid.js` splat | M1 |
| Force | Writer: a continuous push following a Signal pair, or Hold's whirlpool or Orbit's twin whirlpools | `fluid.js` force and pulse, `performance.js` | M2 (mode patches) |
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
- **Force.** Inputs X, Y, Active and Spin (Signals); Write output. Each input is read once per tick; push mode's motion runs from the previous tick's sample.
  - Modes: `push` pushes along the X/Y pair's motion (Conduct; speed × 30, capped at 120, times Strength). `whirlpool` makes a vortex ringed by four inward pushes (Hold's charge: cable Charge into Strength). `twin` makes a vortex plus a smaller counter-turning one 0.8 × Radius to its right (Orbit). Spin's sign, else Direction, picks the vortex's turn.
  - It pushes on a fixed 50 ms grid of the frame clock, so the result doesn't depend on frame rate. The first tick, a contact that just landed, and a move of more than 0.25 within one tick give no push. Unwired X/Y means 0.5, and unwired Active means always on.
  - With a source that answers from its latest state, such as Pointer, every tick in one frame reads the same position. So when a frame holds several ticks (below 20 fps, or after a skipped frame), the first tick gets all the motion and the rest none: the impulse bunches up but isn't lost. At a frame rate that doesn't divide 50 ms, successive readings are a whole number of frames apart, so the push wobbles by about −3% to +11% tick to tick at 144 Hz (7 or 8 frames, 48.6 or 55.6 ms). Pure signals such as Clock's Phase are exact at every tick.
  - Changed from Flow:
    - 20 pushes a second on the fixed grid, where Flow gave about 15 a second at 60 Hz (at most one per 50 ms of wall clock, from the next frame).
    - No aspect factor on the horizontal push. Flow scaled it by the canvas aspect, so its horizontal pushes were about 1.78× stronger on a 16:9 canvas.
    - No energy term: Flow multiplied by the gesture's energy, and mode patches cable energy into Strength instead.
    - Paint's push (cos(heading) × energy × 65, radius 0.07) isn't a separate mode.
    - The whirlpool's and twin's offsets and secondary radii scale with Radius. They match Flow's Hold at Radius 0.12 and Flow's Orbit at 0.15; Conduct used 0.17. The default is 0.15.
    - Reduced motion is ignored. Flow skipped these pushes for touch, synthetic and pinch input under prefers-reduced-motion; the reduced-motion rule here covers overlays.
- **Overlays** ([ADR 0030](../decisions/0030-overlays-draw-into-the-renderer.md)). An overlay's Overlay output cables into the Renderer's Overlays input. The Renderer scales the fluid picture up to about 512 × 288 and each overlay blends into it in pure TS, so a run's picture is byte-exact. Golden renders cover the rasterizer and the Renderer's picture of Orbit Rings. While every overlay is idle (`visible()` false), the Renderer passes the fluid picture through uncomposed.
- **Orbit Rings.** Inputs Angle, X, Y and Active (Signals) and Color (a Value: `#rrggbb` or `[r, g, b]` in 0–1). Params Radius and Strength (both modulatable), Angle unit (radians, or turns for a 0–1 ramp such as Clock's Phase), and Palette and Dye, which give the color when no Color comes in. The rings fade in while Active is at least 0.5 (in 0.1 s) and fade out holding their last pose (0.18 s). Their tilt eases toward Angle the short way across ±π. Reduced motion keeps them level.
- **Separate drawing from state.** Flow's visual modules read Flow's app state directly. Borrowing them means separating the drawing code from that state, and taking palette and energy as inputs.
- **Reduced motion.** Every overlay obeys reduced-motion: it keeps color and drops added motion.
- **One Renderer** per patch, and one canvas ([ADR 0005](../decisions/0005-single-canvas.md)).
- **Golden renders.** Palette renders are byte-exact goldens generated in this repo.
