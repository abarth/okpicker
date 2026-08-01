# OKLCH — a colour picker for Photoshop

A UXP panel for Adobe Photoshop that picks colours in **OKLCH** — the perceptual
lightness / chroma / hue model — and shows you exactly which of those colours
fit inside the current document's colour space.

![The panel](docs/panel.png)

## What it gives you

- **It *is* the foreground colour.** The panel is bound to Photoshop's
  foreground swatch in both directions: move anything in the picker and the
  foreground changes as you drag, change the foreground anywhere else in
  Photoshop and the picker follows. There is nothing to apply and nothing to
  pick up.
- **A C/H diagram shaped like the gamut.** Not a square, not a colour wheel: at
  the current lightness the panel solves for the maximum chroma at every hue and
  paints only the colours the document can actually hold. The silhouette *is*
  the gamut slice, so you can see at a glance that (say) sRGB has plenty of
  chroma in the reds and almost none in the cyans at high lightness. The picture
  is cropped to the gamut's own extent, so the shape fills it instead of
  floating inside a square.
- **A track for each axis** — L, C and H — each painted as a live ramp of the
  colours you would get by moving it, with the out-of-gamut stretch dimmed and
  hatched.
- **Chroma held on the gamut hull.** Moving lightness or hue slides the colour
  along the edge of what the document can hold rather than letting it drift
  outside, so what you see is always what you get.
- **Gamut awareness that follows the document.** The panel reads the frontmost
  document's ICC profile and reshapes itself for sRGB, Display P3,
  Adobe RGB (1998), ProPhoto, Rec. 2020, Wide Gamut RGB, Apple RGB,
  ColorMatch, eciRGB v2 or Rec. 709 — and re-reads it by itself whenever the
  document, its profile or its mode changes.
- **Colour-managed hand-off.** The colour goes to Photoshop as D50 Lab, so the
  swatch matches the colour you picked no matter what the document's working
  space is.
- **Fits the space it is given.** Everything is sized to the panel, so the whole
  picker stays reachable in a narrow Photoshop side panel without scrolling.

## Requirements

- Photoshop 2026 (version 27) — the manifest accepts 26.0.0 and up, so
  Photoshop 2025 works too.
- Nothing else. There is no build step and there are no dependencies; the
  plugin is plain HTML, CSS and JavaScript.

## Installing

### With the UXP Developer Tool (recommended while iterating)

1. Install the [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/)
   and start Photoshop.
2. In UDT, **Add Plugin…** and select this repository's `manifest.json`.
3. Press **Load**. The panel appears under **Plugins → OKLCH**.

`Load` again after editing a file, or use UDT's **Watch** to reload on save.

### Manually

