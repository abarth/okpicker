'use strict';
/*
 * Panel controller: owns the OKLCH state, schedules repaints and keeps the
 * picker bound to Photoshop's foreground colour.  Loaded last; depends on the
 * globals published by the other scripts in index.html.
 *
 * The binding runs both ways.  Anything that moves the picker is pushed to the
 * foreground swatch straight away, and any foreground change made elsewhere in
 * Photoshop is pulled back into the picker.  The document's colour profile is
 * followed automatically, so there are no modes and no buttons.
 */
(function () {

  var OKColor = globalThis.OKColor;
  var OKPng = globalThis.OKPng;
  var OKRender = globalThis.OKRender;
  var PS = globalThis.OKPhotoshop;
  var doc = document;

  function $(id) { return doc.getElementById(id); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function wrapHue(h) { h = h % 360; return h < 0 ? h + 360 : h; }

  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : function (fn) { return setTimeout(fn, 16); };

  // ------------------------------------------------------------- surfaces
  // UXP's canvas implementation has improved a lot but is still worth probing
  // for: if it round-trips a putImageData we use it, otherwise we fall back to
  // an <img> fed with an inline PNG, which works everywhere.

  var canvasProbe = null;

  function canvasSupported() {
    if (canvasProbe !== null) return canvasProbe;
    canvasProbe = false;
    try {
      var c = doc.createElement('canvas');
      c.width = 2;
      c.height = 2;
      var ctx = c.getContext('2d');
      if (ctx && ctx.createImageData && ctx.putImageData && ctx.getImageData) {
        var id = ctx.createImageData(2, 2);
        id.data[0] = 12; id.data[1] = 34; id.data[2] = 56; id.data[3] = 255;
        ctx.putImageData(id, 0, 0);
        var back = ctx.getImageData(0, 0, 1, 1).data;
        canvasProbe = back[0] === 12 && back[1] === 34 && back[2] === 56 && back[3] === 255;
      }
    } catch (e) {
      canvasProbe = false;
    }
    return canvasProbe;
  }

  function Surface(container) {
    this.kind = canvasSupported() ? 'canvas' : 'img';
    this.el = doc.createElement(this.kind === 'canvas' ? 'canvas' : 'img');
    container.appendChild(this.el);
  }

  Surface.prototype.paint = function (img) {
    if (this.kind === 'canvas') {
      var el = this.el;
      // Assigning width/height wipes the bitmap, so only touch them when the
      // pixel size really changed: otherwise every repaint would flash.
      if (el.width !== img.width || el.height !== img.height) {
        el.width = img.width;
        el.height = img.height;
      }
      var ctx = el.getContext('2d');
      var id = ctx.createImageData(img.width, img.height);
      id.data.set(img.data);
      ctx.putImageData(id, 0, 0);
    } else {
      this.el.setAttribute('src', OKPng.dataUri(img.data, img.width, img.height));
    }
  };

  // ---------------------------------------------------------------- state

  var state = {
    L: 0.68,
    C: 0.14,
    desiredC: 0.14,
    H: 250,
    spaceId: 'srgb'
  };

  var els = {};
  var surfaces = {};
  var maxCCache = {};

  function activeSpace() {
    return OKColor.getSpace(state.spaceId) || OKColor.spaces.srgb;
  }

  /** The part of the OKLab a/b plane the diagram shows: the gamut's own extent,
   *  so the hull fills the picture instead of floating inside a square. */
  function plotBounds() {
    return OKColor.spaceBounds(activeSpace());
  }

  /** Chroma at the far end of the C track: the space's own maximum plus a
   *  little headroom, so the scale does not shift as lightness moves. */
  function plotMaxC() {
    var id = state.spaceId;
    if (maxCCache[id] === undefined) {
      maxCCache[id] = Math.ceil(OKColor.spaceMaxChroma(activeSpace()) * 1.06 * 200) / 200;
    }
    return maxCCache[id];
  }

  function gamutChroma() {
    return OKColor.maxChroma(activeSpace(), state.L, state.H, 22);
  }

  /** Chroma is always held on the gamut hull, so re-derive it after L, H or the
   *  document's colour space change. */
  function reconcileChroma() {
    state.C = Math.min(state.desiredC, plotMaxC(), gamutChroma());
  }

  /** Apply a user-driven change: repaint, then hand the colour to Photoshop. */
  function setColor(next) {
    var plotDirty = false;
    if (next.L !== undefined) {
      var L = clamp01(next.L);
      if (L !== state.L) plotDirty = true;
      state.L = L;
    }
    if (next.H !== undefined) state.H = wrapHue(next.H);
    if (next.C !== undefined) state.desiredC = Math.max(0, next.C);
    reconcileChroma();
    requestRender({ plot: plotDirty, ramps: true });
    pushForeground();
  }

  // --------------------------------------------------------------- painting

  var dirty = { plot: true, l: true, c: true, h: true };
  var frameQueued = false;

  function requestRender(opts) {
    opts = opts || {};
    if (opts.plot) dirty.plot = true;
    if (opts.ramps) { dirty.l = true; dirty.c = true; dirty.h = true; }
    if (frameQueued) return;
    frameQueued = true;
    raf(function () {
      frameQueued = false;
      try {
        renderFrame();
      } catch (e) {
        console.error('okpicker: repaint failed', e);
      }
    });
  }

  function outlineColor() {
    // A neutral contour that reads on both themes.
    return [40, 40, 40];
  }

  function pixelRatio() {
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return dpr > 1 ? Math.min(dpr, 2) : 1;
  }

  function trackWidth(el) {
    var w = 0;
    try { w = el.getBoundingClientRect().width; } catch (e) { w = 0; }
    if (!(w > 0)) w = 220;
    return Math.max(80, Math.min(640, Math.round(w * pixelRatio())));
  }

  /**
   * Repaint whatever is dirty, always at full resolution.  A worst-case frame
   * (the lightness axis moving, so the diagram and all three ramps are stale)
   * costs about ten milliseconds, which is cheap enough that there is no need
   * for a reduced-quality pass while dragging.
   */
  function renderFrame() {
    var space = activeSpace();
    var ratio = pixelRatio();
    // Canvas takes a bitmap straight from memory, so it can afford more pixels
    // than the PNG-through-a-data-URI fallback.
    var plotCap = surfaces.plot.kind === 'canvas' ? 448 : 320;

    if (dirty.plot) {
      var pw = Math.max(96, Math.min(plotCap, Math.round(layoutSizes.plotW * ratio)));
      // Derive the height from the same aspect the element uses, so the pixels
      // stay square and nothing is stretched on the way to the screen.
      var ph = Math.max(48, Math.round(pw * layoutSizes.aspect));
      surfaces.plot.paint(OKRender.chPlot({
        space: space, L: state.L, bounds: plotBounds(), width: pw, height: ph,
        envelope: OKColor.chromaEnvelope(space, state.L, 720, 20),
        outline: outlineColor()
      }));
      dirty.plot = false;
    }

    var rampHeight = Math.max(6, Math.round(layoutSizes.track * ratio));

    if (dirty.l) {
      surfaces.l.paint(OKRender.lightnessRamp({
        space: space, C: state.C, H: state.H,
        width: trackWidth(els.lTrack), height: rampHeight
      }));
      dirty.l = false;
    }

    if (dirty.c) {
      surfaces.c.paint(OKRender.chromaRamp({
        space: space, L: state.L, H: state.H, maxC: plotMaxC(),
        width: trackWidth(els.cTrack), height: rampHeight
      }));
      dirty.c = false;
    }

    if (dirty.h) {
      surfaces.h.paint(OKRender.hueRamp({
        space: space, L: state.L, C: state.C,
        width: trackWidth(els.hTrack), height: rampHeight
      }));
      dirty.h = false;
    }

    updateMarkers();
    updateSwatch();
  }

  function updateMarkers() {
    var f = OKRender.markerFraction(state.C, state.H, plotBounds());
    els.plotMarker.style.left = (f.x * 100) + '%';
    els.plotMarker.style.top = (f.y * 100) + '%';
    els.lThumb.style.left = (state.L * 100) + '%';
    els.cThumb.style.left = (clamp01(state.C / plotMaxC()) * 100) + '%';
    els.hThumb.style.left = ((state.H / 360) * 100) + '%';
  }

  function updateSwatch() {
    els.swatch.style.backgroundColor =
      OKColor.describe(activeSpace(), state.L, state.C, state.H).displayHex;
  }

  // ------------------------------------------------------------ interaction

  function bindDrag(el, onMove, onEnd) {
    function fractions(e) {
      var r = el.getBoundingClientRect();
      return {
        x: r.width ? (e.clientX - r.left) / r.width : 0,
        y: r.height ? (e.clientY - r.top) / r.height : 0
      };
    }
    var moving = false;

    function move(e) {
      if (!moving) return;
      onMove(fractions(e));
    }

    function up() {
      if (!moving) return;
      moving = false;
      doc.removeEventListener('mousemove', move, true);
      doc.removeEventListener('mouseup', up, true);
      if (onEnd) onEnd();
    }

    el.addEventListener('mousedown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      moving = true;
      if (e.preventDefault) e.preventDefault();
      onMove(fractions(e));
      doc.addEventListener('mousemove', move, true);
      doc.addEventListener('mouseup', up, true);
    });
  }

  // ------------------------------------------------------------- Photoshop

  var pushInFlight = false;
  var pushQueued = false;
  var lastPushedLab = null;
  var lastPushAt = 0;
  var pullInFlight = false;

  /** True when two D50 Lab triples are the same colour as far as Photoshop's
   *  own quantisation is concerned. */
  function sameLab(a, b) {
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) < 0.6 &&
           Math.abs(a[1] - b[1]) < 0.6 &&
           Math.abs(a[2] - b[2]) < 0.6;
  }

  /**
   * Send the current colour to the foreground swatch.  Calls that arrive while
   * a write is in flight collapse into a single follow-up write of whatever the
   * state is by then, so dragging stays live without queueing up work.
   */
  function pushForeground() {
    if (!PS.available()) return;
    if (pushInFlight) { pushQueued = true; return; }
    writeForeground();
  }

  async function writeForeground() {
    pushInFlight = true;
    try {
      var info = OKColor.describe(activeSpace(), state.L, state.C, state.H);
      lastPushedLab = info.lab;
      try {
        await PS.setColor('foreground', { lab: info.lab });
      } catch (e) {
        // Lab is preferred because Photoshop converts it into the document's
        // space for us; if that call is refused, fall back to raw values.
        await PS.setColor('foreground', { rgb: info.doc255 });
      }
    } catch (e) {
      console.error('okpicker: could not set the foreground colour', e);
    } finally {
      lastPushAt = Date.now();
      pushInFlight = false;
    }
    if (pushQueued) {
      pushQueued = false;
      writeForeground();
    }
  }

  /** Load Photoshop's foreground colour into the picker. */
  async function pullForeground() {
    if (!PS.available() || pullInFlight) return;
    pullInFlight = true;
    try {
      var c = await PS.getColor('foreground');
      if (!c) return;
      if (c.lab && sameLab(c.lab, lastPushedLab)) {
        // Our own write coming back as a notification.  Remember the rounded
        // values Photoshop settled on so the next comparison is exact.
        lastPushedLab = c.lab;
        return;
      }

      var lch;
      if (c.lab) {
        lch = OKColor.labD50ToOklch(c.lab[0], c.lab[1], c.lab[2]);
      } else {
        var space = activeSpace();
        var lin = OKColor.decodeChannels(space, [c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255]);
        lch = OKColor.linearToOklch(space, lin[0], lin[1], lin[2]);
      }

      var L = clamp01(lch[0]);
      var plotDirty = L !== state.L;
      state.L = L;
      state.desiredC = Math.max(0, lch[1]);
      state.H = wrapHue(lch[2]);
      reconcileChroma();
      requestRender({ plot: plotDirty, ramps: true });
    } catch (e) {
      console.error('okpicker: could not read the foreground colour', e);
    } finally {
      pullInFlight = false;
    }
  }

  /**
   * Follow the frontmost document's colour space.  Only the RGB working spaces
   * whose primaries we know can be given a real gamut hull; everything else
   * (CMYK, Grayscale, Lab, an unrecognised ICC profile) falls back to sRGB.
   */
  async function refreshDocument() {
    var previous = state.spaceId;
    var spaceId = 'srgb';
    if (PS.available()) {
      try {
        var info = await PS.getDocumentInfo();
        if (info.hasDocument && info.modeId === 'RGBColor') {
          var match = OKColor.matchProfile(info.profile);
          if (match) spaceId = match.spaceId;
        }
      } catch (e) {
        console.error('okpicker: could not read the document profile', e);
      }
    }
    if (spaceId === previous) return;
    state.spaceId = spaceId;
    reconcileChroma();
    // A different gamut is a different shape, so the diagram's proportions
    // change with it.
    layout();
    requestRender({ plot: true, ramps: true });
  }

  async function syncFromHost() {
    await refreshDocument();
    await pullForeground();
  }

  // ------------------------------------------------------------------ setup
  // The panel never scrolls.  The swatch and the tracks have a fixed height, so
  // the diagram takes whatever is left over; when even that is not enough, the
  // chrome steps down through progressively tighter metrics.

  var BODY_PAD = 6;       // must match the body's padding in styles.css
  var SWATCH_INSET = 3;   // gap between the swatch and the diagram's corner
  var SWATCH_MAX = 36;    // the swatch is a preview, not a feature
  var TRACK_MAX = 32;     // tallest the axis ramps are allowed to grow

  var DENSITY = [
    { track: 15, trackGap: 5, rowGap: 6, minPlot: 150 },
    { track: 13, trackGap: 4, rowGap: 5, minPlot: 120 },
    { track: 11, trackGap: 3, rowGap: 4, minPlot: 96 },
    { track: 9, trackGap: 2, rowGap: 3, minPlot: 72 },
    { track: 8, trackGap: 2, rowGap: 2, minPlot: 0 }
  ];

  var layoutSizes = { plotW: 180, plotH: 180, aspect: 1, track: 15 };

  /** Height of everything under the diagram, for one set of metrics. */
  function chromeHeight(d) {
    return d.rowGap + (3 * d.track + 2 * d.trackGap);
  }

  /**
   * How much room the panel actually has, top to bottom.  Only sources that are
   * independent of what we have already drawn will do: measuring our own
   * content and then sizing the content to the measurement would ratchet the
   * panel smaller on every pass.  `body` is the last resort for that reason.
   */
  function viewportHeight() {
    if (typeof window !== 'undefined' && window.innerHeight > 0) return window.innerHeight;
    var de = doc.documentElement;
    if (de && de.clientHeight > 0) return de.clientHeight;
    if (doc.body && doc.body.clientHeight > 0) return doc.body.clientHeight;
    return 420;
  }

  function rootWidth() {
    var w = 0;
    try { w = els.root.getBoundingClientRect().width; } catch (e) { w = 0; }
    return w > 0 ? w : 240;
  }

  function layout() {
    var width = rootWidth();
    var height = viewportHeight() - 2 * BODY_PAD;
    var bounds = plotBounds();
    var aspect = (bounds.bMax - bounds.bMin) / (bounds.aMax - bounds.aMin);

    var d = DENSITY[DENSITY.length - 1];
    for (var i = 0; i < DENSITY.length; i++) {
      var fits = Math.min(width, (height - chromeHeight(DENSITY[i])) / aspect);
      if (fits >= Math.min(width, DENSITY[i].minPlot)) {
        d = DENSITY[i];
        break;
      }
    }

    var room = height - chromeHeight(d);
    var plotW = Math.round(clamp(Math.min(width, room / aspect), 24, 620));
    var plotH = Math.max(16, Math.round(plotW * aspect));

    // A diagram cropped to the gamut is wider than it is tall for most spaces,
    // so a tall panel has height to spare.  Spend it on the ramps.
    var track = d.track;
    var slack = room - plotH;
    if (slack > 0) {
      var grow = Math.min(TRACK_MAX - track, Math.floor(slack / 3));
      if (grow > 0) track += grow;
    }

    var changed = plotW !== layoutSizes.plotW || plotH !== layoutSizes.plotH ||
      track !== layoutSizes.track;
    layoutSizes = { plotW: plotW, plotH: plotH, aspect: aspect, track: track };

    els.plot.style.width = plotW + 'px';
    els.plot.style.height = plotH + 'px';

    // Park the colour in the corner of the diagram the gamut never reaches.
    var corner = OKColor.freeCorner(activeSpace());
    var swatch = Math.round(clamp(corner.size * plotW - 2 * SWATCH_INSET, 10, SWATCH_MAX));
    els.swatch.style.width = swatch + 'px';
    els.swatch.style.height = swatch + 'px';
    els.swatch.style.left =
      (corner.x === 'left' ? SWATCH_INSET : plotW - swatch - SWATCH_INSET) + 'px';
    els.swatch.style.top =
      (corner.y === 'top' ? SWATCH_INSET : plotH - swatch - SWATCH_INSET) + 'px';

    els.sliders.style.marginTop = d.rowGap + 'px';

    for (var t = 0; t < els.tracks.length; t++) {
      els.tracks[t].style.height = track + 'px';
      els.tracks[t].style.marginTop = (t === 0 ? 0 : d.trackGap) + 'px';
    }

    return changed;
  }

  function relayout() {
    if (layout()) requestRender({ plot: true, ramps: true });
    else requestRender({ ramps: true });
  }

  function bindEvents() {
    bindDrag(els.plot, function (f) {
      var v = OKRender.fractionToCh(f.x, f.y, plotBounds());
      setColor({ C: v.C, H: v.H });
    }, pushForeground);

    bindDrag(els.lTrack, function (f) {
      setColor({ L: clamp01(f.x) });
    }, pushForeground);

    bindDrag(els.cTrack, function (f) {
      setColor({ C: clamp01(f.x) * plotMaxC() });
    }, pushForeground);

    bindDrag(els.hTrack, function (f) {
      setColor({ H: clamp01(f.x) * 360 });
    }, pushForeground);

    var resizeTimer = null;
    function onResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        relayout();
      }, 80);
    }

    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(onResize).observe(els.root); } catch (e) { /* the event below is the fallback */ }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onResize);
    }
    // Should a host ever fail to report a resize, the panel's `show` handler
    // re-runs the layout, so reopening it is enough to recover.
  }

  function init() {
    els = {
      root: $('root'),
      plot: $('plot'),
      plotMarker: $('plotMarker'),
      swatch: $('swatch'),
      sliders: $('sliders'),
      lTrack: $('lTrack'), lThumb: $('lThumb'),
      cTrack: $('cTrack'), cThumb: $('cThumb'),
      hTrack: $('hTrack'), hThumb: $('hThumb')
    };
    els.tracks = [els.lTrack, els.cTrack, els.hTrack];

    surfaces.plot = new Surface($('plotSurface'));
    surfaces.l = new Surface($('lTrackSurface'));
    surfaces.c = new Surface($('cTrackSurface'));
    surfaces.h = new Surface($('hTrackSurface'));

    layout();
    bindEvents();
    reconcileChroma();
    requestRender({ plot: true, ramps: true });

    if (PS.available()) {
      PS.onDocumentChange(function () { syncFromHost(); });
      PS.onSwatchChange(function (which) {
        if (which !== 'foreground') return;
        // Ignore the echo of our own write; anything else is the user picking a
        // colour elsewhere in Photoshop, and the picker follows it.
        if (pushInFlight || pushQueued) return;
        if (Date.now() - lastPushAt < 400) return;
        pullForeground();
      });
    }
    syncFromHost();

    PS.registerPanel('okpicker.panel', {
      create: function () {},
      show: function () { relayout(); syncFromHost(); },
      hide: function () {},
      destroy: function () {}
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
