'use strict';
/*
 * OKLCH <-> RGB working space colour maths.
 *
 * Everything here is pure (no DOM, no Photoshop) so it can be unit tested with
 * plain node.  The module is written as a UMD-ish blob because UXP loads plugin
 * scripts as classic scripts, not ES modules.
 */
(function (root, factory) {
  var api = factory();
  root.OKColor = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---------------------------------------------------------------- matrices
  // 3x3 matrices are flat, row-major, length 9.

  function matMul(a, b) {
    var o = new Array(9);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return o;
  }

  function matVec(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
    ];
  }

  function matInv(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (!det) throw new Error('singular matrix');
    var s = 1 / det;
    return [
      A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
      B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
      C * s, -(a * h - b * g) * s, (a * e - b * d) * s
    ];
  }

  function matDiag(v) {
    return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
  }

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // ------------------------------------------------------ white points / CAT

  var WHITE = {
    D65: [0.3127, 0.3290],
    D50: [0.3457, 0.3585]
  };

  function xyToXyz(xy) {
    var x = xy[0], y = xy[1];
    return [x / y, 1, (1 - x - y) / y];
  }

  // Bradford chromatic adaptation, the transform Photoshop / ICC use by default.
  var BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  var BRADFORD_INV = matInv(BRADFORD);

  function adaptationMatrix(srcXy, dstXy) {
    var s = matVec(BRADFORD, xyToXyz(srcXy));
    var d = matVec(BRADFORD, xyToXyz(dstXy));
    return matMul(BRADFORD_INV, matMul(matDiag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), BRADFORD));
  }

  // Linear RGB -> XYZ (of the space's own white point), the usual Lindbloom
  // construction from chromaticity coordinates.
  function rgbToXyzMatrix(prim, whiteXy) {
    var r = xyToXyz(prim.r), g = xyToXyz(prim.g), b = xyToXyz(prim.b);
    var M = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
    var S = matVec(matInv(M), xyToXyz(whiteXy));
    return [
      r[0] * S[0], g[0] * S[1], b[0] * S[2],
      r[1] * S[0], g[1] * S[1], b[1] * S[2],
      r[2] * S[0], g[2] * S[1], b[2] * S[2]
    ];
  }

  // ------------------------------------------------------- transfer functions

  function signed(fn) {
    return function (x) { return x < 0 ? -fn(-x) : fn(x); };
  }

  function gammaTrc(g) {
    return {
      name: 'gamma ' + g,
      encode: signed(function (x) { return Math.pow(x, 1 / g); }),
      decode: signed(function (x) { return Math.pow(x, g); })
    };
  }

  var REC2020_A = 1.09929682680944;
  var REC2020_B = 0.018053968510807;

  var TRC = {
    srgb: {
      name: 'sRGB',
      encode: signed(function (x) {
        return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      }),
      decode: signed(function (x) {
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      })
    },
    prophoto: {
      name: 'ROMM',
      encode: signed(function (x) {
        return x < 1 / 512 ? 16 * x : Math.pow(x, 1 / 1.8);
      }),
      decode: signed(function (x) {
        return x < 16 / 512 ? x / 16 : Math.pow(x, 1.8);
      })
    },
    rec2020: {
      name: 'Rec.2020',
      encode: signed(function (x) {
        return x < REC2020_B ? 4.5 * x : REC2020_A * Math.pow(x, 0.45) - (REC2020_A - 1);
      }),
      decode: signed(function (x) {
        return x < 4.5 * REC2020_B ? x / 4.5 : Math.pow((x + (REC2020_A - 1)) / REC2020_A, 1 / 0.45);
      })
    },
    lstar: {
      name: 'L*',
      encode: signed(function (x) {
        return x <= 216 / 24389 ? x * 24389 / 2700 : 1.16 * Math.cbrt(x) - 0.16;
      }),
      decode: signed(function (x) {
        return x <= 0.08 ? x * 2700 / 24389 : Math.pow((x + 0.16) / 1.16, 3);
      })
    },
    gamma18: gammaTrc(1.8),
    gamma22: gammaTrc(2.2),
    // Adobe RGB (1998) and Wide Gamut RGB are 563/256 == 2.19921875.
    adobe: gammaTrc(563 / 256)
  };

  // ----------------------------------------------------------- RGB workspaces

  var SPACE_DEFS = [
    {
      id: 'srgb', label: 'sRGB', white: 'D65', trc: TRC.srgb,
      primaries: { r: [0.6400, 0.3300], g: [0.3000, 0.6000], b: [0.1500, 0.0600] }
    },
    {
      id: 'p3', label: 'Display P3', white: 'D65', trc: TRC.srgb,
      primaries: { r: [0.6800, 0.3200], g: [0.2650, 0.6900], b: [0.1500, 0.0600] }
    },
    {
      id: 'adobe1998', label: 'Adobe RGB (1998)', white: 'D65', trc: TRC.adobe,
      primaries: { r: [0.6400, 0.3300], g: [0.2100, 0.7100], b: [0.1500, 0.0600] }
    },
    {
      id: 'prophoto', label: 'ProPhoto RGB', white: 'D50', trc: TRC.prophoto,
      primaries: { r: [0.734699, 0.265301], g: [0.159597, 0.840403], b: [0.036598, 0.000105] }
    },
    {
      id: 'rec2020', label: 'Rec. 2020', white: 'D65', trc: TRC.rec2020,
      primaries: { r: [0.708, 0.292], g: [0.170, 0.797], b: [0.131, 0.046] }
    },
    {
      id: 'widegamut', label: 'Wide Gamut RGB', white: 'D50', trc: TRC.adobe,
      primaries: { r: [0.7347, 0.2653], g: [0.1152, 0.8264], b: [0.1566, 0.0177] }
    },
    {
      id: 'apple', label: 'Apple RGB', white: 'D65', trc: TRC.gamma18,
      primaries: { r: [0.6250, 0.3400], g: [0.2800, 0.5950], b: [0.1550, 0.0700] }
    },
    {
      id: 'colormatch', label: 'ColorMatch RGB', white: 'D50', trc: TRC.gamma18,
      primaries: { r: [0.6300, 0.3400], g: [0.2950, 0.6050], b: [0.1500, 0.0750] }
    },
    {
      id: 'ecirgb', label: 'eciRGB v2', white: 'D50', trc: TRC.lstar,
      primaries: { r: [0.6700, 0.3300], g: [0.2100, 0.7100], b: [0.1400, 0.0800] }
    },
    {
      id: 'rec709', label: 'Rec. 709', white: 'D65', trc: TRC.rec2020,
      primaries: { r: [0.6400, 0.3300], g: [0.3000, 0.6000], b: [0.1500, 0.0600] }
    }
  ];

  // OKLab constants (Björn Ottosson).  M1 maps linear sRGB to cone-ish LMS,
  // M2 maps the cube roots of LMS to OKLab.  The inverses are derived rather
  // than hard-coded so that round trips are exact to float precision.
  var LMS_FROM_LINEAR_SRGB = [
    0.4122214708, 0.5363325363, 0.0514459929,
    0.2119034982, 0.6806995451, 0.1073969566,
    0.0883024619, 0.2817188376, 0.6299787005
  ];
  var OKLAB_FROM_LMS_ROOT = [
    0.2104542553, 0.7936177850, -0.0040720468,
    1.9779984951, -2.4285922050, 0.4505937099,
    0.0259040371, 0.7827717662, -0.8086757660
  ];
  var LINEAR_SRGB_FROM_LMS = matInv(LMS_FROM_LINEAR_SRGB);
  var LMS_ROOT_FROM_OKLAB = matInv(OKLAB_FROM_LMS_ROOT);

  var spaces = {};
  var spaceList = [];

  SPACE_DEFS.forEach(function (def) {
    var whiteXy = WHITE[def.white];
    var sp = {
      id: def.id,
      label: def.label,
      whiteName: def.white,
      whiteXy: whiteXy,
      trc: def.trc,
      primaries: def.primaries
    };
    sp.toXyz = rgbToXyzMatrix(def.primaries, whiteXy);
    sp.fromXyz = matInv(sp.toXyz);
    spaces[def.id] = sp;
    spaceList.push(sp);
  });

  var SRGB = spaces.srgb;
  var LINEAR_SRGB_TO_XYZ_D65 = SRGB.toXyz;
  var XYZ_D65_TO_LINEAR_SRGB = SRGB.fromXyz;

  spaceList.forEach(function (sp) {
    var toD65 = adaptationMatrix(sp.whiteXy, WHITE.D65);
    var fromD65 = adaptationMatrix(WHITE.D65, sp.whiteXy);
    sp.linearToXyzD65 = matMul(toD65, sp.toXyz);
    sp.xyzD65ToLinear = matMul(sp.fromXyz, fromD65);
    // Collapse OKLab-LMS -> linear space RGB into a single matrix; the per-pixel
    // rendering loops lean on this hard.
    sp.lmsToLinear = matMul(sp.xyzD65ToLinear, matMul(LINEAR_SRGB_TO_XYZ_D65, LINEAR_SRGB_FROM_LMS));
    sp.linearToLms = matInv(sp.lmsToLinear);
  });

  var D65_TO_D50 = adaptationMatrix(WHITE.D65, WHITE.D50);
  var D50_TO_D65 = adaptationMatrix(WHITE.D50, WHITE.D65);
  var D50_XYZ = xyToXyz(WHITE.D50);

  // --------------------------------------------------------------- OKLab core

  var DEG = Math.PI / 180;

  function oklchToOklab(L, C, H) {
    var h = H * DEG;
    return [L, C * Math.cos(h), C * Math.sin(h)];
  }

  function oklabToOklch(L, a, b) {
    var C = Math.sqrt(a * a + b * b);
    var H = Math.atan2(b, a) / DEG;
    if (H < 0) H += 360;
    if (C < 1e-9) H = 0;
    return [L, C, H];
  }

  /** OKLab -> linear RGB of `space` (values outside [0,1] mean out of gamut). */
  function oklabToLinear(space, L, a, b) {
    var P = LMS_ROOT_FROM_OKLAB, M = space.lmsToLinear;
    var l = P[0] * L + P[1] * a + P[2] * b;
    var m = P[3] * L + P[4] * a + P[5] * b;
    var s = P[6] * L + P[7] * a + P[8] * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return [
      M[0] * l + M[1] * m + M[2] * s,
      M[3] * l + M[4] * m + M[5] * s,
      M[6] * l + M[7] * m + M[8] * s
    ];
  }

  function linearToOklab(space, r, g, b) {
    var M = space.linearToLms, Q = OKLAB_FROM_LMS_ROOT;
    var l = Math.cbrt(M[0] * r + M[1] * g + M[2] * b);
    var m = Math.cbrt(M[3] * r + M[4] * g + M[5] * b);
    var s = Math.cbrt(M[6] * r + M[7] * g + M[8] * b);
    return [
      Q[0] * l + Q[1] * m + Q[2] * s,
      Q[3] * l + Q[4] * m + Q[5] * s,
      Q[6] * l + Q[7] * m + Q[8] * s
    ];
  }

  function oklchToLinear(space, L, C, H) {
    var lab = oklchToOklab(L, C, H);
    return oklabToLinear(space, lab[0], lab[1], lab[2]);
  }

  function linearToOklch(space, r, g, b) {
    var lab = linearToOklab(space, r, g, b);
    return oklabToOklch(lab[0], lab[1], lab[2]);
  }

  // ------------------------------------------------------------------- gamut

  var GAMUT_EPS = 1e-6;

  function inGamutLinear(rgb, eps) {
    if (eps === undefined) eps = GAMUT_EPS;
    var lo = -eps, hi = 1 + eps;
    return rgb[0] >= lo && rgb[0] <= hi &&
           rgb[1] >= lo && rgb[1] <= hi &&
           rgb[2] >= lo && rgb[2] <= hi;
  }

  function inGamut(space, L, C, H, eps) {
    return inGamutLinear(oklchToLinear(space, L, C, H), eps);
  }

  /**
   * Largest chroma that still fits inside `space` for the given L and hue.
   * Bisection on the (star-shaped in C) gamut body.
   */
  function maxChroma(space, L, H, iterations) {
    if (!(L > 0) || L >= 1) return 0;
    var h = H * DEG, cos = Math.cos(h), sin = Math.sin(h);
    var P = LMS_ROOT_FROM_OKLAB, M = space.lmsToLinear;
    // Inlined oklab->linear for speed: this runs a few hundred thousand times
    // per full-quality repaint.
    var pl0 = P[0] * L, pl1 = P[1] * cos + P[2] * sin;
    var pm0 = P[3] * L, pm1 = P[4] * cos + P[5] * sin;
    var ps0 = P[6] * L, ps1 = P[7] * cos + P[8] * sin;
    var lo = -GAMUT_EPS, hi = 1 + GAMUT_EPS;

    function fits(C) {
      var l = pl0 + pl1 * C, m = pm0 + pm1 * C, s = ps0 + ps1 * C;
      l = l * l * l; m = m * m * m; s = s * s * s;
      var r0 = M[0] * l + M[1] * m + M[2] * s;
      if (r0 < lo || r0 > hi) return false;
      var r1 = M[3] * l + M[4] * m + M[5] * s;
      if (r1 < lo || r1 > hi) return false;
      var r2 = M[6] * l + M[7] * m + M[8] * s;
      return r2 >= lo && r2 <= hi;
    }

    // Widen the bracket first: ProPhoto's imaginary primaries reach past C = 1.4.
    var a = 0, b = 0.4;
    for (var g = 0; g < 10 && fits(b); g++) { a = b; b *= 2; }
    if (fits(b)) return b;
    var n = iterations || 22;
    for (var i = 0; i < n; i++) {
      var mid = (a + b) * 0.5;
      if (fits(mid)) a = mid; else b = mid;
    }
    return a;
  }

  /** Biggest chroma anywhere in the space; used to scale the C axis. Cached. */
  function spaceMaxChroma(space) {
    if (space._maxChroma !== undefined) return space._maxChroma;
    var best = 0;
    for (var li = 1; li < 100; li++) {
      var L = li / 100;
      for (var hi2 = 0; hi2 < 360; hi2 += 2) {
        var c = maxChroma(space, L, hi2, 14);
        if (c > best) best = c;
      }
    }
    space._maxChroma = best;
    return best;
  }

  /**
   * Chroma limit per hue at a fixed L, sampled on a regular grid.
   * Returns a Float64Array of `samples + 1` entries (last == first) so callers
   * can interpolate without wrapping logic.
   */
  function chromaEnvelope(space, L, samples, iterations) {
    samples = samples || 720;
    var out = new Float64Array(samples + 1);
    for (var i = 0; i < samples; i++) {
      out[i] = maxChroma(space, L, i * 360 / samples, iterations || 20);
    }
    out[samples] = out[0];
    return out;
  }

  function envelopeAt(env, hDeg) {
    var n = env.length - 1;
    var t = hDeg / 360 * n;
    if (!(t >= 0)) t = 0;
    if (t >= n) t -= n * Math.floor(t / n);
    var i = t | 0;
    var f = t - i;
    return env[i] + (env[i + 1] - env[i]) * f;
  }

  // --------------------------------------------------------- encode / display

  function encodeChannels(space, lin) {
    var e = space.trc.encode;
    return [e(lin[0]), e(lin[1]), e(lin[2])];
  }

  function decodeChannels(space, enc) {
    var d = space.trc.decode;
    return [d(enc[0]), d(enc[1]), d(enc[2])];
  }

  function to255(v) { return Math.round(clamp01(v) * 255); }

  function hexOf(enc) {
    var s = '#';
    for (var i = 0; i < 3; i++) {
      var h = to255(enc[i]).toString(16);
      s += h.length < 2 ? '0' + h : h;
    }
    return s.toUpperCase();
  }

  function parseHex(text) {
    if (typeof text !== 'string') return null;
    var m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(text);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255
    ];
  }

  /** OKLCH straight to 8-bit sRGB for on-screen painting (clamped). */
  function oklchToSrgb255(L, C, H) {
    var lin = oklchToLinear(SRGB, L, C, H);
    var e = TRC.srgb.encode;
    return [
      Math.round(clamp01(e(clamp01(lin[0]))) * 255),
      Math.round(clamp01(e(clamp01(lin[1]))) * 255),
      Math.round(clamp01(e(clamp01(lin[2]))) * 255)
    ];
  }

  /** Linear RGB in `space` -> 8-bit sRGB for on-screen painting (clamped). */
  function linearToSrgb255(space, lin) {
    var srgbLin = space === SRGB
      ? lin
      : matVec(XYZ_D65_TO_LINEAR_SRGB, matVec(space.linearToXyzD65, lin));
    var e = TRC.srgb.encode;
    return [
      Math.round(clamp01(e(clamp01(srgbLin[0]))) * 255),
      Math.round(clamp01(e(clamp01(srgbLin[1]))) * 255),
      Math.round(clamp01(e(clamp01(srgbLin[2]))) * 255)
    ];
  }

  // ------------------------------------------------------------- CIE Lab (D50)
  // Photoshop's Lab is D50-referred, which is what we hand to batchPlay so the
  // colour is applied independently of the document's working space.

  function labF(t) {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  }

  function labFInv(t) {
    var t3 = t * t * t;
    return t3 > 216 / 24389 ? t3 : (116 * t - 16) * 27 / 24389;
  }

  function xyzD50ToLab(xyz) {
    var fx = labF(xyz[0] / D50_XYZ[0]);
    var fy = labF(xyz[1] / D50_XYZ[1]);
    var fz = labF(xyz[2] / D50_XYZ[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToXyzD50(lab) {
    var fy = (lab[0] + 16) / 116;
    var fx = fy + lab[1] / 500;
    var fz = fy - lab[2] / 200;
    return [labFInv(fx) * D50_XYZ[0], labFInv(fy) * D50_XYZ[1], labFInv(fz) * D50_XYZ[2]];
  }

  function oklabToXyzD65(L, a, b) {
    return matVec(LINEAR_SRGB_TO_XYZ_D65, oklabToLinear(SRGB, L, a, b));
  }

  function xyzD65ToOklab(xyz) {
    var lin = matVec(XYZ_D65_TO_LINEAR_SRGB, xyz);
    return linearToOklab(SRGB, lin[0], lin[1], lin[2]);
  }

  function oklchToLabD50(L, C, H) {
    var lab = oklchToOklab(L, C, H);
    return xyzD50ToLab(matVec(D65_TO_D50, oklabToXyzD65(lab[0], lab[1], lab[2])));
  }

  function labD50ToOklch(labL, labA, labB) {
    var xyz65 = matVec(D50_TO_D65, labToXyzD50([labL, labA, labB]));
    var lab = xyzD65ToOklab(xyz65);
    return oklabToOklch(lab[0], lab[1], lab[2]);
  }

  // ------------------------------------------------------------ profile names

  var PROFILE_RULES = [
    [/prophoto|romm/i, 'prophoto', true],
    [/adobe\s*rgb|\ba98\b/i, 'adobe1998', true],
    [/display\s*p3|dci[-\s.]*p3|\bp3\b/i, 'p3', true],
    [/rec\.?\s*2020|bt\.?\s*2020|itu.*2020/i, 'rec2020', true],
    [/wide\s*gamut/i, 'widegamut', true],
    [/colormatch/i, 'colormatch', true],
    [/apple\s*rgb/i, 'apple', true],
    [/eci\s*rgb/i, 'ecirgb', true],
    [/rec\.?\s*709|bt\.?\s*709/i, 'rec709', true],
    [/srgb|iec\s*61966|hdtv/i, 'srgb', true],
    [/generic\s*rgb/i, 'apple', false],
    [/\brgb\b/i, 'srgb', false]
  ];

  /**
   * Best guess at which working space an ICC profile name refers to.
   * `exact` is false when we matched a family rather than the profile itself.
   */
  function matchProfile(name) {
    if (!name) return null;
    for (var i = 0; i < PROFILE_RULES.length; i++) {
      if (PROFILE_RULES[i][0].test(name)) {
        return { spaceId: PROFILE_RULES[i][1], exact: PROFILE_RULES[i][2] };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ summary

  /** Everything the panel needs to know about one OKLCH colour. */
  function describe(space, L, C, H) {
    var lin = oklchToLinear(space, L, C, H);
    var fits = inGamutLinear(lin);
    var clamped = [clamp01(lin[0]), clamp01(lin[1]), clamp01(lin[2])];
    var enc = encodeChannels(space, clamped);
    var display = linearToSrgb255(space, clamped);
    return {
      inGamut: fits,
      linear: lin,
      docEncoded: enc,
      doc255: [to255(enc[0]), to255(enc[1]), to255(enc[2])],
      docHex: hexOf(enc),
      displayRgb: display,
      displayHex: hexOf([display[0] / 255, display[1] / 255, display[2] / 255]),
      lab: oklchToLabD50(L, C, H)
    };
  }

  function formatOklch(L, C, H, precision) {
    var p = precision || {};
    return 'oklch(' + (L * 100).toFixed(p.l === undefined ? 2 : p.l) + '% ' +
      C.toFixed(p.c === undefined ? 4 : p.c) + ' ' +
      H.toFixed(p.h === undefined ? 2 : p.h) + ')';
  }

  function parseOklch(text) {
    if (typeof text !== 'string') return null;
    var m = /oklch\(\s*([+-]?[\d.]+)(%?)\s*[,\s]\s*([+-]?[\d.]+)(%?)\s*[,\s]\s*([+-]?[\d.]+)(deg)?\s*\)/i.exec(text);
    if (!m) return null;
    var L = parseFloat(m[1]);
    if (m[2] === '%') L /= 100;
    var C = parseFloat(m[3]);
    if (m[4] === '%') C = C / 100 * 0.4;
    var H = parseFloat(m[5]);
    if (!isFinite(L) || !isFinite(C) || !isFinite(H)) return null;
    return [L, C, ((H % 360) + 360) % 360];
  }

  return {
    // matrices / plumbing (exported mostly for tests)
    matMul: matMul, matVec: matVec, matInv: matInv,
    adaptationMatrix: adaptationMatrix, rgbToXyzMatrix: rgbToXyzMatrix,
    WHITE: WHITE, TRC: TRC,
    clamp: clamp, clamp01: clamp01,

    spaces: spaces,
    spaceList: spaceList,
    getSpace: function (id) { return spaces[id] || null; },
    matchProfile: matchProfile,

    oklchToOklab: oklchToOklab,
    oklabToOklch: oklabToOklch,
    oklabToLinear: oklabToLinear,
    linearToOklab: linearToOklab,
    oklchToLinear: oklchToLinear,
    linearToOklch: linearToOklch,

    inGamut: inGamut,
    inGamutLinear: inGamutLinear,
    maxChroma: maxChroma,
    spaceMaxChroma: spaceMaxChroma,
    chromaEnvelope: chromaEnvelope,
    envelopeAt: envelopeAt,

    encodeChannels: encodeChannels,
    decodeChannels: decodeChannels,
    oklchToSrgb255: oklchToSrgb255,
    linearToSrgb255: linearToSrgb255,
    hexOf: hexOf,
    parseHex: parseHex,

    oklchToLabD50: oklchToLabD50,
    labD50ToOklch: labD50ToOklch,
    xyzD50ToLab: xyzD50ToLab,
    labToXyzD50: labToXyzD50,

    describe: describe,
    formatOklch: formatOklch,
    parseOklch: parseOklch,

    LMS_ROOT_FROM_OKLAB: LMS_ROOT_FROM_OKLAB,
    OKLAB_FROM_LMS_ROOT: OKLAB_FROM_LMS_ROOT
  };
});
