'use strict';
/*
 * The lighting scheme: what the underpaint panel actually edits.
 *
 * Nothing in here knows about gradients, masks or layers.  A scheme is a
 * description of the light in a picture - a handful of lights, each with a
 * colour, a place, and a stretch of the value range it belongs to - and the
 * compiler in gradient.js is what turns that into things Photoshop can hold.
 * Keeping the two apart is the point of the panel: the scheme is small enough
 * to save, to re-open a week later and to change your mind about, while the
 * layer stack it produces is disposable and can be rebuilt from it at any time.
 *
 * A light says three things:
 *
 *   colour   an OKLCH hue and chroma.  No lightness - lightness belongs to the
 *            drawing underneath and this pass is not allowed to touch it.
 *   where    a mask shape.  Ambient light is everywhere; a lamp is a disc round
 *            a point; a sun is a wash across the frame from one direction.
 *   which    the part of the value range it lives in.  Ambient bounce fills the
 *   tones    shadows, a key light only shows where the drawing is already lit,
 *            a lamp near a face touches everything it reaches.
 *
 * "Where" becomes a layer mask and "which tones" becomes the shape of the
 * gradient itself, which is why both can be edited as ideas rather than as
 * pixels.  Pure data and pure functions - no DOM, no Photoshop.
 */
