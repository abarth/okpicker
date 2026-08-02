'use strict';
/*
 * Blend modes, run backwards.
 *
 * A gradient map sitting over a grey underpainting is an unusually tractable
 * thing: the ramp position Photoshop looks up *is* the tone underneath it, so
 * for a stop at position t we know the blend's base is exactly the grey t.  For
 * a separable blend mode that makes each channel a one-dimensional equation
 * we can solve rather than guess at:
 *
 *     result = mode.apply(base, stop)   ->   stop = mode.invert(base, result)
 *
 * which is what lets the panel work the way round a painter thinks.  Say what
 * the *result* should be - this tone, that hue, that much chroma - and the
 * stop colour that produces it falls out.  Every stop is solved with its result
 * pinned to the underlying grey's OKLab lightness, so the pass adds chroma and
 * hue and moves nothing else.
 *
 * Only modes whose neutral is a flat grey are worth having here.  Multiply can
 * only darken and Screen can only lighten, so neither can hold lightness still
 * while adding colour: asked to, they solve to no colour at all.  What is left
 * is Normal plus the four contrast modes that pivot about mid grey, and they
 * differ in how much they can push before they run out of room - which is why
 * `solveStop` reports the chroma it actually reached, not the one it was asked
 * for.
 *
 * Pure maths, no DOM and no Photoshop, on encoded (gamma-carrying) channel
 * values in 0..1 - the numbers Photoshop itself blends, not linear light.
 */
