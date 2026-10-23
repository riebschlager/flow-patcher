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
- `draw(target)` reads that state and changes nothing. It is called once per frame, after the overlay's own frame(): the Overlays cable orders the plan, as the Writers cable does for Fluid.
- Palette, color and energy come in on cables or params, never from app state.

### The Renderer composes
- With nothing cabled into Overlays, the Renderer behaves as before: it hands on the fluid backend's buffer without copying it.
- With overlays cabled, it keeps a buffer of its own. Each frame it fills that buffer with the fluid picture, scaled up bilinearly by a whole-number factor (`overlayScale`). The factor keeps the buffer near 512 × 288 (OVERLAY_PIXELS) *(tune)*, which is 4× for M1's 128 × 72 grid. With no fluid picture the buffer is FLUID_BACKGROUND at 512 × 288.
- Each drawer then blends into the buffer in pure TS, using the shared rasterizer: `strokeEllipse` for now, antialiased and source-over. `rendererImage` returns that buffer.
- So live.ts draws overlays without knowing they exist, and the headless runner's PNGs include them.

### Sizes and reduced motion
- Drawers size things from the target's `min(width, height)`, so a bigger target draws the same picture, sharper.
- `HostServices.reducedMotion()` says whether the player asked for reduced motion. Every overlay then keeps its color and drops the motion it adds (ADR 0012). For Orbit Rings, the rings stay level instead of tilting with Angle. If the host doesn't give it, the answer is no.

## Consequences
- Overlay renders are byte-exact and golden-tested (golden/overlay-renders.json). The same pixels come out headless and live.
- Overlays draw at the composed resolution, not the screen's: about 512 × 288, stretched to the canvas. Lines are soft at full screen, and a canvas whose aspect isn't the grid's stretches them, as it already stretches the fluid. M3's WebGL Renderer can call the same drawers on a target at canvas resolution, or rasterize the same stroke descriptions itself.
- Composing costs main-thread time every frame overlays are cabled. On a desktop it measured about 1.9 ms for the 512 × 288 upscale and 0.7 ms for three rings. That fits ADR 0016's ~4 ms task budget, with little room to spare. The Surface needs checking, and OVERLAY_PIXELS is the knob.
- The editor's live host doesn't pass `reducedMotion` yet. It can once #72's live.ts changes land, from `matchMedia('(prefers-reduced-motion: reduce)')`.
- New overlays add stroke or fill primitives to render/overlay.ts as they need them, each with golden renders.
