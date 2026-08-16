# OKLCH — colour tools for Photoshop

A UXP plugin for Adobe Photoshop that works in **OKLCH** — the perceptual
lightness / chroma / hue model — and shows you exactly which colours fit inside
the current document's colour space. It installs two panels:

- **OKLCH**, a colour picker bound to the foreground swatch.
- **Gradient Map**, for designing the gradient map that colours a grayscale
  painting, live on the image.

![The picker](docs/panel.png)

## What the picker gives you

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
  picker stays reachable in a narrow Photoshop side panel without scrolling. The
  tracks sit on the bottom edge and the diagram centres itself in whatever is
  left, so a tall dock gets a balanced picture rather than a pool of empty space
  under the controls.

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
| Swatch | The colour you are on, which is also Photoshop's foreground colour. It sits at the left, just above the lightness track. Pressing it does nothing — it reports the colour, it does not set one — though a drag begun on the diagram keeps tracking across it. |

Both the diagram and the tracks write straight through to the foreground
swatch, live, while you drag.

## The Gradient Map panel

A common way to paint is to work out the values in grayscale first and put the
colour in afterwards with a gradient map. The problem with designing that
gradient by hand is that it is very easy to move the painting's values while
you are choosing its colours — a saturated blue picked to sit at "mid grey"
is nothing like mid grey to look at.

This panel designs the gradient in OKLCH instead, and **keeps the lightness the
painting already has**. Black stays black, white stays white, and every grey in
between comes out at exactly its own lightness with the chroma and hue you chose
for it.

| Control | What it does |
| --- | --- |
| Ramp | The gradient you are building, drawn against lightness. Press near a handle to take hold of it, press anywhere else to drop a new control point there. Drag a handle clear of the row, or press Delete, to throw it away. |
| Handles | One per control point. The filled one is selected; everything below acts on it. |
| Diagram | The gamut at the selected point's lightness, with the whole ramp's route drawn across it and a dot on each of the other control points. Click or drag to set chroma and hue. |
| Top track | Chroma, as a fraction of what the document can hold at this lightness and hue — so the whole track is in gamut, end to end. |
| Middle track | Hue, right round the circle at that same relative chroma. |
| Bottom track | The master amount: every control point's chroma at once. |
| Preset | Twenty-five lighting conditions to start from, from daylight and tungsten to sodium vapour and bioluminescence. |
| Button | Adds a gradient map layer when there is not one selected; otherwise it names the layer the panel is bound to. |

Everything writes straight through to the layer while you drag, so the picture
is the feedback. The panel edits **the gradient map layer you have selected** and
nothing else, so there is never a hidden write to a layer you cannot see.

The design travels with the layer: the control points are written into the
gradient's name, so a document you reopen a week later comes back as three
handles you can move, not a stop list nobody can edit.

### Which blending mode, and why Normal

The layer wants to be **Normal at 100%**, at the top of the stack or clipped to
the painting. At Normal and full opacity an adjustment layer does no compositing
arithmetic at all — the result *is* the gradient lookup — so what comes out is
what the panel computed, and none of it depends on Photoshop's blend maths or on
the *Blend RGB Colors Using Gamma* setting in Colour Settings.

The alternatives were considered and three of them fail outright:

- **Soft Light** cannot reach the colours. At base `b` its output can only land
  in `[b², D(b)]`; at 50% grey that is `[0.25, 0.71]`, and a merely
  orange midtone at that lightness needs a red channel of 0.74.
- **Overlay** clips in the shadows: its range is `[0, 2b]` below mid, so at 20%
  grey nothing past 40% is producible in any channel — exactly where a warm
  shadow wants its red.
- **Colour** cannot do it at all, and no gradient can fix that. Photoshop's
  Colour mode preserves `0.30R + 0.59G + 0.11B` on the encoded values, so the
  reachable set is *every* colour of that luminosity — and adding any correction
  to the gradient cancels out exactly. It pins the wrong notion of lightness,
  which is the thing OKLab exists to fix.
- **Hard Light** is the one real contender: it is invertible, so the target can
  be baked into the gradient. But it doubles the quantisation error, it leaks
  any colour left in the "grayscale" underpainting, it changes meaning with the
  gamma-blending preference, and the stops stop looking like the result — which
  makes the gradient useless to anyone opening it in the Gradient Editor.

Layer opacity then does something useful rather than something confusing: it
fades back towards the original grayscale, and because both ends of that fade
share a lightness, the fade is very nearly lightness-neutral too.

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
empty for good, which is what lets the swatch overlap the diagram and cost no
layout space at all. The swatch is pinned to the controls — bottom left, just
above the lightness track — so it holds still while the diagram floats above
it, and on a short panel the two meet in the diagram's bottom-left corner.

