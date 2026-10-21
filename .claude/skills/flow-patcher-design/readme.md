# Flow Patcher Design System

Visual language for Flow Patcher, a browser node editor for sound, music and visuals (source: `uploads/design.md`, Oct 20 2026). Dark, quiet chrome; color reserved for data. Live spec: `Flow Patcher Design System.dc.html`.

## Principles
1. **Color means data type.** Only ports and cables are saturated. Nodes, panels and chrome stay neutral, so the eye reads the signal flow first.
2. **Shape backs up color.** Every port type has a distinct shape and cable stroke, so the graph reads in grayscale and for color-blind users.
3. **Activity is visible.** Cables flash on events, glow with level; LEDs on node headers; any port can be probed.
4. **Every number is a knob.** Same interaction everywhere: drag, Shift for fine, double-click to type, right-click to reset, cable in to modulate.
5. **Quiet until touched.** Secondary controls (menus, mod ports, probe buttons) appear on hover/selection, never as permanent clutter.

## Visual foundations
- **Color:** cool graphite neutrals `--fp-bg-0…4`, lines `--fp-line-1…3`, text `--fp-fg-1…4`. Port types at equal lightness (oklch L≈0.8): Event amber, Note rose, Signal cyan, Audio green, Field violet, Value bone. `-soft` variants for tinted fills. Error red, warn orange, selection = near-white (never a hue, so it never collides with a type).
- **Type:** Geist (UI) + Geist Mono (values, units, ids, timestamps). Tight scale 10–15px in the editor; 20px+ only for panels/docs. Values are always mono and tabular so they don't jitter while changing.
- **Spacing:** 2/4/6/8/12/16/24/32/48. Canvas snaps to 20px; nodes are multiples of 20 wide (default 184 + border). Port row 22px, param row 26px, header 30px.
- **Radii:** 2 ports · 4 fields/chips · 6 buttons/inputs · 8 nodes · 12 panels/popovers.
- **Elevation:** canvas (bg-0) → node (bg-2 + shadow-node) → popover (bg-2 + shadow-pop). Top inner highlight 4–5% white instead of borders on raised surfaces. No blur except the floating Play strip.
- **Motion:** 120ms event flash, 140ms hover, 220ms popovers, 360ms Patch ⇄ Play. Ease-out for entering, ease-in-out for view changes. Respects reduced-motion: flashes become a steady tint.
- **States:** hover = one step lighter surface (bg-n+1); press = bg-4; selected = 1.5px near-white ring; focus = 2px gap + ring; disabled = fg-4 text, no fill; error = red border + inline banner in the node header.
- **Canvas:** bg-0 with a 20px dot grid at line-2; lines or none as options.
- **Imagery:** none in chrome. The performance canvas (fluid render) is the only imagery.

## Content fundamentals
Sentence case everywhere. Node names are nouns ("Chord Tone", "Sample & Hold"); port labels are one or two words ("Down", "Pass"). Units always shown, lowercase (ms, Hz, kHz, dB, %). Errors say what happened and what to do: "Microphone blocked — Allow in browser settings". Second person, no emoji, no exclamation marks.

## Iconography
Lucide (CDN, `lucide-static` icon font), 1.5px stroke, 13–14px in nodes, 16px in toolbars. Node families use one glyph each: Sources `mouse-pointer-2`, Gestures `hand`, Time `timer`, Harmony `music`, Control `git-fork`, Instruments `piano`, Effects `audio-waveform`, Visual `droplets`, Output `speaker`. Substitution flagged: no project icon set was provided. No logo provided; the name is set in type.

## Index
- `styles.css`: the entry point (imports only) → `tokens/{fonts,icons,colors,typography,spacing,elevation}.css`
- `components/`: React primitives, each with `.d.ts` props and `.prompt.md` usage
  - `ports/`: Port, Cable (+ `cablePath`), CableChip
  - `controls/`: Knob, ParamField, Segmented, Toggle, Select, NumberField, StepGrid, Button, IconButton, Kbd
  - `nodes/`: Node (+ `portY`, `paramY` geometry helpers), FamilyChip (+ `FAMILIES`)
  - `overlays/`: NodePalette, Probe, AdapterPrompt, BudgetMeter
  - `chrome/`: Toolbar, Canvas, PreviewPane, PlayStrip
- `components.bundle.jsx`: all components in one file, exposed as `window.FlowPatcher`. Cards and the UI kit load it. Regenerate it after editing a component
- `guidelines/`: foundation specimen cards (colors, type, spacing, radii, elevation, motion, port shapes, glyphs)
- `ui_kits/flow-patcher/`: Patch ⇄ Play click-through
- `Flow Patcher Design System.dc.html`: long-form spec page
- `SKILL.md`: Agent Skills entry

## Intentional additions
No product source defined a component inventory. The set is derived from the editor described in `uploads/design.md`: typed ports, knobs, nodes, palette, probes, adapter prompts, budgets, and Patch/Play chrome.
