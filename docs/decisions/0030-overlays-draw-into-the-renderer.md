# 0030 · Overlays draw into the Renderer's picture, in pure TS

Status: Proposed · 2026-10-23

## Context
Orbit Rings is the first overlay: a picture drawn over the fluid rather than written into it. Ripple, Droplet, Halo, Motes, Trace and Text follow in M3 (ADR 0012). There's no contract for how an overlay reaches the canvas. Three things constrain it:
- Headless runs must stay byte-exact: the same patch, seed and frames give the same picture, so overlays can have golden renders like the fluid's.
- The engine has no DOM (ADR 0013), and Canvas2D output isn't the same from one browser to the next.
- The editor's live host already draws the Renderer's picture each frame (`rendererImage`, packages/editor/src/live.ts). Overlays should need no change there.

## Decision

### An Overlay field kind
- Field ports gain a third kind, `fieldKind: 'overlay'`. An overlay node's **Overlay** output returns an `OverlayDrawer` (`{ kind: 'overlay', draw(target) }`) from `field()`. The contract is in packages/engine/src/render/overlay.ts.
- The Renderer gains an **Overlays** input of that kind. It takes many cables, and later cables draw on top.
- The compiler's field-kind check keeps an Overlay output out of Fluid's Writers and the Renderer's Field.

### State apart from drawing
- An overlay is a visual node with a `frame()` and no `query()`. Its `frame()` updates its state from its inputs on the frame clock.
- `draw(target)` reads that state and changes nothing. It is called at most once per frame, after the overlay's own frame(): the Overlays cable orders the plan, as the Writers cable does for Fluid.
- An optional `visible()` says whether `draw` would change anything now. Orbit Rings answer false while faded out. A drawer without it counts as always visible.
- Palette, color and energy come in on cables or params, never from app state.

### The Renderer composes
- With nothing cabled into Overlays, or while every cabled overlay is idle (`visible()` false), the Renderer behaves as before: it hands on the fluid backend's buffer without copying it, and composes nothing.
- While any overlay is visible, it keeps a buffer of its own. Each frame it fills that buffer with the fluid picture, scaled up bilinearly by a whole-number factor (`overlayScale`). The factor keeps the buffer near 512 × 288 (OVERLAY_PIXELS) *(tune)*, which is 4× for M1's 128 × 72 grid. With no fluid picture the buffer is FLUID_BACKGROUND at 512 × 288.
- Each visible drawer then blends into the buffer in pure TS, using the shared rasterizer: `strokeEllipse` for now, antialiased and source-over. `rendererImage` returns that buffer.
- So live.ts draws overlays without knowing they exist, and the headless runner's PNGs include them.

### Sizes and reduced motion
- Drawers size things from the target's `min(width, height)`, so a bigger target draws the same picture, sharper.
- `HostServices.reducedMotion()` says whether the player asked for reduced motion. Every overlay then keeps its color and drops the motion it adds (ADR 0012). For Orbit Rings, the rings stay level instead of tilting with Angle. If the host doesn't give it, the answer is no.

## Consequences
- A run's picture with overlays is byte-exact: the same pixels come out headless and live. Two goldens cover it:
  - golden/overlay-renders.json covers the rasterizer and the upscale on fixed strokes;
  - golden/orbit-rings-renders.json covers the Renderer's picture of examples/orbit-rings.flowpatch after 30 and 90 frames (also with reduced motion), and fixed ring states at two sizes. A change to the ring geometry fails it.
- The picture changes size when the first overlay shows or the last one hides: about 512 × 288 while composing, the fluid grid while passing through. live.ts already resizes its offscreen canvas to match.
- Overlays draw at the composed resolution, not the screen's: about 512 × 288, stretched to the canvas. Lines are soft at full screen, and a canvas whose aspect isn't the grid's stretches them, as it already stretches the fluid. M3's WebGL Renderer can call the same drawers on a target at canvas resolution, or rasterize the same stroke descriptions itself.
- Composing costs main-thread time on every frame an overlay is visible, and none while all are idle. Measured on 2026-10-23 in headless Chromium on a desktop Mac, over 480 frames of a patch where Clock drives Orbit Rings over a fixed 128 × 72 fluid picture. The timed task was the whole frame as live.ts runs it: `Runtime.frame`, then `new ImageData`, `putImageData` and `drawImage` to a 1440 × 810 canvas.
  - Rings visible: median 2.2 ms, p95 2.5 ms. Of that, `Runtime.frame` was 2.1 ms (the 512 × 288 upscale is most of it, and three rings are about 0.2 ms), `ImageData` with `putImageData` 0.1–0.2 ms, and `drawImage` under 0.1 ms.
  - Rings idle, or no overlays: about 0.1 ms, the same as a patch without overlays.
  - Headless Chromium's software `drawImage` occasionally stalled for 1–16 s, with or without overlays. Those are left out as an artifact of the harness.
  - So a visible overlay takes about half of ADR 0016's ~4 ms task budget. The Surface and phones need checking on device, and OVERLAY_PIXELS *(tune)* is the knob: 3× instead of 4× roughly halves the upscale. A GPU-backed `drawImage` in a headed browser returns sooner than measured here, not later.
- The editor's live host doesn't pass `reducedMotion` yet. It can once #72's live.ts changes land, from `matchMedia('(prefers-reduced-motion: reduce)')`.
- New overlays add stroke or fill primitives to render/overlay.ts as they need them, each with golden renders.
