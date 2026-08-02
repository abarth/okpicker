'use strict';
/*
 * The lighting scheme: what the underpaint panel actually edits.
 *
 * Nothing in here knows about gradients, masks or layers.  A scheme is a
 * description of the light in a picture - a handful of lights, each with a
 * colour, a place, and a stretch of the value range it belongs to - and the
 * compiler in gradient.js is what turns that into things Photoshop can hold.
 * Keeping the two apart is the point of the panel: the scheme is small enough
 * to write into the names of the layers it made, to read back out of them a
 * week later and to change your mind about, while the layer stack itself is
 * disposable and can be rebuilt from it at any time.
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

  /**
   * Everything in a scheme is held to a step, and every step is finer than the
   * panel can show or the eye can see: a degree of hue, a thousandth of chroma,
   * a thousandth of the frame.  It keeps normalising idempotent, it keeps the
   * saved forms tidy, and it is what lets a scheme survive a round trip through
   * a layer name without drifting.
   *
   * Rounded through a decimal string rather than by dividing: a thousandth is
   * not a binary fraction, so multiplying one back leaves 0.344 as
   * 0.34400000000000003, which is not a number anybody wants to read in a file.
   */
  function step(value, decimals) {
    return Number(value.toFixed(decimals));
  }

  function degrees(value) {
    return Math.round(wrapHue(value)) % 360;
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
   * The falloff curve as a list of {t, value} samples, for drawing.
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

  // ------------------------------------------------------------ mask pixels
  // The mask Photoshop gets is this function evaluated over the document,
  // written straight into the layer's mask as bytes.  Not a gradient handed to
  // the gradient tool: since Photoshop 2023 that tool makes a gradient *fill
  // layer* rather than painting, which is no way to fill a mask - and going
  // through pixels means the mask is the same falloff the panel previewed
  // rather than an approximation of it in gradient stops.

  var FALLOFF_STEPS = 2048;

  function falloffLut(soft) {
    var lut = new Uint8Array(FALLOFF_STEPS + 1);
    for (var i = 0; i <= FALLOFF_STEPS; i++) {
      lut[i] = Math.round(falloff(i / FALLOFF_STEPS, soft) * 255);
    }
    return lut;
  }

  /**
   * A light's coverage over the whole frame, as one byte per pixel.
   *
   * @param {object} light
   * @param {{width:number, height:number}} frame  document size in pixels
   * @returns {Uint8Array} width*height, row by row from the top
   */
  function maskPixels(light, frame) {
    var w = Math.max(1, Math.round(frame.width));
    var h = Math.max(1, Math.round(frame.height));
    var data = new Uint8Array(w * h);
    var shape = getShape(light.shape);
    var lut = falloffLut(light.softness);
    var i = 0, x, y;

    if (shape.id === 'radial') {
      var cx = light.x * w, cy = light.y * h;
      var radius = Math.max(1e-4, light.size) * Math.max(w, h);
      var perPixel = FALLOFF_STEPS / radius;
      // Only the disc itself is worth walking: everything past it is zero, and
      // the buffer starts that way.
      var top = Math.max(0, Math.floor(cy - radius));
      var bottom = Math.min(h, Math.ceil(cy + radius) + 1);
      for (y = top; y < bottom; y++) {
        var dy = (y + 0.5) - cy;
        var dy2 = dy * dy;
        var reach = radius * radius - dy2;
        if (reach <= 0) continue;
        reach = Math.sqrt(reach);
        var left = Math.max(0, Math.floor(cx - reach));
        var right = Math.min(w, Math.ceil(cx + reach) + 1);
        i = y * w + left;
        for (x = left; x < right; x++) {
          var dx = (x + 0.5) - cx;
          var d = Math.sqrt(dx * dx + dy2) * perPixel;
          data[i++] = d >= FALLOFF_STEPS ? 0 : lut[d | 0];
        }
      }
      return data;
    }

    if (shape.id === 'linear') {
      var a = light.angle * DEG;
      var ux = Math.cos(a), uy = -Math.sin(a);
      var half = 0.5 * (w * Math.abs(ux) + h * Math.abs(uy)) || 1;
      // Coverage is affine across the frame, so each row is one starting point
      // and a step: (1 - along) / 2, where `along` runs -1 to 1 up the light's
      // own direction.
      var step = -0.5 * (ux / half) * FALLOFF_STEPS;
      for (y = 0; y < h; y++) {
        var py = (y + 0.5) - h / 2;
        var at = (1 - (((0.5 - w / 2) * ux + py * uy) / half)) * 0.5 * FALLOFF_STEPS;
        for (x = 0; x < w; x++) {
          data[i++] = at <= 0 ? 255 : (at >= FALLOFF_STEPS ? 0 : lut[at | 0]);
          at += step;
        }
      }
      return data;
    }

    // Everywhere: a mask that hides nothing.
    for (i = 0; i < data.length; i++) data[i] = 255;
    return data;
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
      hue: degrees(num(light.hue, 250)),
      chroma: step(clamp(num(light.chroma, 0.08), 0, CHROMA_MAX), 3),
      tone: getTone(light.tone === undefined ? kind.defaults.tone : light.tone).id,
      reach: step(clamp01(num(light.reach, 0.5)), 2),
      shape: getShape(light.shape === undefined ? kind.defaults.shape : light.shape).id,
      x: step(clamp(num(light.x, 0.5), -0.5, 1.5), 3),
      y: step(clamp(num(light.y, 0.4), -0.5, 1.5), 3),
      size: step(clamp(num(light.size, 0.35), 0.02, 2), 3),
      softness: step(clamp(num(light.softness, 0.8), 0.02, 1), 2),
      angle: degrees(num(light.angle, 135)),
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
      chroma: step(clamp(num(s.chroma, 1), 0, 2), 2),
      hueShift: degrees(num(s.hueShift, 0)),
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

  // ------------------------------------------------------------ layer names
  // The other place a scheme is kept: written into the names of the layers it
  // made.  A UXP plugin cannot put anything of its own inside a PSD, and layer
  // names are the one field that both travels with the file and can be read
  // back, so a document handed to somebody else arrives with its lighting
  // intact rather than with a stack of gradients nobody can edit.
  //
  // Each layer carries its own light and the group carries what applies to all
  // of them, which is why it scales: the whole scheme on one name would run out
  // of room at about four lights.  Fields are named rather than positional so
  // that the result is something a person can read - and change - in the
  // Layers panel, and anything unrecognised is ignored, so a light from a
  // later version degrades to its defaults instead of failing.

  var TOKEN = 'oklch1';
  var TOKEN_RE = /\[oklch1((?:\s+[A-Za-z]{1,2}=[^\s\]]*)*)\s*\]\s*$/;
  // Photoshop takes long layer names but not unbounded ones, and a name cut off
  // at the end would take the token with it.  The display half gives way first.
  var MAX_NAME = 250;

  var KIND_CODES = { ambient: 'amb', sun: 'sun', lamp: 'lamp', spot: 'spot' };
  var TONE_CODES = { shadow: 'sh', mid: 'mid', light: 'hi', all: 'all' };
  var SHAPE_CODES = { none: 'no', radial: 'rad', linear: 'lin' };
  var BLEND_CODES = {
    softLight: 'soft', overlay: 'ovl', hardLight: 'hard',
    linearLight: 'lin', normal: 'norm'
  };

  function invert(codes) {
    var out = {};
    for (var key in codes) {
      if (Object.prototype.hasOwnProperty.call(codes, key)) out[codes[key]] = key;
    }
    return out;
  }

  var KIND_IDS = invert(KIND_CODES);
  var TONE_IDS = invert(TONE_CODES);
  var SHAPE_IDS = invert(SHAPE_CODES);
  var BLEND_IDS = invert(BLEND_CODES);

  /** A number with no more digits than it needs: 0.100 -> 0.1, 155.0 -> 155. */
  function shortNumber(value, decimals) {
    var text = value.toFixed(decimals);
    if (text.indexOf('.') < 0) return text;
    return text.replace(/0+$/, '').replace(/\.$/, '');
  }

  function token(fields) {
    return '[' + TOKEN + (fields.length ? ' ' + fields.join(' ') : '') + ']';
  }

  /** Name plus token, trimmed to something Photoshop will keep whole. */
  function withToken(name, fields) {
    var suffix = token(fields);
    var room = MAX_NAME - suffix.length - 1;
    var display = (name || '').trim();
    if (display.length > room) display = display.slice(0, Math.max(0, room)).trim();
    return display ? display + ' ' + suffix : suffix;
  }

  /** The name without its token: what the layer is called, as opposed to what it is. */
  function displayName(name) {
    if (typeof name !== 'string') return '';
    return name.replace(TOKEN_RE, '').trim();
  }

  function hasToken(name) {
    return typeof name === 'string' && TOKEN_RE.test(name);
  }

  /** `{display, fields}` for a name the panel wrote, or null for any other name. */
  function readName(name) {
    if (typeof name !== 'string') return null;
    var match = TOKEN_RE.exec(name);
    if (!match) return null;
    var fields = {};
    match[1].trim().split(/\s+/).forEach(function (pair) {
      if (!pair) return;
      var split = pair.indexOf('=');
      if (split > 0) fields[pair.slice(0, split)] = pair.slice(split + 1);
    });
    return { display: name.slice(0, match.index).trim(), fields: fields };
  }

  /** One light, as fields.  A single letter each; there are a lot of them. */
  function lightFields(light) {
    var fields = [
      'k=' + KIND_CODES[light.kind],
      'h=' + light.hue,
      'c=' + shortNumber(light.chroma, 3),
      't=' + TONE_CODES[light.tone],
      'r=' + shortNumber(light.reach, 2),
      'g=' + SHAPE_CODES[light.shape]
    ];
    if (light.shape === 'radial') {
      fields.push('x=' + shortNumber(light.x, 3));
      fields.push('y=' + shortNumber(light.y, 3));
      fields.push('z=' + shortNumber(light.size, 3));
    }
    if (light.shape === 'linear') fields.push('a=' + light.angle);
    if (light.shape !== 'none') fields.push('f=' + shortNumber(light.softness, 2));
    if (light.blend) fields.push('b=' + BLEND_CODES[light.blend]);
    return fields;
  }

  /** What applies to the whole scheme.  Two letters each, so the two sets can
   *  share a token without ever meaning each other. */
  function schemeFields(scheme) {
    var fields = [];
    if (scheme.palette) fields.push('pl=' + scheme.palette);
    fields.push('bl=' + BLEND_CODES[scheme.blend]);
    fields.push('ch=' + shortNumber(scheme.chroma, 2));
    fields.push('hu=' + scheme.hueShift);
    return fields;
  }

  /** What one light's layer is called. */
  function lightName(light) {
    return withToken(light.name, lightFields(light));
  }

  /** What the group is called: the scheme's name, and what applies to all of it. */
  function schemeName(scheme) {
    return withToken(scheme.name, schemeFields(scheme));
  }

  /**
   * A scheme with one light in it makes one layer and no group, so that layer
   * has to carry both halves.  The two field sets were named to allow it.
   */
  function soloName(scheme, light) {
    return withToken(light.name, lightFields(light).concat(schemeFields(scheme)));
  }

  function fromFields(fields, key, table, fallback) {
    var code = fields[key];
    return (code !== undefined && table[code]) || fallback;
  }

  /** One light, read back out of its layer's name. */
  function lightFromName(name, index) {
    var read = readName(name);
    if (!read) return null;
    var f = read.fields;
    var light = makeLight(fromFields(f, 'k', KIND_IDS, 'ambient'), { name: read.display });
    if (f.h !== undefined) light.hue = num(f.h, light.hue);
    if (f.c !== undefined) light.chroma = num(f.c, light.chroma);
    if (f.t !== undefined) light.tone = fromFields(f, 't', TONE_IDS, light.tone);
    if (f.r !== undefined) light.reach = num(f.r, light.reach);
    if (f.g !== undefined) light.shape = fromFields(f, 'g', SHAPE_IDS, light.shape);
    if (f.x !== undefined) light.x = num(f.x, light.x);
    if (f.y !== undefined) light.y = num(f.y, light.y);
    if (f.z !== undefined) light.size = num(f.z, light.size);
    if (f.a !== undefined) light.angle = num(f.a, light.angle);
    if (f.f !== undefined) light.softness = num(f.f, light.softness);
    light.blend = fromFields(f, 'b', BLEND_IDS, '');
    light.id = 'doc' + (index || 0) + '-' + light.kind;
    return normaliseLight(light, index);
  }

  /**
   * A whole scheme, read back out of the document.
   *
   * `layers` is `{name, visible}` for each one, bottom of the stack first - the
   * order the panel lists them in.  A layer somebody renamed past recognition
   * is skipped rather than guessed at; if none of them are readable there was
   * no scheme here.
   *
   * Whether a light is switched on is not in the token, because the layer
   * already says: a hidden adjustment layer does nothing, which is exactly what
   * a light switched off means.  Hiding one in the Layers panel and reading the
   * scheme back switches it off in the panel too.
   */
  function fromLayers(groupName, layers) {
    var lights = [];
    (layers || []).forEach(function (layer) {
      var entry = typeof layer === 'string' ? { name: layer } : (layer || {});
      var light = lightFromName(entry.name, lights.length);
      if (!light) return;
      light.enabled = entry.visible !== false;
      lights.push(light);
    });
    if (!lights.length) return null;

    var read = readName(groupName);
    var fields = read ? read.fields : {};
    return normalise({
      name: read ? read.display : displayName(groupName),
      palette: fields.pl || '',
      blend: fromFields(fields, 'bl', BLEND_IDS, 'hardLight'),
      chroma: fields.ch === undefined ? 1 : num(fields.ch, 1),
      hueShift: fields.hu === undefined ? 0 : num(fields.hu, 0),
      lights: lights
    });
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
    maskPixels: maskPixels,
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

    TOKEN: TOKEN,
    MAX_NAME: MAX_NAME,
    lightName: lightName,
    schemeName: schemeName,
    soloName: soloName,
    displayName: displayName,
    hasToken: hasToken,
    readName: readName,
    lightFromName: lightFromName,
    fromLayers: fromLayers,

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