(function (root, factory) {
  var dep = root.OKColor;
  if (!dep && typeof require === 'function' && typeof module === 'object') dep = require('./color.js');
  var api = factory(dep);
  root.OKBlend = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (OKColor) {

  // Slack for "did that land inside 0..1": the inverses are exact, so this only
  // has to absorb float noise, not real error.
  var EPS = 1e-9;

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  function inUnit(x) {
    return x !== null && x >= -EPS && x <= 1 + EPS ? clamp01(x) : null;
  }

  // Soft light's upper half leans on this, the W3C / PDF definition Photoshop
  // implements: a gentler curve than sqrt below a quarter tone.
  function softLightD(g) {
    return g <= 0.25 ? ((16 * g - 12) * g + 4) * g : Math.sqrt(g);
  }

  var MODES = {
    normal: {
      id: 'normal',
      label: 'Normal',
      ps: 'normal',
      // The layer *is* the result, so it can reach anything the gamut holds.
      apply: function (g, c) { return c; },
      invert: function (g, r) { return inUnit(r); },
      neutral: function (g) { return g; }
    },

    softLight: {
      id: 'softLight',
      label: 'Soft light',
      ps: 'softLight',
      apply: function (g, c) {
        return c <= 0.5
          ? g - (1 - 2 * c) * g * (1 - g)
          : g + (2 * c - 1) * (softLightD(g) - g);
      },
      // Reaches only g^2 at one end and D(g) at the other, so this is the mode
      // that most often has to give chroma back.
      invert: function (g, r) {
        if (r <= g) {
          var down = g * (1 - g);
          if (down <= 0) return Math.abs(r - g) <= EPS ? 0.5 : null;
          return inUnit((1 - (g - r) / down) * 0.5);
        }
        var up = softLightD(g) - g;
        if (up <= 0) return null;
        return inUnit((1 + (r - g) / up) * 0.5);
      },
      neutral: function () { return 0.5; }
    },

    overlay: {
      id: 'overlay',
      label: 'Overlay',
      ps: 'overlay',
      // Driven by the base: dark tones multiply, light tones screen, so the
      // shadows keep their weight however hard the layer pushes.
      apply: function (g, c) {
        return g <= 0.5 ? 2 * g * c : 1 - 2 * (1 - g) * (1 - c);
      },
      invert: function (g, r) {
        if (g <= 0.5) {
          if (g <= 0) return r <= EPS ? 0.5 : null;
          return inUnit(r / (2 * g));
        }
        if (g >= 1) return r >= 1 - EPS ? 0.5 : null;
        return inUnit(1 - (1 - r) / (2 * (1 - g)));
      },
      neutral: function () { return 0.5; }
    },

    hardLight: {
      id: 'hardLight',
      label: 'Hard light',
      ps: 'hardLight',
      // Overlay with the operands swapped: driven by the layer, so the ramp
      // reaches every tone and the pass keeps its bite in the extremes.
      apply: function (g, c) {
        return c <= 0.5 ? 2 * g * c : 1 - 2 * (1 - g) * (1 - c);
      },
      invert: function (g, r) {
        if (r <= g) {
          if (g <= 0) return r <= EPS ? 0.5 : null;
          return inUnit(r / (2 * g));
        }
        if (g >= 1) return null;
        return inUnit(1 - (1 - r) / (2 * (1 - g)));
      },
      neutral: function () { return 0.5; }
    },

    linearLight: {
      id: 'linearLight',
      label: 'Linear light',
      ps: 'linearLight',
      // A straight offset, which makes it the bluntest of the set and the only
      // one whose inverse never fails.
      apply: function (g, c) { return clamp01(g + 2 * c - 1); },
      invert: function (g, r) { return inUnit((r - g + 1) * 0.5); },
      neutral: function () { return 0.5; }
    }
  };

  var MODE_LIST = [MODES.softLight, MODES.overlay, MODES.hardLight, MODES.linearLight, MODES.normal];

  function getMode(id) {
    return MODES[id] || MODES.hardLight;
  }

  // ------------------------------------------------------------ neutral tones

  /**
   * OKLab lightness of an encoded neutral in `space`.  Equal channels are a
   * neutral in any RGB space, so this is the whole grey axis in one line.
   */
  function grayLightness(space, gray) {
    var lin = space.trc.decode(clamp01(gray));
    return OKColor.linearToOklab(space, lin, lin, lin)[0];
  }

  /** The encoded grey with a given OKLab lightness - `grayLightness` inverted. */
  function grayForLightness(space, L) {
    var lo = 0, hi = 1;
    for (var i = 0; i < 30; i++) {
      var mid = (lo + hi) * 0.5;
      if (grayLightness(space, mid) < L) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  // -------------------------------------------------------------- stop solver

  /** OKLab a/b of an encoded colour, and the lightness that came with it. */
  function encodedToOklab(space, enc) {
    var lin = OKColor.decodeChannels(space, enc);
    return OKColor.linearToOklab(space, lin[0], lin[1], lin[2]);
  }

  /**
   * The stop colour that moves `base` to the OKLab colour (L, a, b), or null
   * when the mode cannot reach that far from where it is standing.
   *
   * Comes back with the a and b it settled on rather than the ones it was
   * given: chroma the document cannot hold is trimmed here, and a caller that
   * reported the chroma it asked for would be reporting a colour that is not
   * going to be there.
   */
  function reach(space, mode, base, L, a, b, margin) {
    // Chroma the document cannot hold is not worth asking a blend mode for.
    var C = Math.sqrt(a * a + b * b);
    if (C > 0) {
      var H = Math.atan2(b, a) / (Math.PI / 180);
      var ceiling = OKColor.maxChroma(space, L, H < 0 ? H + 360 : H, 20) * (margin || 1);
      if (C > ceiling) {
        var k = ceiling / C;
        a *= k; b *= k;
      }
    }
    var lin = OKColor.oklabToLinear(space, L, a, b);
    if (!OKColor.inGamutLinear(lin, 1e-5)) return null;
    var e = space.trc.encode;
    var out = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      var want = e(clamp01(lin[i]));
      // A channel that is already where it should be is the one case the
      // inverse cannot answer: at pure black or pure white every stop value
      // below (or above) the neutral produces the same result, and picking one
      // of those instead of the neutral leaves a stop that means nothing next
      // to its neighbours.  Say "change nothing" explicitly.
      var c = Math.abs(want - base[i]) <= 1e-6
        ? mode.neutral(base[i])
        : mode.invert(base[i], want);
      if (c === null) return null;
      out[i] = c;
    }
    return { color: out, a: a, b: b };
  }

  /**
   * Solve one gradient-map stop: the colour that adds (`da`, `db`) of OKLab
   * chroma to what is already there while pinning lightness back to `L`.
   *
   * `base` is what the layer will actually be sitting on - the grey itself for
   * the bottom layer of a stack, the composite of everything below it for the
   * rest - which is what lets a layer add its own light and correct the drift
   * of the ones under it in the same move.
   *
   * The chroma asked for is a wish, not a promise.  It is cut back to what the
   * document's gamut holds at that lightness and then to what the blend mode
   * can still reach from that tone, and however much survived comes back with
   * the colour.  Soft light in the deep shadows is the extreme case - it can
   * barely move at all - and the panel draws that ceiling rather than
   * pretending it is not there.
   *
   * @param {object} opts
   * @param {object} opts.space      RGB working space of the document
   * @param {object} opts.mode       blend mode the layer will use
   * @param {number[]} opts.base     encoded colour under the stop, 0..1
   * @param {number} opts.lightness  OKLab lightness to hold
   * @param {number} opts.da         OKLab a to add
   * @param {number} opts.db         ...and b
   * @param {number} [opts.margin]   fraction of the gamut hull to stay inside
   * @returns {{color:number[], chroma:number, added:number}}
   */
  function solveStop(opts) {
    var space = opts.space;
    var mode = opts.mode;
    var base = opts.base;
    var L = opts.lightness;
    var margin = opts.margin || 1;
    var lab = encodedToOklab(space, base);
    var neutral = [mode.neutral(base[0]), mode.neutral(base[1]), mode.neutral(base[2])];
    var da = opts.da || 0, db = opts.db || 0;

    function at(s) {
      return reach(space, mode, base, L, lab[1] + da * s, lab[2] + db * s, margin);
    }

    function report(got) {
      var da_ = got.a - lab[1], db_ = got.b - lab[2];
      return {
        color: got.color,
        chroma: Math.sqrt(got.a * got.a + got.b * got.b),
        added: Math.sqrt(da_ * da_ + db_ * db_)
      };
    }

    var full = at(1);
    if (full) return report(full);

    // The reachable set is star-shaped in chroma for the same reason the gamut
    // is - every mode here is monotone in the stop value - so bisection lands
    // on the ceiling.
    var lo = 0, hi = 1, best = at(0);
    for (var i = 0; i < 18; i++) {
      var mid = (lo + hi) * 0.5;
      var got = at(mid);
      if (got) { lo = mid; best = got; } else { hi = mid; }
    }
    // Nowhere at all to go: leave the tone exactly as it was found.
    if (!best) {
      return {
        color: neutral,
        chroma: Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]),
        added: 0
      };
    }
    return report(best);
  }

  // ------------------------------------------------------------- composition

  /**
   * One layer over a base, the way Photoshop composites it: blend per channel,
   * then fade the result back towards the base by `amount` (the layer's opacity
   * and the mask at that point, multiplied together).
   */
  function over(mode, base, layer, amount, out) {
    out = out || [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      var blended = clamp01(mode.apply(base[i], layer[i]));
      out[i] = base[i] + (blended - base[i]) * amount;
    }
    return out;
  }

  /**
   * Photoshop reads a gradient map's input as the composite's luminosity, so
   * once a layer below has put colour into the image the next map up no longer
   * looks up the tone it was designed against.  These are the classic weights,
   * on encoded values, and they are only needed to *predict* a stack - a single
   * layer over a grey underpainting looks up its own position exactly.
   */
  function luminosity(rgb) {
    return 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
  }

  return {
    modes: MODES,
    modeList: MODE_LIST,
    getMode: getMode,
    grayLightness: grayLightness,
    grayForLightness: grayForLightness,
    encodedToOklab: encodedToOklab,
    solveStop: solveStop,
    over: over,
    luminosity: luminosity
  };
});