Copy the whole repository into Photoshop's developer plugin folder and restart
Photoshop:

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/Adobe/UXP/Plugins/External/okpicker` |
| Windows | `%APPDATA%\Adobe\UXP\Plugins\External\okpicker` |

Loading unpackaged plugins requires developer mode: in the Creative Cloud
desktop app, **Preferences → Apps → Enable "Allow plugins from unknown
sources"** (Photoshop's **Plugins → Plugins Panel** lists what it found).

To hand the plugin to someone who is not a developer, package it as a `.ccx`
with [UPIA](https://developer.adobe.com/photoshop/uxp/2022/guides/distribution/)
(`upia package .`); the layout here is already what UPIA expects.

## Using it

| Control | What it does |
| --- | --- |
| Diagram | Click or drag to set chroma (distance from the neutral point) and hue (angle, 0° at 3 o'clock, counter-clockwise). |
| Top track | Lightness. The diagram is redrawn for the new slice. |
| Middle track | Chroma, up to the largest the space can hold anywhere. |
| Bottom track | Hue, right round the circle. |
| Swatch | The colour you are on, which is also Photoshop's foreground colour. It sits inside the diagram, in a corner the gamut cannot reach, and drags pass straight through it. |

Both the diagram and the tracks write straight through to the foreground
swatch, live, while you drag.

## How the gamut is computed

OKLab is defined against linear sRGB at D65. For any other working space the
panel builds the RGB→XYZ matrix from the space's primaries and white point,
Bradford-adapts it to D65, and folds the whole chain into a single 3×3 matrix
applied to the cube-rooted LMS values — so testing whether an OKLCH triple fits
in the gamut is one matrix multiply and three range checks.

The gamut body is star-shaped in chroma at a fixed L and H, so the maximum
chroma is found by bisection (~20 iterations, exact to ~10⁻⁷). The diagram
samples that limit at 720 hues and interpolates, which also gives the outline
its anti-aliased edge. A worst-case repaint — the lightness axis moving, so the
diagram and all three ramps are stale at once — costs around ten milliseconds,
so every frame is drawn at full resolution and there is no draft pass to flicker
through.

The scale is fixed per space rather than per slice, so it does not shift under
you as you move lightness. The diagram is a window onto the OKLab a/b plane, and
that window is the space's whole gamut swept over every lightness and hue, plus
2% headroom — not a square drawn to the largest chroma in any direction. The
difference matters because the two are nothing like the same shape: sRGB reaches
`b = −0.31` towards blue but only `+0.20` towards yellow, so the square left its
top fifth permanently empty. Cropping to the real extent cuts the never-painted
band from 21.5% of the height to 3%, and shows the hull 1.2× larger in the same
number of pixels.

A single slice still does not fill the window — at L = 0.57 about 17% of the
height is above the shape — because the window has to stay put while the slice
grows and shrinks. That is the price of a stable scale.

The corners are a different matter: a rounded hull in a rectangle leaves them
empty for good, so the swatch goes in one of them and costs no layout space at
all. Which one is not a constant. The panel projects the whole gamut onto the
a/b plane — the largest chroma each hue reaches at *any* lightness — and finds
the biggest corner square that projection misses. Most RGB spaces lean away
from blue-green and free up the bottom left (sRGB: 30% of the diagram's width),
but ProPhoto's imaginary primaries fill that corner and vacate the top left
instead, so the swatch moves there when the document does.

### Things worth knowing

- **The panel is not colour managed.** Photoshop paints UXP panels as sRGB, so
  colours the document can hold but sRGB cannot are drawn clipped — in the
  diagram, in the ramps and in the swatch alike. The *shape* is always the
  document's true gamut; the fill is the closest sRGB can show.
- **CMYK, Grayscale, Lab, Indexed and Duotone documents**, and RGB documents
  with a profile the panel does not recognise, fall back to sRGB for the
  diagram. Their gamuts are defined by an ICC profile that a UXP plugin cannot
  evaluate, so a shape drawn for them would be a guess. The colour itself is
  still sent as Lab and converted by Photoshop, so the foreground swatch is
  correct either way.
- Writing the colour uses `labColor`, which Photoshop converts into the
  document's space. If that call fails the panel retries with the document's
  RGB values.
- Writes while you drag **coalesce**: at most one is ever in flight, and the
  next one carries whatever the state has become by then. The picker ignores
  the notification its own write comes back as, so the two directions of the
  binding cannot chase each other.

## Development

```sh
npm test        # colour maths, PNG encoder and renderer (node's test runner)
npm run icons   # regenerate icons/ — they are rendered by the panel's own code
```

`index.html` opens directly in a browser for UI work: the Photoshop bridge
degrades to a no-op, so the panel starts on its default colour and writes go
nowhere, but the diagram, the tracks and the swatch behave exactly as they do
in Photoshop — including the way the layout compacts itself as you resize the
window.

### Layout

| Path | Contents |
| --- | --- |
| `manifest.json` | UXP manifest (manifest version 5, panel entry point). |
| `index.html` | Panel markup; loads the scripts below in order. |
| `src/color.js` | OKLab/OKLCH, working-space matrices, transfer functions, gamut search, Lab, profile-name matching. No DOM. |
| `src/render.js` | Pixel generators for the diagram and the ramps. |
| `src/png.js` | RGBA → PNG → data URI, for hosts without a working canvas. |
| `src/ps.js` | Photoshop bridge: document profile, reading and writing swatches, notifications. |
| `src/ui.js` | Panel state, the foreground binding, repaint scheduling, layout and event wiring. |
| `test/` | Unit tests for everything above the DOM. |

The renderer writes into an RGBA buffer and the panel decides where it goes: it
probes the host's canvas by round-tripping a `putImageData`, and falls back to
an `<img>` fed by the built-in PNG encoder if that probe fails.

## Licence

Apache 2.0 — see [LICENSE](LICENSE).
