'use strict';
/*
 * Gradient-map design: a handful of OKLCH control points in, a Photoshop
 * gradient out.
 *
 * The model is built around one identity.  For a neutral pixel with linear
 * value `y`, OKLab lightness is exactly `L = y^(1/3)`, and that is exact in
 * every working space color.js knows about - a neutral maps to the space's own
 * white point, Bradford adaptation carries that onto D65 exactly, and both
 * OKLab matrices have rows summing to one.  So a grayscale painting hands us
 * its lightness directly, and a gradient map whose colour at position
 * `encode(L^3)` has OKLab lightness `L` preserves it.
 *
 * Chroma is stored *relative* to what the space can hold - `rho` in 0..1, a
 * fraction of `maxChroma(L, H)`.  That is what makes black stay black and white
 * stay white for free: the gamut's chroma limit goes to zero at both ends, so
 * the colour does too, with no pinned endpoints and no special cases.  It also
 * means a design can never ask for a colour the document cannot hold, so the
 * ramp has no clamping crease in it.
 *
 * Pure: no DOM, no Photoshop.  Loaded as a classic script under UXP and
 * required directly by the tests.
 */
(function (root, factory) {
  var dep = root.OKColor;
  if (!dep && typeof require === 'function' && typeof module === 'object') dep = require('./color.js');
  var api = factory(dep);
  root.OKGradient = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (OKColor) {

  var DEG = Math.PI / 180;

  /** Photoshop stores gradient stop positions as integers on this scale. */
  var LOCATION_SCALE = 4096;

  var MAX_POINTS = 8;
  /** Control points sit strictly inside the range; the ends are always neutral. */
  var L_MIN = 0.02;
  var L_MAX = 0.98;
  /** Two control points closer than this in L would make the spline singular. */
  var L_EPSILON = 0.01;

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function wrapHue(h) { h = h % 360; return h < 0 ? h + 360 : h; }

  // ------------------------------------------------------- lightness <-> position
  // Where along the gradient a given OKLab lightness lives, and back.  This is
  // the whole reason control points are placed in L and not on the gradient's
  // own axis: OKLab L = 0.5 is sRGB 99/255, not 128.

  function positionForL(space, L) {
    var t = clamp01(L);
    return clamp01(space.trc.encode(t * t * t));
  }

  function lForPosition(space, p) {
    return clamp01(Math.cbrt(Math.max(0, space.trc.decode(clamp01(p)))));
  }

  // ------------------------------------------------------------------ splines

  /**
   * Monotone cubic (Fritsch-Carlson) interpolant through (xs, ys).
   * Monotone rather than Catmull-Rom because overshoot here would mean chroma
   * the user never asked for, or a hue swinging past the one they picked.
   * Constant outside the data range, which is what carries the design out to
   * black and white.
   */
  function pchip(xs, ys) {
    var n = xs.length;
    if (n === 0) return function () { return 0; };
    if (n === 1) return function () { return ys[0]; };

    var h = new Array(n - 1);
    var d = new Array(n - 1);
    for (var i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i];
      d[i] = (ys[i + 1] - ys[i]) / h[i];
    }

    var m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (var k = 1; k < n - 1; k++) {
      if (d[k - 1] * d[k] <= 0) {
        m[k] = 0;
      } else {
        var w1 = 2 * h[k] + h[k - 1];
        var w2 = h[k] + 2 * h[k - 1];
        m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
      }
    }

    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (xs[mid] > x) hi = mid; else lo = mid;
      }
      var step = h[lo];
      var t = (x - xs[lo]) / step;
      var t2 = t * t, t3 = t2 * t;
      return ys[lo] * (2 * t3 - 3 * t2 + 1) +
             step * m[lo] * (t3 - 2 * t2 + t) +
             ys[lo + 1] * (-2 * t3 + 3 * t2) +
             step * m[lo + 1] * (t3 - t2);
    };
  }

  // --------------------------------------------------------------- the design

  /**
   * A design is `{points, amount, path}`:
   *   points  1..8 of `{L, rho, H}`, sorted by lightness
   *   amount  global multiplier on every rho, 0..2
   *   path    'direct' - interpolate the chroma vector, so opposite hues cross
   *                      through neutral rather than through whatever happens
   *                      to lie between them.  What a light/shadow ramp wants.
   *           'arc'    - interpolate chroma and hue angle, so the ramp sweeps
   *                      round the wheel at full chroma.  For deliberate
   *                      rainbow ramps.
   */

  function makePoint(L, rho, H) {
    return { L: clamp(L, L_MIN, L_MAX), rho: clamp01(rho), H: wrapHue(H) };
  }

  function clonePoint(p) { return { L: p.L, rho: p.rho, H: p.H }; }

  function cloneDesign(design) {
    return {
      points: design.points.map(clonePoint),
      amount: design.amount,
      path: design.path
    };
  }

  /** Sort, clamp and separate the control points so the spline is well posed. */
  function normalize(design) {
    var points = (design && design.points ? design.points : [])
      .filter(function (p) { return p && isFinite(p.L) && isFinite(p.rho) && isFinite(p.H); })
      .map(function (p) { return makePoint(p.L, p.rho, p.H); })
      .sort(function (a, b) { return a.L - b.L; })
      .slice(0, MAX_POINTS);

    if (!points.length) points = [makePoint(0.55, 0, 60)];

    // Nudge coincident points apart, then again from the top in case the first
    // pass pushed one past L_MAX.
    for (var i = 1; i < points.length; i++) {
      if (points[i].L - points[i - 1].L < L_EPSILON) points[i].L = points[i - 1].L + L_EPSILON;
    }
    for (var j = points.length - 1; j > 0; j--) {
      if (points[j].L > L_MAX) points[j].L = L_MAX;
      if (points[j].L - points[j - 1].L < L_EPSILON) points[j - 1].L = points[j].L - L_EPSILON;
    }
    points[0].L = Math.max(L_MIN, points[0].L);

    var amount = design && isFinite(design.amount) ? clamp(design.amount, 0, 2) : 1;
    var path = design && design.path === 'arc' ? 'arc' : 'direct';
    return { points: points, amount: amount, path: path };
  }

  /** Hue angles rewritten so each is on the branch nearest its predecessor. */
  function unwrapHues(hues) {
    var out = [hues[0]];
    for (var i = 1; i < hues.length; i++) {
      var prev = out[i - 1];
      var h = hues[i];
      out.push(h + 360 * Math.round((prev - h) / 360));
    }
    return out;
  }

  /**
   * The design as two curves over lightness: relative chroma and hue.
   * Everything downstream goes through this.
   */
  function curveFor(design) {
    var points = design.points;
    var xs = points.map(function (p) { return p.L; });
    var amount = design.amount;

    if (design.path === 'arc') {
      var fRho = pchip(xs, points.map(function (p) { return p.rho; }));
      var fHue = pchip(xs, unwrapHues(points.map(function (p) { return p.H; })));
      return function (L) {
        return { rho: clamp01(fRho(L) * amount), H: wrapHue(fHue(L)) };
      };
    }

    var fA = pchip(xs, points.map(function (p) { return p.rho * Math.cos(p.H * DEG); }));
    var fB = pchip(xs, points.map(function (p) { return p.rho * Math.sin(p.H * DEG); }));
    var fallbackHue = points[0].H;
    return function (L) {
      var a = fA(L), b = fB(L);
      var rho = Math.sqrt(a * a + b * b);
      // Per-component monotone interpolation bounds each component but not the
      // vector's length, so the one clamp the direct path needs is here.
      return {
        rho: clamp01(rho * amount),
        H: rho < 1e-9 ? fallbackHue : wrapHue(Math.atan2(b, a) / DEG)
      };
    };
  }

  /** Everything about the ramp at one lightness. */
  function sampleAt(curve, space, L) {
    var v = curve(L);
    var cMax = OKColor.maxChroma(space, L, v.H, 22);
    return { L: L, rho: v.rho, H: v.H, C: v.rho * cMax, cMax: cMax };
  }

  /** Document-encoded RGB, 0..1, of one point on the ramp. */
  function encodedAt(space, L, C, H) {
    var lin = OKColor.oklchToLinear(space, L, C, H);
    return OKColor.encodeChannels(space, [clamp01(lin[0]), clamp01(lin[1]), clamp01(lin[2])]);
  }

  // ------------------------------------------------------- gradient sampling
  // Which of Photoshop's three interpolation methods is in force changes what
  // happens *between* stops.  Rather than bet on one, the stop set is refined
  // until all three agree with the design, so the result is the same whichever
  // one the host applies.

  var METHODS = ['classic', 'perceptual', 'linear'];

  /**
   * A function from gradient position to document-encoded RGB, reproducing how
   * Photoshop reads a stop list.
   *
   *   classic     straight interpolation of the encoded values
   *   perceptual  interpolation in OKLab (Photoshop's default since 2023)
   *   linear      interpolation of linear-light values
   */
  function sampler(stops, space, method) {
    var n = stops.length;
    var xs = new Float64Array(n);
    var vs = [];
    for (var i = 0; i < n; i++) {
      xs[i] = stops[i].location / LOCATION_SCALE;
      var enc = stops[i].encoded;
      if (method === 'classic') {
        vs.push([enc[0], enc[1], enc[2]]);
      } else {
        var lin = OKColor.decodeChannels(space, enc);
        vs.push(method === 'linear' ? lin : OKColor.linearToOklab(space, lin[0], lin[1], lin[2]));
      }
    }

    return function (p) {
      if (p <= xs[0]) return finish(vs[0]);
      if (p >= xs[n - 1]) return finish(vs[n - 1]);
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (xs[mid] > p) hi = mid; else lo = mid;
      }
      var span = xs[lo + 1] - xs[lo];
      var t = span > 0 ? (p - xs[lo]) / span : 0;
      var a = vs[lo], b = vs[lo + 1];
      return finish([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
      ]);
    };

    function finish(v) {
      if (method === 'classic') return v;
      var lin = method === 'linear' ? v : OKColor.oklabToLinear(space, v[0], v[1], v[2]);
      return OKColor.encodeChannels(space, [clamp01(lin[0]), clamp01(lin[1]), clamp01(lin[2])]);
    }
  }

  /** OKLab of a document-encoded RGB triple. */
  function labOf(space, enc) {
    var lin = OKColor.decodeChannels(space, enc);
    return OKColor.linearToOklab(space, lin[0], lin[1], lin[2]);
  }

  function deltaE(a, b) {
    var dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }

  /**
   * The design evaluated at a grid of gradient positions - what the stops have
   * to reproduce.  Independent of the stops, so the refinement loop below
   * computes it once.
   */
  function reference(design, space, count) {
    var curve = curveFor(design);
    var out = [];
    for (var i = 0; i < count; i++) {
      var p = i / (count - 1);
      var L = lForPosition(space, p);
      var s = sampleAt(curve, space, L);
      out.push({ p: p, L: L, lab: OKColor.oklchToOklab(s.L, s.C, s.H) });
    }
    return out;
  }

  /**
   * One stop, addressed by the position it will occupy rather than by
   * lightness.  Positions are integers on a 0..4096 scale, so deriving the
   * colour from the rounded position instead of rounding the position of a
   * chosen colour is what keeps a neutral stop exactly `(g, g, g)` at exactly
   * `4096 * g` - and so keeps the neutral part of the ramp exactly on the
   * diagonal, where straight interpolation reproduces it for free.
   */
  function stopAt(curve, space, location) {
    location = clamp(Math.round(location), 0, LOCATION_SCALE);
    var grey = location / LOCATION_SCALE;
    var L = lForPosition(space, grey);
    var s = sampleAt(curve, space, L);
    return {
      L: L, C: s.C, H: s.H, rho: s.rho,
      location: location,
      // A colourless stop is written down rather than computed.  Its encoded
      // value is the position it sits at, by construction, and saying so keeps
      // the two ends exactly black and exactly white instead of a millionth
      // short of them - the OKLab matrices only round-trip to about 1e-7.
      encoded: s.C > 0 ? encodedAt(space, L, s.C, s.H) : [grey, grey, grey]
    };
  }

  /**
   * How far a stop list strays from the design, measured in OKLab and broken
   * down per stop interval so the refinement below knows where to look.
   * `methods` is every interpolation rule the result has to survive.
   */
  function worstError(stops, space, refs, methods) {
    var samplers = methods.map(function (m) { return sampler(stops, space, m); });
    var perSegment = new Float64Array(Math.max(1, stops.length - 1));
    var maxE = 0, maxL = 0;
    var xs = stops.map(function (s) { return s.location / LOCATION_SCALE; });

    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      // Which stop interval this reference falls in.
      var lo = 0;
      while (lo < xs.length - 2 && xs[lo + 1] < r.p) lo++;
      for (var k = 0; k < samplers.length; k++) {
        var lab = labOf(space, samplers[k](r.p));
        var e = deltaE(lab, r.lab);
        var dl = Math.abs(lab[0] - r.lab[0]);
        if (e > perSegment[lo]) perSegment[lo] = e;
        if (e > maxE) maxE = e;
        if (dl > maxL) maxL = dl;
      }
    }
    return { deltaE: maxE, deltaL: maxL, perSegment: perSegment };
  }

  var DEFAULTS = {
    stops: 33,        // uniform in L, before refinement
    maxStops: 64,     // ceiling on the refinement
    budget: 0.002,    // target max OKLab dE - half an 8-bit step in the midtones
    samples: 513      // reference grid, a superset of the 8-bit input levels
  };

  /**
   * The design as a Photoshop stop list.
   *
   * Stops start uniform in L - which is close to uniform in gradient position
   * above the deep shadows, and puts extra resolution exactly where the
   * transfer curve is steep - plus one on each control point so the user's own
   * values land exactly.  Then the worst segment is bisected until every
   * interpolation method reproduces the design to within `budget`.
   *
   * Note what happens at rho = 0: the encoded colour is exactly `(g, g, g)` and
   * the location is exactly `4096 * g`, so the neutral part of the ramp lies on
   * the diagonal and is reproduced exactly at any stop count.  All the error
   * being refined away here is chromatic.
   */
  function buildStops(design, space, opts) {
    opts = opts || {};
    var budget = opts.budget === undefined ? DEFAULTS.budget : opts.budget;
    var cap = opts.maxStops || DEFAULTS.maxStops;
    var count = Math.max(2, opts.stops || DEFAULTS.stops);
    var methods = opts.methods || METHODS;
    var curve = curveFor(design);

    var seeds = [];
    for (var i = 0; i < count; i++) seeds.push(positionForL(space, i / (count - 1)));
    design.points.forEach(function (p) { seeds.push(positionForL(space, p.L)); });

    var stops = dedupe(seeds.map(function (p) { return Math.round(p * LOCATION_SCALE); }))
      .map(function (location) { return stopAt(curve, space, location); });
    // Measuring costs more than building, and a drag wants the cheap answer:
    // the seed set alone is already well inside a visible difference, and the
    // refined set follows when the drag ends.
    if (opts.measure === false) return { stops: stops, error: null };
    var refs = reference(design, space, opts.samples || DEFAULTS.samples);
    var error = worstError(stops, space, refs, methods);

    while (error.deltaE > budget && stops.length < cap) {
      // The worst interval that is still wide enough to hold another stop.
      // Down in the shadows a whole stretch of lightness maps into a single
      // unit of position, and splitting there cannot help - so skip those
      // rather than giving up on the intervals that can still be improved.
      var seg = -1, worst = 0;
      for (var s = 0; s < stops.length - 1; s++) {
        if (stops[s + 1].location - stops[s].location <= 1) continue;
        if (error.perSegment[s] > worst) { worst = error.perSegment[s]; seg = s; }
      }
      // Nothing splittable left, or nothing left worth splitting.  Some
      // designs also keep a small residue that stops cannot reach at all: down
      // where the linear values are the same order as the epsilon maxChroma
      // tests the gamut with, the chroma it returns is a shade optimistic and
      // the clamp in encodedAt takes some of it back.  That lands at L = 0.01,
      // below the darkest level an 8-bit document can hold.
      if (seg < 0) break;
      stops.splice(seg + 1, 0,
        stopAt(curve, space, (stops[seg].location + stops[seg + 1].location) / 2));
      error = worstError(stops, space, refs, methods);
    }

    return { stops: stops, error: error };
  }

  /** Sorted, with duplicates removed - stop positions are integers and two
   *  seeds in the deep shadows routinely round to the same one. */
  function dedupe(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      if (!out.length || sorted[i] !== out[out.length - 1]) out.push(sorted[i]);
    }
    return out;
  }

  // -------------------------------------------------------------- round trip
  // The design travels with the layer in the gradient's own name, so reopening
  // a document gets you the control points back rather than a stop list nobody
  // can edit.  Deliberately plain text: it shows up in Photoshop's Gradient
  // Editor, and something readable there beats an opaque blob.

  var TAG = 'okg1';

  function encodeDesign(design) {
    var d = normalize(design);
    var body = d.points.map(function (p) {
      return p.L.toFixed(3) + ',' + p.rho.toFixed(3) + ',' + p.H.toFixed(1);
    }).join(';');
    return TAG + ':' + d.amount.toFixed(3) + ':' + d.path + ':' + body;
  }

  function decodeDesign(text) {
    if (typeof text !== 'string') return null;
    var parts = text.split(':');
    if (parts.length < 4 || parts[0] !== TAG) return null;
    var points = parts[3].split(';').map(function (chunk) {
      var f = chunk.split(',').map(parseFloat);
      if (f.length !== 3 || !f.every(isFinite)) return null;
      return { L: f[0], rho: f[1], H: f[2] };
    });
    if (points.some(function (p) { return !p; })) return null;
    return normalize({ points: points, amount: parseFloat(parts[1]), path: parts[2] });
  }

  // ----------------------------------------------------------------- presets
  // Lighting conditions rather than colour schemes: what a grayscale painting
  // should look like once the light in the scene is put back into it.  Each is
  // three control points - shadow, midtone, highlight - and the endpoints look
  // after themselves.  Everyday light comes first, then the stranger sort.
  //
  // Chroma is relative, so 1.0 is the gamut wall: the everyday conditions sit
  // between a third and three quarters of the way out, and the strange ones go
  // most of the way.

  function P(L, rho, H) { return { L: L, rho: rho, H: H }; }

  function preset(id, label, path, amount, points) {
    return { id: id, label: label,
             design: { points: points, amount: amount, path: path } };
  }

  var PRESETS = [
    // ---------------------------------------------------------- everyday light
    preset('neutral', 'Neutral', 'direct', 1,
      [P(0.25, 0, 260), P(0.55, 0, 60), P(0.84, 0, 90)]),
    preset('daylight', 'Daylight', 'direct', 1,
      [P(0.25, 0.62, 262), P(0.55, 0.50, 58), P(0.84, 0.44, 92)]),
    preset('goldenhour', 'Golden hour', 'direct', 1,
      [P(0.24, 0.60, 295), P(0.54, 0.85, 45), P(0.83, 0.72, 76)]),
    preset('overcast', 'Overcast', 'direct', 1,
      [P(0.26, 0.42, 255), P(0.55, 0.26, 240), P(0.84, 0.20, 230)]),
    preset('openshade', 'Open shade', 'direct', 1,
      [P(0.25, 0.62, 252), P(0.55, 0.46, 246), P(0.84, 0.32, 238)]),
    preset('tungsten', 'Tungsten', 'direct', 1,
      [P(0.25, 0.46, 268), P(0.55, 0.66, 52), P(0.84, 0.58, 72)]),
    preset('candle', 'Candlelight', 'direct', 1,
      [P(0.24, 0.70, 22), P(0.53, 0.92, 48), P(0.83, 0.72, 84)]),
    preset('moonlight', 'Moonlight', 'direct', 1,
      [P(0.25, 0.58, 276), P(0.55, 0.48, 252), P(0.84, 0.28, 236)]),
    preset('studio', 'Studio', 'direct', 1,
      [P(0.25, 0.28, 258), P(0.55, 0.32, 34), P(0.84, 0.22, 62)]),
    preset('dusk', 'Dusk', 'direct', 1,
      [P(0.24, 0.60, 288), P(0.54, 0.62, 340), P(0.84, 0.56, 52)]),
    preset('fluorescent', 'Fluorescent', 'direct', 1,
      [P(0.25, 0.48, 350), P(0.55, 0.44, 128), P(0.84, 0.34, 122)]),
    preset('sepia', 'Sepia', 'direct', 1,
      [P(0.25, 0.44, 50), P(0.55, 0.52, 62), P(0.84, 0.40, 80)]),
    preset('cyanotype', 'Cyanotype', 'direct', 1,
      [P(0.24, 0.66, 258), P(0.55, 0.70, 244), P(0.84, 0.50, 230)]),

    // ----------------------------------------------------------- stranger light
    preset('sodium', 'Sodium vapour', 'direct', 1,
      [P(0.24, 0.78, 48), P(0.55, 1.00, 58), P(0.84, 0.88, 66)]),
    preset('neon', 'Neon', 'arc', 1,
      [P(0.24, 0.92, 322), P(0.54, 0.80, 288), P(0.83, 0.88, 208)]),
    preset('underwater', 'Underwater', 'arc', 1,
      [P(0.25, 0.68, 240), P(0.55, 0.80, 196), P(0.84, 0.55, 172)]),
    preset('bioluminescent', 'Bioluminescent', 'arc', 1,
      [P(0.22, 0.62, 262), P(0.52, 0.95, 186), P(0.82, 0.76, 156)]),
    preset('blacklight', 'Blacklight', 'arc', 1,
      [P(0.22, 0.85, 300), P(0.52, 0.92, 322), P(0.82, 0.82, 250)]),
    preset('forge', 'Forge', 'direct', 1,
      [P(0.22, 0.50, 280), P(0.52, 1.00, 30), P(0.86, 0.80, 92)]),
    preset('toxic', 'Toxic', 'direct', 1,
      [P(0.24, 0.70, 265), P(0.54, 0.92, 130), P(0.84, 0.82, 114)]),
    preset('aurora', 'Aurora', 'arc', 1,
      [P(0.24, 0.66, 286), P(0.54, 0.90, 156), P(0.84, 0.62, 188)]),
    preset('screenglow', 'Screen glow', 'direct', 1,
      [P(0.24, 0.52, 5), P(0.54, 0.70, 232), P(0.84, 0.70, 208)]),
    preset('infrared', 'Infrared', 'arc', 1,
      [P(0.24, 0.66, 250), P(0.54, 0.85, 350), P(0.84, 0.66, 330)]),
    preset('deepspace', 'Deep space', 'direct', 1,
      [P(0.20, 0.60, 292), P(0.52, 0.52, 262), P(0.86, 0.30, 228)]),
    preset('stage', 'Stage', 'arc', 1,
      [P(0.24, 0.82, 262), P(0.54, 0.58, 310), P(0.84, 0.78, 58)])
  ];

  var PRESET_BY_ID = {};
  PRESETS.forEach(function (p) { PRESET_BY_ID[p.id] = p; });

  function presetDesign(id) {
    var p = PRESET_BY_ID[id];
    return p ? normalize(cloneDesign(p.design)) : null;
  }

  function defaultDesign() { return presetDesign('daylight'); }

  /** Does this design match a preset, stop for stop?  Drives the picker's label. */
  function matchPreset(design) {
    var text = encodeDesign(design);
    for (var i = 0; i < PRESETS.length; i++) {
      if (encodeDesign(PRESETS[i].design) === text) return PRESETS[i].id;
    }
    return null;
  }

  return {
    LOCATION_SCALE: LOCATION_SCALE,
    MAX_POINTS: MAX_POINTS,
    L_MIN: L_MIN,
    L_MAX: L_MAX,
    METHODS: METHODS,
    DEFAULTS: DEFAULTS,

    positionForL: positionForL,
    lForPosition: lForPosition,
    pchip: pchip,

    makePoint: makePoint,
    cloneDesign: cloneDesign,
    normalize: normalize,
    unwrapHues: unwrapHues,
    curveFor: curveFor,
    sampleAt: sampleAt,
    encodedAt: encodedAt,

    sampler: sampler,
    labOf: labOf,
    deltaE: deltaE,
    reference: reference,
    worstError: worstError,
    buildStops: buildStops,

    encodeDesign: encodeDesign,
    decodeDesign: decodeDesign,

    PRESETS: PRESETS,
    presetDesign: presetDesign,
    defaultDesign: defaultDesign,
    matchPreset: matchPreset
  };
});
