# OKLCH Picker for Photoshop

A UXP panel for Adobe Photoshop that picks colours in **OKLCH** — the perceptual
lightness / chroma / hue model — and shows you exactly which of those colours
fit inside the current document's colour space.

![The panel](docs/panel.png)

## What it gives you

- **A C/H diagram shaped like the gamut.** Not a square, not a colour wheel: at
  the current lightness the panel solves for the maximum chroma at every hue and
  paints only the colours the document can actually hold. The silhouette *is*
  the gamut slice, so you can see at a glance that (say) sRGB has plenty of
  chroma in the reds and almost none in the cyans at high lightness.
- **A lightness slider next to the diagram**, so you can sweep L and watch the
  reachable shape grow and shrink.
- **A separate slider for each axis** — L, C and H — each painted as a live ramp
  of the colours you would get by moving it, with the out-of-gamut stretch
  dimmed and hatched.
- **Click or drag anywhere**: the diagram and all four sliders respond to a
  click, a drag, the number fields (arrow keys nudge, ⇧ + arrow nudges by ten),
  or a hex value.
- **Gamut awareness that follows the document.** The panel reads the frontmost
  document's ICC profile and reshapes itself for sRGB, Display P3,
  Adobe RGB (1998), ProPhoto, Rec. 2020, Wide Gamut RGB, Apple RGB,
  ColorMatch, eciRGB v2 or Rec. 709. You can also pin it to a space by hand.
- **Colour-managed hand-off.** Applying a colour sends it to Photoshop as
  D50 Lab, so the swatch matches the colour you picked no matter what the
  document's working space is.

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
3. Press **Load**. The panel appears under **Plugins → OKLCH Picker**.

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
| Diagram | Click or drag to set chroma (distance from the centre) and hue (angle, 0° at 3 o'clock, counter-clockwise). |
| Strip beside the diagram | Lightness; the diagram is redrawn for the new slice. |
| L / C / H sliders | The same three axes, one at a time. |
| Hex field | Type a hex value *in document space* to load it. |
| **Gamut** | `Document profile` follows the open document; pick a space to override. |
| **Keep chroma in gamut** | Holds the colour on the gamut hull as you move L and H instead of letting it drift outside. Turn it off to work with out-of-gamut values (the swatch then shows a `!` and the preview is the clipped colour). |
| **Auto-apply** | Sends the colour to the foreground swatch whenever you finish a drag or commit a field. |
| **Foreground** / **Background** | Apply once, on demand. |
| **Pick up** | Load Photoshop's current foreground colour into the picker. |
| Panel flyout menu | Copy the CSS `oklch()` string or the hex value, pick up the foreground colour, reset the picker. |

The chroma field shows `value / limit`, where the limit is the largest chroma
this lightness and hue can hold in the target space.

## How the gamut is computed

OKLab is defined against linear sRGB at D65. For any other working space the
panel builds the RGB→XYZ matrix from the space's primaries and white point,
Bradford-adapts it to D65, and folds the whole chain into a single 3×3 matrix
applied to the cube-rooted LMS values — so testing whether an OKLCH triple fits
in the gamut is one matrix multiply and three range checks.

The gamut body is star-shaped in chroma at a fixed L and H, so the maximum
chroma is found by bisection (~20 iterations, exact to ~10⁻⁷). The diagram
samples that limit at 720 hues and interpolates, which also gives the outline
its anti-aliased edge. While you drag, the panel repaints at reduced resolution
and does a full-quality pass once you stop.

The chroma axis is scaled per space to that space's overall maximum chroma, so
the scale does not shift under you as you move the lightness slider.

### Things worth knowing

- **The panel is not colour managed.** Photoshop paints UXP panels as sRGB, so
  colours the document can hold but sRGB cannot are drawn clipped. The *shape*
  is always the document's true gamut; the fill is the closest sRGB can show.
  The hex field reports document values, not screen values.
- **CMYK, Grayscale, Lab, Indexed and Duotone documents** fall back to sRGB for
  the diagram, and the profile chip says so. Their gamuts are defined by an ICC
  profile that a UXP plugin cannot evaluate, so a shape drawn for them would be
  a guess. The colour you apply is still sent as Lab and converted by
  Photoshop, so applying works normally.
- **Unrecognised RGB profiles** fall back to sRGB with a warning on the chip.
  Use the **Gamut** menu to pick the closest match by hand.
- Applying uses `labColor`, which Photoshop converts into the document's space.
  If that call fails the panel retries with the document's RGB values and says
  so in the status line.

## Development

```sh
npm test        # colour maths, PNG encoder and renderer (node's test runner)
npm run icons   # regenerate icons/ — they are rendered by the panel's own code
```

`index.html` opens directly in a browser for UI work: the Photoshop bridge
degrades to "Preview mode" and the apply buttons disable themselves, but the
diagram, the sliders and every readout behave exactly as they do in the panel.

### Layout

| Path | Contents |
| --- | --- |
| `manifest.json` | UXP manifest (manifest version 5, panel entry point). |
| `index.html` | Panel markup; loads the scripts below in order. |
| `src/color.js` | OKLab/OKLCH, working-space matrices, transfer functions, gamut search, Lab, profile-name matching. No DOM. |
| `src/render.js` | Pixel generators for the diagram and the ramps. |
| `src/png.js` | RGBA → PNG → data URI, for hosts without a working canvas. |
| `src/ps.js` | Photoshop bridge: document profile, applying colours, notifications, clipboard. |
| `src/ui.js` | Panel state, repaint scheduling, event wiring. |
| `test/` | Unit tests for everything above the DOM. |

The renderer writes into an RGBA buffer and the panel decides where it goes: it
probes the host's canvas by round-tripping a `putImageData`, and falls back to
an `<img>` fed by the built-in PNG encoder if that probe fails.

## Licence

Apache 2.0 — see [LICENSE](LICENSE).
