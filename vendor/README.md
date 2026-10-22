# vendor/

Third-party files, copied verbatim. Don't edit them; wrap or adapt them outside vendor/.

## Where they came from

Copied byte for byte from Flow's `public/vendor/` (the sibling checkout at ../flow, https://github.com/riebschlager/flow), which took them from upstream:

- WebAudioFont by Sergey Surikov: https://github.com/surikov/webaudiofont
- WebAudioFont's sample data: https://github.com/surikov/webaudiofontdata (the `sound/` folder)
- FluidR3 GM SoundFont, original by Frank Wen, mono version by Michael Cowgill, from which those sample files were converted

## Files

| File | What it is | License |
| --- | --- | --- |
| `NNNN_FluidR3_GM_sf2_file.js` (28 files) | One FluidR3 GM instrument each, as a WebAudioFont preset: a JavaScript object `_tone_NNNN_FluidR3_GM_sf2_file` with a `zones` array. Each zone has its key range, original pitch, tuning, loop points, sample rate and a base64 MP3 sample. `NNNN` is the General MIDI program times ten plus a variant (0000 is program 0, Acoustic Grand Piano). | Samples: FluidR3 GM, MIT (`LICENSE-FluidR3.txt`). The data files: WebAudioFontData, MIT (`LICENSE-WebAudioFontData.txt`). |
| `LICENSE-FluidR3.txt` | The FluidR3 Mono GM notice, with the original FluidR3 README and COPYING. | — |
| `LICENSE-WebAudioFontData.txt` | The MIT notice of the webaudiofontdata repository. | — |
| `LICENSE-WebAudioFont.md` | The GPL-3.0 text WebAudioFont is released under. Flow Patcher doesn't ship WebAudioFontPlayer.js: packages/nodes/src/instruments.ts and sampled-voice.ts port its zone playback to TypeScript, so that code is covered by it (and by Flow Patcher's own GPL-3.0, docs/decisions/0002-license-gpl-3.0.md). | — |

The sample files are never evaluated as scripts. `packages/nodes/src/instruments.ts` reads their zone fields as text, and hosts serve them through `HostServices.samples` (the browser fetches `/vendor/<file>`, headless runs read this folder from disk).

Nothing else goes in vendor/.