(function (root, factory) {
  var api = factory();
  root.OKScheme = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var VERSION = 1;
  var CHROMA_MAX = 0.2;    // ceiling for a single light's chroma slider
  var DEG = Math.PI / 180;

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function wrapHue(h) { h = h % 360; return h < 0 ? h + 360 : h; }
  function smooth01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }

  function num(value, fallback) {
    var n = typeof value === 'string' ? parseFloat(value) : value;
    return typeof n === 'number' && isFinite(n) ? n : fallback;
  }

  // --------------------------------------------------------- tonal profiles
  // Where in the value range a light lives.  `reach` is one slider: how far the
  // light spreads from its home end of the range towards the other.  Weights
  // are evaluated against OKLab lightness rather than the raw channel value, so
  // "shadows" means as dark as it looks, not as dark as it is encoded.

  var TONES = {
    shadow: {
      id: 'shadow', label: 'Shadows',
      weight: function (L, reach) {
        return 1 - smooth01(L / (0.18 + 0.62 * clamp01(reach)));
      }
    },
    mid: {
      id: 'mid', label: 'Midtones',
      weight: function (L, reach) {
        return 1 - smooth01(Math.abs(L - 0.5) / (0.14 + 0.36 * clamp01(reach)));
      }
    },
    light: {
      id: 'light', label: 'Lights',
      weight: function (L, reach) {
        var edge = 0.82 - 0.62 * clamp01(reach);
        return smooth01((L - edge) / (1 - edge));
      }
    },
    all: {
      id: 'all', label: 'All',
      weight: function () { return 1; }
    }
  };

  var TONE_LIST = [TONES.shadow, TONES.mid, TONES.light, TONES.all];

  function getTone(id) { return TONES[id] || TONES.all; }

  // ------------------------------------------------------------ mask shapes
  // Both shapes are written once, here, in normalised frame coordinates, and
  // the Photoshop side places a real gradient with the same geometry - so the
  // little picture in the panel is not an impression of the mask, it is the
  // mask.

  /** 1 in the heart of the light, 0 past its edge, `soft` sets the crossing. */
  function falloff(t, soft) {
    var s = clamp(soft, 0.02, 1);
    var start = 1 - s;
    if (t <= start) return 1;
    if (t >= 1) return 0;
    var u = (t - start) / (1 - start);
    return 1 - u * u * (3 - 2 * u);
  }

  var SHAPES = {
    none: {
      id: 'none', label: 'Everywhere',
      /** @returns {number} 0..1 coverage at a point in the frame */
      weight: function () { return 1; }
    },

    radial: {
      id: 'radial', label: 'Disc',
      // Distance is measured in pixels and then divided by the radius, so a
      // light keeps its shape when the document is not square.
      weight: function (light, fx, fy, frame) {
        var dx = (fx - light.x) * frame.width;
        var dy = (fy - light.y) * frame.height;
        var radius = Math.max(1e-4, light.size) * Math.max(frame.width, frame.height);
        return falloff(Math.sqrt(dx * dx + dy * dy) / radius, light.softness);
      }
    },

    linear: {
      id: 'linear', label: 'From a side',
      // A wash across the whole frame, full where the light is and gone at the
      // far edge.  `angle` is the direction the light comes *from*, read like
      // the picker's hue circle: 0 at 3 o'clock, counter-clockwise.
      weight: function (light, fx, fy, frame) {
        var a = light.angle * DEG;
        var ux = Math.cos(a), uy = -Math.sin(a);
        var half = 0.5 * (frame.width * Math.abs(ux) + frame.height * Math.abs(uy));
        var px = (fx - 0.5) * frame.width, py = (fy - 0.5) * frame.height;
        var along = (px * ux + py * uy) / (half || 1);
        return falloff((1 - along) * 0.5, light.softness);
      }
    }
  };

  function getShape(id) { return SHAPES[id] || SHAPES.none; }

  /** Coverage of one light at a point in the frame, 0..1. */
  function maskWeight(light, fx, fy, frame) {
    return getShape(light.shape).weight(light, fx, fy, frame);
  }

  /**
   * The falloff curve as a list of {t, value} samples.  The panel draws it and
   * the Photoshop side hands the same numbers to the gradient tool, which is
   * the only reason the two agree.
   */
  function falloffCurve(light, samples) {
    var n = samples || 17;
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      out.push({ t: t, value: falloff(t, light.softness) });
    }
    return out;
  }

  // ------------------------------------------------------------ light kinds
  // The kinds are the vocabulary the panel talks in.  Each one is a shape and a
  // tonal home that go together, plus a name that says what it is for; picking
  // one sets those defaults and every one of them stays editable afterwards.

  var KINDS = {
    ambient: {
      id: 'ambient', label: 'Ambient',
      hint: 'Fills the shadows everywhere - sky, room, the light with no source.',
      defaults: { shape: 'none', tone: 'shadow', reach: 0.5, chroma: 0.06 }
    },
    sun: {
      id: 'sun', label: 'Sun',
      hint: 'A wash from one side that only shows where the drawing is lit.',
      defaults: { shape: 'linear', tone: 'light', reach: 0.55, chroma: 0.09, softness: 0.9 }
    },
    lamp: {
      id: 'lamp', label: 'Lamp',
      hint: 'A source in the scene: colours everything within its reach.',
      defaults: { shape: 'radial', tone: 'all', reach: 0.5, chroma: 0.11, size: 0.35, softness: 0.8 }
    },
    spot: {
      id: 'spot', label: 'Spot',
      hint: 'A local light that only catches the lit side of what it falls on.',
      defaults: { shape: 'radial', tone: 'light', reach: 0.5, chroma: 0.12, size: 0.28, softness: 0.7 }
    }
  };

  var KIND_LIST = [KINDS.ambient, KINDS.sun, KINDS.lamp, KINDS.spot];

  function getKind(id) { return KINDS[id] || KINDS.ambient; }

  // ---------------------------------------------------------------- palettes
  // A palette is a whole rig, not a row of swatches: the lights that make up a
  // kind of light, already placed and already pointed at the right end of the
  // value range.  Pick one and there is something to react to; everything in it
  // is then yours to move.
  //
  // They are written bottom of the stack first, and the light that reaches
  // everywhere goes at the bottom.  Each layer is solved against what will be
  // underneath it, so a light that is masked away in half the picture is a
  // shakier thing to stand the rest of the scheme on than one that is not.

  var PALETTES = [
    {
      id: 'goldenHour', label: 'Golden hour',
      note: 'Low warm sun, deep blue sky filling the shadows.',
      lights: [
        { name: 'Sky', kind: 'ambient', hue: 252, chroma: 0.065, reach: 0.55 },
        { name: 'Sun', kind: 'sun', hue: 78, chroma: 0.10, angle: 155, softness: 0.9, reach: 0.55 }
      ]
    },
    {
      id: 'overcast', label: 'Overcast',
      note: 'Cool top light, a little warmth bouncing back off the ground.',
      lights: [
        { name: 'Ground bounce', kind: 'ambient', hue: 72, chroma: 0.028, reach: 0.45 },
        { name: 'Sky', kind: 'sun', hue: 243, chroma: 0.045, angle: 90, softness: 1, reach: 0.7 }
      ]
    },
    {
      id: 'sunset', label: 'Sunset',
      note: 'Orange key against a violet ambient - the loudest of the presets.',
      lights: [
        { name: 'Sky', kind: 'ambient', hue: 318, chroma: 0.08, reach: 0.6 },
        { name: 'Sun', kind: 'sun', hue: 42, chroma: 0.135, angle: 165, softness: 0.85, reach: 0.5 }
      ]
    },
    {
      id: 'candle', label: 'Candlelight',
      note: 'A warm source in the scene, night pressing in around it.',
      lights: [
        { name: 'Night', kind: 'ambient', hue: 268, chroma: 0.075, reach: 0.6 },
        { name: 'Flame', kind: 'lamp', hue: 62, chroma: 0.135, x: 0.38, y: 0.52, size: 0.34, softness: 0.85 }
      ]
    },
    {
      id: 'moonlight', label: 'Moonlight',
      note: 'Cold key, a trace of warmth left in the shadows.',
      lights: [
        { name: 'Warm bounce', kind: 'ambient', hue: 48, chroma: 0.035, reach: 0.4 },
        { name: 'Moon', kind: 'sun', hue: 256, chroma: 0.08, angle: 120, softness: 0.95, reach: 0.6 }
      ]
    },
    {
      id: 'studio', label: 'Studio',
      note: 'Barely there: a warm key and a cool fill, for keeping colour quiet.',
      lights: [
        { name: 'Fill', kind: 'ambient', hue: 238, chroma: 0.03, reach: 0.5 },
        { name: 'Key', kind: 'sun', hue: 88, chroma: 0.035, angle: 125, softness: 1, reach: 0.6 }
      ]
    },
    {
      id: 'underwater', label: 'Underwater',
      note: 'Everything is the water; the surface light comes down through it.',
      lights: [
        { name: 'Water', kind: 'ambient', hue: 198, chroma: 0.09, tone: 'all', reach: 0.6 },
        { name: 'Surface', kind: 'spot', hue: 172, chroma: 0.075, x: 0.5, y: 0.12, size: 0.55, softness: 0.95 }
      ]
    },
    {
      id: 'neon', label: 'Neon night',
      note: 'Two coloured sources and no daylight anywhere.',
      lights: [
        { name: 'Night', kind: 'ambient', hue: 272, chroma: 0.06, reach: 0.5 },
        { name: 'Street', kind: 'lamp', hue: 196, chroma: 0.10, x: 0.24, y: 0.6, size: 0.36, softness: 0.85 },
        { name: 'Sign', kind: 'spot', hue: 336, chroma: 0.145, x: 0.68, y: 0.36, size: 0.34, softness: 0.75 }
      ]
    }
  ];

  function getPalette(id) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) return PALETTES[i];
    }
    return PALETTES[0];
  }

  // ------------------------------------------------------------- hue naming
  // Enough of a name to tell two lights apart in a list, and to christen a new
  // one without asking.  Hues are OKLCH, so the boundaries are where the colour
  // reads as changing, not where the maths says a sixth of the circle is up.

  var HUE_NAMES = [
    [16, 'red'], [45, 'orange'], [75, 'amber'], [105, 'yellow'], [135, 'lime'],
    [160, 'green'], [190, 'teal'], [215, 'cyan'], [245, 'azure'], [280, 'blue'],
    [310, 'violet'], [340, 'magenta'], [360, 'rose']
  ];

  function hueName(hue) {
    var h = wrapHue(hue);
    for (var i = 0; i < HUE_NAMES.length; i++) {
      if (h < HUE_NAMES[i][0]) return HUE_NAMES[i][1];
    }
    return 'red';
  }

  // ------------------------------------------------------------------ lights

  function makeLight(kindId, over) {
    var kind = getKind(kindId);
    var light = {
      id: '',
      name: '',
      kind: kind.id,
      hue: 250,
      chroma: 0.08,
      tone: 'all',
      reach: 0.5,
      shape: 'none',
      x: 0.5,
      y: 0.4,
      size: 0.35,
      softness: 0.8,
      angle: 135,
      blend: '',
      enabled: true
    };
    var d = kind.defaults;
    for (var key in d) {
      if (Object.prototype.hasOwnProperty.call(d, key)) light[key] = d[key];
    }
    if (over) {
      for (var k in over) {
        if (Object.prototype.hasOwnProperty.call(over, k)) light[k] = over[k];
      }
    }
    if (!light.name) light.name = capitalise(hueName(light.hue)) + ' ' + kind.label.toLowerCase();
    return normaliseLight(light);
  }

  function capitalise(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /** Move a light to another kind, keeping everything the new kind does not own. */
  function retype(light, kindId) {
    var kind = getKind(kindId);
    var next = clone(light);
    next.kind = kind.id;
    var d = kind.defaults;
    next.shape = d.shape;
    next.tone = d.tone;
    if (d.reach !== undefined) next.reach = d.reach;
    if (d.size !== undefined) next.size = d.size;
    if (d.softness !== undefined) next.softness = d.softness;
    return normaliseLight(next);
  }

  function normaliseLight(raw, index) {
    var light = raw && typeof raw === 'object' ? raw : {};
    var kind = getKind(light.kind);
    var out = {
      id: typeof light.id === 'string' && light.id ? light.id : 'l' + ((index || 0) + 1) + '-' + kind.id,
      name: typeof light.name === 'string' && light.name ? light.name : kind.label,
      kind: kind.id,
      hue: wrapHue(num(light.hue, 250)),
      chroma: clamp(num(light.chroma, 0.08), 0, CHROMA_MAX),
      tone: getTone(light.tone === undefined ? kind.defaults.tone : light.tone).id,
      reach: clamp01(num(light.reach, 0.5)),
      shape: getShape(light.shape === undefined ? kind.defaults.shape : light.shape).id,
      x: clamp(num(light.x, 0.5), -0.5, 1.5),
      y: clamp(num(light.y, 0.4), -0.5, 1.5),
      size: clamp(num(light.size, 0.35), 0.02, 2),
      softness: clamp(num(light.softness, 0.8), 0.02, 1),
      angle: wrapHue(num(light.angle, 135)),
      blend: typeof light.blend === 'string' ? light.blend : '',
      enabled: light.enabled !== false
    };
    return out;
  }

  // ----------------------------------------------------------------- schemes

  function create(paletteId) {
    var palette = getPalette(paletteId);
    return normalise({
      version: VERSION,
      name: palette.label,
      palette: palette.id,
      blend: 'hardLight',
      chroma: 1,
      hueShift: 0,
      lights: palette.lights.map(function (spec) {
        return makeLight(spec.kind, spec);
      })
    });
  }

  function normalise(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var lights = Array.isArray(s.lights) ? s.lights : [];
    var scheme = {
      version: VERSION,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : 'Underpainting',
      palette: typeof s.palette === 'string' ? s.palette : '',
      blend: typeof s.blend === 'string' && s.blend ? s.blend : 'hardLight',
      chroma: clamp(num(s.chroma, 1), 0, 2),
      hueShift: wrapHue(num(s.hueShift, 0)),
      lights: lights.map(function (light, i) { return normaliseLight(light, i); }),
      groupId: num(s.groupId, 0) || 0,
      groupName: typeof s.groupName === 'string' ? s.groupName : ''
    };
    // Ids have to be unique: they are how the panel's selection, the layer
    // names and a re-loaded file all find the same light again.
    var seen = {};
    scheme.lights.forEach(function (light, i) {
      while (seen[light.id]) light.id = light.id + '-' + (i + 1);
      seen[light.id] = true;
    });
    return scheme;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function parse(text) {
    var raw = JSON.parse(text);
    if (raw && raw.okpaint) raw = raw.okpaint;
    return normalise(raw);
  }

  /** The saved form: the scheme itself under a key that names the format. */
  function stringify(scheme) {
    return JSON.stringify({ okpaint: normalise(scheme) }, null, 2) + '\n';
  }

  function addLight(scheme, kindId) {
    var next = clone(scheme);
    var light = makeLight(kindId, { hue: wrapHue(suggestHue(scheme)) });
    light.id = 'l' + (Date.now() % 100000) + '-' + next.lights.length;
    next.lights.push(light);
    return normalise(next);
  }

  /**
   * A hue for a new light that is not one of the hues already in the scheme:
   * as far round the circle from all of them as it can get.  Two lights the
   * same colour are two layers doing one layer's work.
   */
  function suggestHue(scheme) {
    if (!scheme.lights.length) return 250;
    var best = 0, bestGap = -1;
    for (var h = 0; h < 360; h += 5) {
      var nearest = 360;
      for (var i = 0; i < scheme.lights.length; i++) {
        var d = Math.abs(wrapHue(h - scheme.lights[i].hue));
        if (d > 180) d = 360 - d;
        if (d < nearest) nearest = d;
      }
      if (nearest > bestGap) { bestGap = nearest; best = h; }
    }
    return best;
  }

  function removeLight(scheme, id) {
    var next = clone(scheme);
    next.lights = next.lights.filter(function (l) { return l.id !== id; });
    return normalise(next);
  }

  function updateLight(scheme, id, changes) {
    var next = clone(scheme);
    next.lights = next.lights.map(function (light) {
      if (light.id !== id) return light;
      var merged = light;
      for (var key in changes) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          if (key === 'kind' && changes.kind !== light.kind) merged = retype(merged, changes.kind);
          else merged[key] = changes[key];
        }
      }
      return normaliseLight(merged);
    });
    return normalise(next);
  }

  function findLight(scheme, id) {
    for (var i = 0; i < scheme.lights.length; i++) {
      if (scheme.lights[i].id === id) return scheme.lights[i];
    }
    return null;
  }

  /** A light's hue and chroma after the scheme-wide shift and scale. */
  function effectiveHue(scheme, light) {
    return wrapHue(light.hue + scheme.hueShift);
  }

  function effectiveChroma(scheme, light) {
    return clamp(light.chroma * scheme.chroma, 0, CHROMA_MAX * 2);
  }

  /** How much of a light lands on a tone, before the mask has its say. */
  function toneWeight(light, L) {
    return clamp01(getTone(light.tone).weight(L, light.reach));
  }

  function activeLights(scheme) {
    return scheme.lights.filter(function (l) { return l.enabled; });
  }

  return {
    VERSION: VERSION,
    CHROMA_MAX: CHROMA_MAX,

    tones: TONES, toneList: TONE_LIST, getTone: getTone,
    shapes: SHAPES, getShape: getShape,
    kinds: KINDS, kindList: KIND_LIST, getKind: getKind,
    palettes: PALETTES, getPalette: getPalette,

    falloff: falloff,
    falloffCurve: falloffCurve,
    maskWeight: maskWeight,
    toneWeight: toneWeight,

    hueName: hueName,
    makeLight: makeLight,
    retype: retype,
    normaliseLight: normaliseLight,

    create: create,
    normalise: normalise,
    clone: clone,
    parse: parse,
    stringify: stringify,

    addLight: addLight,
    removeLight: removeLight,
    updateLight: updateLight,
    findLight: findLight,
    suggestHue: suggestHue,
    activeLights: activeLights,
    effectiveHue: effectiveHue,
    effectiveChroma: effectiveChroma
  };
});