To be sure that corner really is free, the panel projects the whole gamut onto
the a/b plane — the largest chroma each hue reaches at *any* lightness — and
bisects for the biggest bottom-left square that projection misses. Most RGB
spaces lean away from blue-green and leave a quarter of the width clear
(sRGB: 30%), which is more than the swatch needs at any usable panel size.
ProPhoto is the exception: its imaginary primaries reach into that corner, so
it gets a smaller badge.

## How the gradient map is built

Everything rests on one identity. For a neutral pixel with linear value `y`,
OKLab lightness is exactly `y^(1/3)` — and exactly that in *every* working space
the plugin knows, because a neutral maps to the space's own white point, the
Bradford adaptation carries that onto D65 exactly, and both OKLab matrices have
rows that sum to one. So a grayscale painting hands the panel its lightness
directly, and a stop placed at position `encode(L³)` with lightness `L` puts it
back untouched.

That mapping is also why the ramp is drawn against lightness rather than along
the gradient's own axis: **OKLab L = 0.5 is sRGB 99/255**, not 128. Laid out the
other way, half the tonal range a painter cares about is squeezed into the left
third of the strip.

**Chroma is stored relative to the gamut**, as a fraction of the largest chroma
the document can hold at that lightness and hue. Two things fall out of it. The
gamut's chroma limit goes to zero at both ends of the lightness range, so the
ramp tapers to neutral by itself — black stays black and white stays white with
no pinned endpoints and no special cases. And a design can never ask for a
colour the document cannot hold, so the ramp has no clamping crease in it.

Between control points the panel interpolates the **chroma vector**, not the hue
angle, so a blue shadow running to an orange midtone passes through low chroma
rather than through whichever hues happen to lie between them. Ramps that really
do want to sweep the wheel — the neon and aurora presets among them — ask for the
hue angle instead. Either way the curve is a monotone cubic, which cannot
overshoot into a chroma or a hue nobody asked for.

**Control points and gradient stops are different things.** Three control points
is the whole design; the stops are generated. Photoshop has three interpolation
rules — Perceptual (OKLab, the default since 2023), Linear and Classic — and
rather than bet on one, the panel seeds 33 stops uniform in lightness, plus one
on each control point, and then bisects the worst interval until *all three*
rules reproduce the design to within half an 8-bit step. That takes 35 to 62
stops depending on the design and the space, and it makes the result the same
whichever rule the host applies.

One property is worth calling out: at zero chroma a stop's encoded value is
exactly its own position, so the neutral part of every ramp lies exactly on the
diagonal and is reproduced perfectly at any stop count. All the error being
refined away is chromatic.

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
- **The document has to be in RGB mode** for the gradient map to produce colour.
- The gradient map panel asks for whichever gradient interpolation rule
  Photoshop is already set to, rather than naming one. The descriptor key is
  undocumented and a wrong spelling would fail the whole write, and since the
  stops are refined against all three rules there is nothing to gain from
  picking one. `INTERPOLATION_METHOD` in `src/ps.js` turns it on once the
  spelling has been confirmed.
- Dragging in the gradient panel writes on every frame, so a drag leaves several
  history states rather than one. Collapsing them wants `suspendHistory` held
  open across the drag, which is worth doing but wants testing against a real
  Photoshop first.
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
degrades to a no-op, so the panels start on their defaults and writes go
nowhere, but the diagrams, the tracks, the ramp and the swatches behave exactly
as they do in Photoshop — including the way the layout compacts itself as you
resize the window. Photoshop shows one `<uxp-panel>` per panel; a browser has
never heard of the element, so with no host to hide one of them the two are put
side by side.

### Layout

| Path | Contents |
| --- | --- |
| `manifest.json` | UXP manifest (manifest version 5, two panel entry points). |
| `index.html` | Both panels' markup, one `<uxp-panel>` each; loads the scripts below in order. |
| `src/color.js` | OKLab/OKLCH, working-space matrices, transfer functions, gamut search, Lab, profile-name matching. No DOM. |
| `src/gradient.js` | The gradient map design: control points, splines, relative chroma, stop placement, the presets, and a simulator of Photoshop's interpolation to check the result against. No DOM. |
| `src/render.js` | Pixel generators for the diagram, the ramps and the route overlay. |
| `src/png.js` | RGBA → PNG → data URI, for hosts without a working canvas. |
| `src/surface.js` | DOM plumbing shared by the panels: the paint surface and pointer dragging. |
| `src/ps.js` | Photoshop bridge: document profile, swatches, gradient map layers, notifications. |
| `src/ui.js` | The picker: state, the foreground binding, repaint scheduling, layout and event wiring. |
| `src/gradui.js` | The gradient map panel, the same way. |
| `test/` | Unit tests for everything above the DOM. |

The renderer writes into an RGBA buffer and the panel decides where it goes: it
probes the host's canvas by round-tripping a `putImageData`, and falls back to
an `<img>` fed by the built-in PNG encoder if that probe fails.

## Licence

Apache 2.0 — see [LICENSE](LICENSE).
