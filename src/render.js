'use strict';
/*
 * Pixel generators for the panel: the gamut-shaped C/H diagram and the three
 * axis ramps.  Everything writes into an RGBA buffer; the caller decides
 * whether to hand it to a canvas or to the PNG encoder.
 *
 * Out-of-gamut areas are drawn with partial alpha (plus a hatch on the ramps)
 * rather than an opaque colour, so the result sits correctly on both the light
 * and dark Photoshop themes.
 */
(function (root, factory) {
  var dep = root.OKColor;
  if (!dep && typeof require === 'function' && typeof module === 'object') dep = require('./color.js');
  var api = factory(dep);
  root.OKRender = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (OKColor) {

  var DEG = Math.PI / 180;
  var P = OKColor.LMS_ROOT_FROM_OKLAB;

  // sRGB encode is the hot spot in every loop below; a table plus linear
  // interpolation is within 0.02 of an 8-bit level and roughly 10x faster.
  var LUT_SIZE = 2048;
  var ENCODE_LUT = (function () {
    var lut = new Float32Array(LUT_SIZE + 1);
    for (var i = 0; i <= LUT_SIZE; i++) {
      lut[i] = OKColor.TRC.srgb.encode(i / LUT_SIZE) * 255;
    }
    return lut;
  })();

  function encode255(x) {
    if (!(x > 0)) return 0;
    if (x >= 1) return 255;
    var t = x * LUT_SIZE;
    var i = t | 0;
    return ENCODE_LUT[i] + (ENCODE_LUT[i + 1] - ENCODE_LUT[i]) * (t - i);
  }

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  /**
   * Fast OKLab -> 8-bit sRGB for display, given precomputed L terms.
   * Writes into `out` (length >= 3).
   */
  function oklabToDisplay(M, l0, m0, s0, a, b, out) {
    var l = l0 + P[1] * a + P[2] * b;
    var m = m0 + P[4] * a + P[5] * b;
    var s = s0 + P[7] * a + P[8] * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    out[0] = encode255(clamp01(M[0] * l + M[1] * m + M[2] * s));
    out[1] = encode255(clamp01(M[3] * l + M[4] * m + M[5] * s));
    out[2] = encode255(clamp01(M[6] * l + M[7] * m + M[8] * s));
  }

  function buffer(width, height) {
    return {
      width: width,
      height: height,
      data: new Uint8ClampedArray(width * height * 4)
    };
  }

  // ------------------------------------------------------- C/H gamut diagram

  /**
   * Polar C/H slice at a fixed lightness, clipped to the shape of the target
   * gamut.  Angle is hue (0 deg at 3 o'clock, counter-clockwise), radius is
   * chroma scaled so that `maxC` lands exactly on the edge of the square.
   *
   * @param {object} opts
   * @param {object} opts.space     target working space
   * @param {number} opts.L         OKLab lightness, 0..1
   * @param {number} opts.maxC      chroma at the outer edge of the plot
   * @param {number} opts.size      output size in pixels (square)
   * @param {Float64Array} [opts.envelope]  precomputed chroma limits per hue
   * @param {number[]} [opts.outline] RGB of the boundary stroke, 0..255
   */
  function chPlot(opts) {
    var space = opts.space;
    var L = opts.L;
    var size = opts.size;
    var maxC = opts.maxC;
    var env = opts.envelope || OKColor.chromaEnvelope(space, L, opts.envelopeSamples || 720);
    var outline = opts.outline || [0, 0, 0];
    var img = buffer(size, size);
    var data = img.data;

    var srgbM = OKColor.spaces.srgb.lmsToLinear;
    var l0 = P[0] * L, m0 = P[3] * L, s0 = P[6] * L;
    var half = size / 2;
    var scale = maxC / half;          // chroma units per pixel
    var invScale = 1 / scale;         // pixels per chroma unit
    var limit = maxC + scale;         // skip everything past the corner circle
    var limitSq = limit * limit;
    var rgb = [0, 0, 0];
    var envN = env.length - 1;
    var envStep = envN / 360;

    for (var y = 0; y < size; y++) {
      var b = (half - (y + 0.5)) * scale;
      var rowBase = y * size * 4;
      for (var x = 0; x < size; x++) {
        var a = (x + 0.5 - half) * scale;
        var cSq = a * a + b * b;
        if (cSq > limitSq) continue;
        var c = Math.sqrt(cSq);

        var hDeg = Math.atan2(b, a) / DEG;
        if (hDeg < 0) hDeg += 360;
        var t = hDeg * envStep;
        var ei = t | 0;
        if (ei >= envN) ei = envN - 1;
        var cMax = env[ei] + (env[ei + 1] - env[ei]) * (t - ei);

        // Distance to the gamut boundary, measured in pixels.
        var d = (cMax - c) * invScale;
        if (d < -0.5) continue;
        var cov = d + 0.5;
        if (cov > 1) cov = 1;

        oklabToDisplay(srgbM, l0, m0, s0, a, b, rgb);

        // Darken the last pixel or so before the edge: it gives the shape a
        // readable contour on any panel background.
        var edge = 1.1 - d;
        var i = rowBase + x * 4;
        if (edge > 0) {
          if (edge > 1) edge = 1;
          var k = edge * 0.35;
          data[i] = rgb[0] + (outline[0] - rgb[0]) * k;
          data[i + 1] = rgb[1] + (outline[1] - rgb[1]) * k;
          data[i + 2] = rgb[2] + (outline[2] - rgb[2]) * k;
        } else {
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
        }
        data[i + 3] = cov * 255;
      }
    }
    return img;
  }

  // ------------------------------------------------------------- axis ramps

  var OUT_ALPHA = 0.26;       // out-of-gamut base opacity
  var OUT_HATCH_ALPHA = 0.5;  // ...and on the hatch stripes

  function hatched(x, y) {
    return ((x + y) & 7) < 3;
  }

  /**
   * Shared ramp painter.  `sample(t)` returns [L, C, H] for a position along
   * the ramp; `limit(t)` returns the chroma ceiling at that position so we can
   * mark the out-of-gamut stretch.
   */
  function ramp(opts) {
    var width = opts.width, height = opts.height;
    var vertical = !!opts.vertical;
    var n = vertical ? height : width;
    var img = buffer(width, height);
    var data = img.data;
    var srgbM = OKColor.spaces.srgb.lmsToLinear;
    var rgb = [0, 0, 0];
    var colors = new Uint8Array(n * 3);
    var fits = new Uint8Array(n);

    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      if (vertical) t = 1 - t; // bottom of the strip is t = 0
      var lch = opts.sample(t);
      var L = lch[0], C = lch[1], H = lch[2];
      var l0 = P[0] * L, m0 = P[3] * L, s0 = P[6] * L;
      var h = H * DEG;
      oklabToDisplay(srgbM, l0, m0, s0, C * Math.cos(h), C * Math.sin(h), rgb);
      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
      fits[i] = C <= opts.limit(t, L, H) ? 1 : 0;
    }

    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var idx = vertical ? y : x;
        var o = (y * width + x) * 4;
        data[o] = colors[idx * 3];
        data[o + 1] = colors[idx * 3 + 1];
        data[o + 2] = colors[idx * 3 + 2];
        data[o + 3] = fits[idx]
          ? 255
          : (hatched(x, y) ? OUT_HATCH_ALPHA : OUT_ALPHA) * 255;
      }
    }
    return img;
  }

  /** Lightness ramp, 0..1, at the current chroma and hue. */
  function lightnessRamp(opts) {
    var space = opts.space, C = opts.C, H = opts.H;
    var cache = {};
    return ramp({
      width: opts.width, height: opts.height, vertical: opts.vertical,
      sample: function (t) { return [t, C, H]; },
      limit: function (t, L) {
        var key = Math.round(t * 4096);
        if (cache[key] === undefined) cache[key] = OKColor.maxChroma(space, L, H, 18);
        return cache[key];
      }
    });
  }

  /** Chroma ramp, 0..maxC, at the current lightness and hue. */
  function chromaRamp(opts) {
    var ceiling = OKColor.maxChroma(opts.space, opts.L, opts.H, 22);
    var L = opts.L, H = opts.H, maxC = opts.maxC;
    return ramp({
      width: opts.width, height: opts.height, vertical: opts.vertical,
      sample: function (t) { return [L, t * maxC, H]; },
      limit: function () { return ceiling; }
    });
  }

  /** Hue ramp, 0..360, at the current lightness and chroma. */
  function hueRamp(opts) {
    var space = opts.space, L = opts.L, C = opts.C;
    var cache = {};
    return ramp({
      width: opts.width, height: opts.height, vertical: opts.vertical,
      sample: function (t) { return [L, C, t * 360]; },
      limit: function (t, _L, H) {
        var key = Math.round(t * 4096);
        if (cache[key] === undefined) cache[key] = OKColor.maxChroma(space, L, H, 18);
        return cache[key];
      }
    });
  }

  // ------------------------------------------------------- plot <-> geometry
  // The plot fills its square exactly: chroma `maxC` maps to the half-width,
  // so a marker at (C, H) sits at these fractions of the element.

  function markerFraction(C, H, maxC) {
    var r = maxC > 0 ? C / maxC : 0;
    var h = H * DEG;
    return { x: 0.5 + r * 0.5 * Math.cos(h), y: 0.5 - r * 0.5 * Math.sin(h) };
  }

  function fractionToCh(fx, fy, maxC) {
    var dx = (fx - 0.5) * 2, dy = (0.5 - fy) * 2;
    var C = Math.sqrt(dx * dx + dy * dy) * maxC;
    var H = Math.atan2(dy, dx) / DEG;
    if (H < 0) H += 360;
    return { C: C, H: H };
  }

  return {
    buffer: buffer,
    encode255: encode255,
    chPlot: chPlot,
    lightnessRamp: lightnessRamp,
    chromaRamp: chromaRamp,
    hueRamp: hueRamp,
    markerFraction: markerFraction,
    fractionToCh: fractionToCh
  };
});
