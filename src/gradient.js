'use strict';
/*
 * The compiler: a lighting scheme in, a stack of gradient maps out.
 *
 * One light becomes one gradient-map adjustment layer.  The gradient carries
 * the light's *tonal* reach - colour where the light touches that end of the
 * value range, mid grey (the blend mode's neutral) everywhere else - and the
 * layer mask carries its *spatial* reach.  Splitting the two is what makes the
 * scheme editable as an idea: "the sky fills the shadows" is the gradient, "the
 * lamp is over here" is the mask, and neither has to know about the other.
 *
 * Every stop is solved by blend.js so that the tone under it keeps its OKLab
 * lightness exactly.  The pass adds chroma and hue to the drawing and takes
 * nothing away, which is the whole reason for doing it in OKLCH.
 *
 * `simulate` is the other half of the job.  The stops are exact for one layer
 * over a neutral underpainting, but Photoshop reads a gradient map's input from
 * the composite's luminosity, so a second map up the stack looks up a tone that
 * the first one has already coloured.  Rather than pretend that away, the panel
 * runs the real stack - blend by blend, lookup by lookup - and draws what will
 * actually happen, including how far the lightness has drifted by the end.
 */
(function (root, factory) {
  var color = root.OKColor;
  var blend = root.OKBlend;
  var scheme = root.OKScheme;
  if (typeof require === 'function' && typeof module === 'object') {
    if (!color) color = require('./color.js');
    if (!blend) blend = require('./blend.js');
    if (!scheme) scheme = require('./scheme.js');
  }
  var api = factory(color, blend, scheme);
  root.OKGradient = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (OKColor, OKBlend, OKScheme) {

  // Dense enough that whichever way Photoshop interpolates between stops the
  // difference is under a level, and short enough to stay a gradient a person
  // can open and edit by hand.
  var STOPS = 33;
  var MASK_STOPS = 13;

  // Stops are spaced evenly in *lightness*, not along the encoded value axis.
  // The bottom of that axis is savagely compressed - a quarter of everything a
  // painter would call a shadow lives in the first 3% of it - and a gradient
  // sampled evenly across it has one stop covering the whole climb out of
  // black, which is exactly where a colour cast is most visible.  Photoshop
  // lets a stop sit wherever it likes, so they go where the eye is.
  var LIGHTNESS_SPACED = true;

  // Chroma is kept a little inside the gamut hull rather than on it.  A target
  // sitting exactly on the edge has a channel pinned at 0 or 255, and pinning a
  // channel is what makes the blend inverse ill-conditioned: neighbouring stops
  // come out at wildly different values and the ramp between them stops meaning
  // anything.  The last few percent of chroma is not worth that.
  var HULL_MARGIN = 0.94;

  // Both ends of the value range hold no chroma at all - the gamut narrows to a
  // point at black and at white - so a light is eased out over the last stretch
  // rather than left to ride the hull until it hits the end and snaps to grey.
  // Without this the top stop or two of a ramp swing violently, and a swing
  // spread over ten levels of near-white is a band you can see.
  var ENDS = 0.08;

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function smooth01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }

  /** How much chroma the ends of the range are allowed to hold. */
  function endsWindow(L) {
    return smooth01(L / ENDS) * smooth01((1 - L) / ENDS);
  }

  function spaceOf(spaceId) {
    return OKColor.getSpace(spaceId) || OKColor.spaces.srgb;
  }

  function blendOf(scheme, light) {
    return OKBlend.getMode(light.blend || scheme.blend);
  }

  // ------------------------------------------------------------- gradients

  /**
   * The gradient for one light: the colour it puts on every tone in the range,
   * as stops in the document's own encoded values.
   *
   * `below` is the stack this layer will sit on, already compiled.  Two things
   * come from it.  The ramp position Photoshop looks a stop up by is the
   * luminosity of the composite underneath, so with layers below us the tone a
   * stop is really about is not its own position any more - `grayForPosition`
   * finds it.  And the blend's base is that composite rather than a flat grey,
   * so the solve is against the colour that will actually be there.
   *
   * Each light adds its own chroma to whatever the ones below it put down and
   * pins lightness back to the tone underneath, which is what keeps a stack of
   * these honest: lights add up, and the drawing's values come through the
   * whole pile unchanged.
   */
  function compileLight(scheme, light, ctx, below) {
    var space = ctx.space;
    var mode = blendOf(scheme, light);
    var hue = OKScheme.effectiveHue(scheme, light);
    var chroma = OKScheme.effectiveChroma(scheme, light);
    var rad = hue * Math.PI / 180;
    var ca = Math.cos(rad), sa = Math.sin(rad);
    var stops = [];
    var peak = 0;
    var asked = 0;

    for (var i = 0; i < STOPS; i++) {
      var L = i / (STOPS - 1);
      var gray = grayAt(space, L);
      var base = composite(below, gray);
      // Where this stop has to sit in the ramp: Photoshop looks a gradient map
      // up by the luminosity of the composite below it, which is the tone
      // itself only while nothing underneath has any colour yet.
      var position = below.length ? OKBlend.luminosity(base) : gray;
      var want = chroma * OKScheme.toneWeight(light, L) * endsWindow(L);
      var solved = OKBlend.solveStop({
        space: space, mode: mode, base: base, lightness: L,
        da: want * ca, db: want * sa, margin: HULL_MARGIN
      });
      stops.push({ location: clamp01(position), color: solved.color, chroma: solved.chroma });
      if (want > asked) asked = want;
      if (solved.added > peak) peak = solved.added;
    }

    // The ends are black and white whatever the lights do, so pin them there:
    // a ramp that starts late leaves Photoshop holding the first stop's colour
    // across a stretch that was never solved for.
    stops[0].location = 0;
    stops[stops.length - 1].location = 1;

    return {
      id: light.id, name: light.name, mode: mode, hue: hue,
      stops: stops, peak: peak, asked: asked
    };
  }

  /** The encoded tone with a given lightness, cached per space. */
  function grayAt(space, L) {
    if (!LIGHTNESS_SPACED) return L;
    var cache = space._grayForL || (space._grayForL = {});
    var key = Math.round(L * 4096);
    if (cache[key] === undefined) cache[key] = OKBlend.grayForLightness(space, L);
    return cache[key];
  }

  /** Compile every enabled light, bottom of the stack first. */
  function compile(scheme, ctx) {
    var gradients = [];
    OKScheme.activeLights(scheme).forEach(function (light) {
      gradients.push(compileLight(scheme, light, ctx, gradients));
    });
    return gradients;
  }

  /** Colour at any point along a compiled gradient, interpolated as Photoshop does. */
  function sampleGradient(gradient, position) {
    var stops = gradient.stops;
    var last = stops.length - 1;
    if (position <= stops[0].location) return stops[0].color;
    if (position >= stops[last].location) return stops[last].color;
    var lo = 0, hi = last;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (stops[mid].location <= position) lo = mid; else hi = mid;
    }
    var a = stops[lo], b = stops[hi];
    var span = b.location - a.location;
    var f = span > 0 ? (position - a.location) / span : 0;
    return [
      a.color[0] + (b.color[0] - a.color[0]) * f,
      a.color[1] + (b.color[1] - a.color[1]) * f,
      a.color[2] + (b.color[2] - a.color[2]) * f
    ];
  }

  // ------------------------------------------------------------------ masks

  /**
   * Where a light's mask gradient starts and ends, in document pixels, plus the
   * falloff as grey stops.  Photoshop draws exactly this and the panel's
   * preview evaluates the same curve, so the two cannot drift apart.
   *
   * @returns {null|{type:string, from:object, to:object, stops:Array}}
   */
  function maskGeometry(light, frame) {
    var w = frame.width, h = frame.height;
    var stops = OKScheme.falloffCurve(light, MASK_STOPS);
    if (light.shape === 'radial') {
      var cx = light.x * w, cy = light.y * h;
      var radius = Math.max(1e-4, light.size) * Math.max(w, h);
      return {
        type: 'radial',
        from: { x: cx, y: cy },
        to: { x: cx + radius, y: cy },
        stops: stops
      };
    }
    if (light.shape === 'linear') {
      var a = light.angle * Math.PI / 180;
      var ux = Math.cos(a), uy = -Math.sin(a);
      var half = 0.5 * (w * Math.abs(ux) + h * Math.abs(uy));
      return {
        type: 'linear',
        // From the edge the light comes from, to the far one.
        from: { x: w / 2 + ux * half, y: h / 2 + uy * half },
        to: { x: w / 2 - ux * half, y: h / 2 - uy * half },
        stops: stops
      };
    }
    return null;
  }

  // ------------------------------------------------------------------- plan
  // Everything Photoshop needs, worked out before a single command is sent.

  /**
   * @param {object} scheme
   * @param {object} ctx    {space}
   * @param {object} frame  {width, height} of the document, in pixels
   */
  function plan(scheme, ctx, frame) {
    var lights = OKScheme.activeLights(scheme);
    var gradients = compile(scheme, ctx);
    var layers = gradients.map(function (gradient, i) {
      var light = lights[i];
      return {
        id: light.id,
        name: light.name,
        blend: gradient.mode.ps,
        hue: gradient.hue,
        peak: gradient.peak,
        asked: gradient.asked,
        stops: gradient.stops,
        mask: maskGeometry(light, frame)
      };
    });
    return {
      name: scheme.name || 'Underpainting',
      // Bottom of the stack first, which is the order Photoshop wants them made
      // in, the order the panel lists them in, and the order they were compiled
      // in: the first light is the one everything else sits on top of.
      layers: layers,
      gradients: gradients
    };
  }

  // --------------------------------------------------------------- simulate

  /**
   * Run the compiled stack over a neutral tone, the way Photoshop will.
   *
   * `weights` is the mask coverage of each active light at the point being
   * asked about - all ones for somewhere every light reaches.
   *
   * @returns {number[]} encoded document RGB, 0..1
   */
  function composite(gradients, gray, weights) {
    var base = [gray, gray, gray];
    for (var i = 0; i < gradients.length; i++) {
      var amount = weights ? clamp01(weights[i]) : 1;
      if (amount <= 0) continue;
      // Photoshop hands a gradient map the luminosity of everything below it,
      // which is the tone itself only while nothing below has any colour yet.
      var stop = sampleGradient(gradients[i], OKBlend.luminosity(base));
      base = OKBlend.over(gradients[i].mode, base, stop, amount);
    }
    return base;
  }

  /**
   * The whole value range put through the stack: what the underpainting will
   * look like once the layers are there.
   *
   * Sampled evenly in lightness, because that is the axis the scheme is written
   * against and the axis a value scale is read on - a strip drawn evenly along
   * the encoded one would spend most of its width on the highlights.
   *
   * @returns {{samples: Array, driftL: number}} `driftL` is the largest the
   *          composite's OKLab lightness moves away from the tone it started
   *          as: the price of the pass, in the units the pass promised not to
   *          touch.
   */
  function simulate(scheme, ctx, opts) {
    opts = opts || {};
    var space = ctx.space;
    var count = opts.samples || 65;
    var weights = opts.weights;
    var gradients = opts.gradients || compile(scheme, ctx);
    var samples = [];
    var drift = 0;

    for (var i = 0; i < count; i++) {
      var L = i / (count - 1);
      var gray = grayAt(space, L);
      var enc = composite(gradients, gray, weights);
      var lin = OKColor.decodeChannels(space, enc);
      var lch = OKColor.linearToOklch(space, lin[0], lin[1], lin[2]);
      var d = Math.abs(lch[0] - L);
      if (d > drift) drift = d;
      samples.push({
        gray: gray,
        lightness: L,
        encoded: enc,
        oklch: lch,
        display: OKColor.linearToSrgb255(space, lin)
      });
    }

    return { samples: samples, driftL: drift };
  }

  /**
   * Mask coverage of every enabled light at a point in the frame, in the same
   * order as `compile`.
   */
  function weightsAt(scheme, frame, fx, fy) {
    return OKScheme.activeLights(scheme).map(function (light) {
      return OKScheme.maskWeight(light, fx, fy, frame);
    });
  }

  /**
   * The stack frozen at one tone, ready to be evaluated with different mask
   * coverage at every pixel of the frame preview.
   *
   * Each layer's colour is looked up once here rather than per pixel.  Strictly
   * the lookup position moves a little when a layer below is masked away, but
   * that is a second-order wobble in a picture whose whole job is to say where
   * the lights are, and it is the difference between a preview that keeps up
   * with a drag and one that does not.
   */
  function toneSlice(gradients, gray) {
    var base = [gray, gray, gray];
    var layers = [];
    for (var i = 0; i < gradients.length; i++) {
      var color = sampleGradient(gradients[i], OKBlend.luminosity(base));
      layers.push({ mode: gradients[i].mode, color: color });
      base = OKBlend.over(gradients[i].mode, base, color, 1);
    }
    return { gray: gray, layers: layers };
  }

  /** That slice under given mask coverage, as encoded document values. */
  function sliceColor(slice, weights, out) {
    out = out || [0, 0, 0];
    out[0] = out[1] = out[2] = slice.gray;
    for (var i = 0; i < slice.layers.length; i++) {
      var amount = weights[i];
      if (amount > 0) OKBlend.over(slice.layers[i].mode, out, slice.layers[i].color, amount, out);
    }
    return out;
  }

  return {
    STOPS: STOPS,
    MASK_STOPS: MASK_STOPS,
    spaceOf: spaceOf,
    blendOf: blendOf,
    compileLight: compileLight,
    grayAt: grayAt,
    sampleGradient: sampleGradient,
    maskGeometry: maskGeometry,
    plan: plan,
    compile: compile,
    composite: composite,
    simulate: simulate,
    weightsAt: weightsAt,
    toneSlice: toneSlice,
    sliceColor: sliceColor
  };
});
