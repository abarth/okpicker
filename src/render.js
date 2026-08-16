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
   * C/H slice at a fixed lightness, clipped to the shape of the target gamut.
   * The picture is a window onto the OKLab a/b plane: hue is the angle about
   * the neutral point (0 deg at 3 o'clock, counter-clockwise) and chroma the
   * distance from it.  `bounds` says which part of that plane to show, so the
   * caller can crop to the gamut's own extent rather than to a square drawn at
   * the largest chroma in any direction.
   *
   * @param {object} opts
   * @param {object} opts.space     target working space
   * @param {number} opts.L         OKLab lightness, 0..1
   * @param {object} opts.bounds    {aMin, aMax, bMin, bMax} region to paint
   * @param {number} opts.width     output width in pixels
   * @param {number} opts.height    output height in pixels
   * @param {Float64Array} [opts.envelope]  precomputed chroma limits per hue
   * @param {number[]} [opts.outline] RGB of the boundary stroke, 0..255
   */
  function chPlot(opts) {
    var space = opts.space;
    var L = opts.L;
    var width = opts.width;
    var height = opts.height;
    var bounds = opts.bounds;
    var env = opts.envelope || OKColor.chromaEnvelope(space, L, opts.envelopeSamples || 720);
    var outline = opts.outline || [0, 0, 0];
    var img = buffer(width, height);
    var data = img.data;

    var srgbM = OKColor.spaces.srgb.lmsToLinear;
    var l0 = P[0] * L, m0 = P[3] * L, s0 = P[6] * L;
    var aMin = bounds.aMin, bMax = bounds.bMax;
    var stepA = (bounds.aMax - aMin) / width;      // chroma units per pixel, across
    var stepB = (bMax - bounds.bMin) / height;     // ...and down
    // Anti-aliasing works in pixels; when the two axes disagree, split the
    // difference rather than picking a side.
    var invScale = 2 / (stepA + stepB);
    // Nothing past the furthest corner of the window can be inside the hull.
    var limit = Math.max(
      Math.sqrt(bounds.aMin * bounds.aMin + bounds.bMin * bounds.bMin),
      Math.sqrt(bounds.aMin * bounds.aMin + bMax * bMax),
      Math.sqrt(bounds.aMax * bounds.aMax + bounds.bMin * bounds.bMin),
      Math.sqrt(bounds.aMax * bounds.aMax + bMax * bMax)
    ) + Math.max(stepA, stepB);
    var limitSq = limit * limit;
    var rgb = [0, 0, 0];
    var envN = env.length - 1;
    var envStep = envN / 360;

    for (var y = 0; y < height; y++) {
      var b = bMax - (y + 0.5) * stepB;
      var rowBase = y * width * 4;
      for (var x = 0; x < width; x++) {
        var a = aMin + (x + 0.5) * stepA;
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

  // ---------------------------------------------------------- plot overlays

  /** Source-over one sample onto the RGBA buffer, straight (unpremultiplied). */
  function blendPixel(data, i, rgb, alpha) {
    if (alpha <= 0) return;
    if (alpha > 1) alpha = 1;
    var dstA = data[i + 3] / 255;
    var outA = alpha + dstA * (1 - alpha);
    if (outA <= 0) return;
    var k = dstA * (1 - alpha);
    data[i] = (rgb[0] * alpha + data[i] * k) / outA;
    data[i + 1] = (rgb[1] * alpha + data[i + 1] * k) / outA;
    data[i + 2] = (rgb[2] * alpha + data[i + 2] * k) / outA;
    data[i + 3] = outA * 255;
  }

  /** Anti-aliased line segment of the given half-width. */
  function strokeSegment(img, x0, y0, x1, y1, radius, rgb, alpha) {
    var data = img.data;
    var minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
    var maxX = Math.min(img.width - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
    var minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
    var maxY = Math.min(img.height - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
    var dx = x1 - x0, dy = y1 - y0;
    var lenSq = dx * dx + dy * dy;

    for (var y = minY; y <= maxY; y++) {
      for (var x = minX; x <= maxX; x++) {
        var px = x + 0.5 - x0, py = y + 0.5 - y0;
        var t = lenSq > 0 ? clamp01((px * dx + py * dy) / lenSq) : 0;
        var ex = px - dx * t, ey = py - dy * t;
        var d = Math.sqrt(ex * ex + ey * ey);
        // One pixel of feather at the edge of the stroke.
        var cov = radius + 0.5 - d;
        if (cov <= 0) continue;
        blendPixel(data, (y * img.width + x) * 4, rgb, alpha * (cov > 1 ? 1 : cov));
      }
    }
  }

  function strokeDot(img, x, y, radius, rgb, alpha) {
    strokeSegment(img, x, y, x, y, radius, rgb, alpha);
  }

  var PATH_DARK = [20, 20, 20];
  var PATH_LIGHT = [255, 255, 255];

  /**
   * Draw a design's route across the C/H diagram onto an already-painted plot:
   * the whole ramp as one path, with a dot on each control point.  Chroma and
   * hue are the diagram's own coordinates, so the route is meaningful even
   * though every point on it belongs to a different lightness - which is also
   * why stretches of it fall outside the slice being shown.
   *
   * Stroked dark-then-light so it reads over any fill, in or out of gamut.
   *
   * @param {object} img            buffer from chPlot, modified in place
   * @param {object} opts
   * @param {Array} opts.path       [{C, H}] along the ramp, in order
   * @param {Array} [opts.marks]    [{C, H, selected}] control points
   * @param {object} opts.bounds    the same window chPlot was given
   */
  function pathOverlay(img, opts) {
    var bounds = opts.bounds;
    var path = opts.path || [];

    function place(p) {
      var f = markerFraction(p.C, p.H, bounds);
      return [f.x * img.width, f.y * img.height];
    }

    var pts = path.map(place);
    var i;
    for (i = 1; i < pts.length; i++) {
      strokeSegment(img, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 1.6, PATH_DARK, 0.55);
    }
    for (i = 1; i < pts.length; i++) {
      strokeSegment(img, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 0.6, PATH_LIGHT, 0.9);
    }

    (opts.marks || []).forEach(function (m) {
      if (m.selected) return; // the live marker is a DOM element, drawn over the top
      var q = place(m);
      strokeDot(img, q[0], q[1], 3.1, PATH_DARK, 0.7);
      strokeDot(img, q[0], q[1], 2.1, PATH_LIGHT, 0.95);
    });
    return img;
  }

  // ------------------------------------------------------- plot <-> geometry
  // The plot window maps `bounds` onto the element exactly, so a colour at
  // (C, H) sits at these fractions of it and back again.

  function markerFraction(C, H, bounds) {
    var h = H * DEG;
    var a = C * Math.cos(h), b = C * Math.sin(h);
    return {
      x: (a - bounds.aMin) / (bounds.aMax - bounds.aMin),
      y: (bounds.bMax - b) / (bounds.bMax - bounds.bMin)
    };
  }

  function fractionToCh(fx, fy, bounds) {
    var a = bounds.aMin + fx * (bounds.aMax - bounds.aMin);
    var b = bounds.bMax - fy * (bounds.bMax - bounds.bMin);
    var C = Math.sqrt(a * a + b * b);
    var H = Math.atan2(b, a) / DEG;
    if (H < 0) H += 360;
    return { C: C, H: H };
  }

  return {
    buffer: buffer,
    encode255: encode255,
    chPlot: chPlot,
    ramp: ramp,
    pathOverlay: pathOverlay,
    lightnessRamp: lightnessRamp,
    chromaRamp: chromaRamp,
    hueRamp: hueRamp,
    markerFraction: markerFraction,
    fractionToCh: fractionToCh
  };
});
