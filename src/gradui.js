'use strict';
/*
 * OKLCH Gradient panel: design a gradient map in OKLCH and edit it live in the
 * document.
 *
 * The design is a handful of control points; gradient.js turns them into stops.
 * The panel's job is to let you put those points where you want them and to
 * keep the document's gradient map in step, so the picture on screen is the
 * feedback rather than anything drawn in here.
 *
 * Two views of the same thing, and it is worth being clear which is which: the
 * ramp along the top is the *result*, drawn against lightness so the shadows
 * get the room they are worth; the diagram below it is the *design surface*,
 * the gamut at the selected point's lightness with the whole ramp's route drawn
 * across it.
 *
 * Loaded last; depends on the globals published by the other scripts.
 */
(function () {

  var OKColor = globalThis.OKColor;
  var OKGradient = globalThis.OKGradient;
  var OKRender = globalThis.OKRender;
  var OKSurface = globalThis.OKSurface;
  var PS = globalThis.OKPhotoshop;
  var doc = document;

  function $(id) { return doc.getElementById(id); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  var Surface = OKSurface.Surface;
  var bindDrag = OKSurface.bindDrag;
  var pixelRatio = OKSurface.pixelRatio;
  var raf = OKSurface.raf;

  // ---------------------------------------------------------------- state

  var state = {
    design: OKGradient.defaultDesign(),
    selected: 1,
    spaceId: 'srgb',
    hasDocument: false,
    layer: null       // the bound gradient map layer, or null
  };

  var els = {};
  var surfaces = {};
  var handles = [];
  var curve = null;
  var doomed = false;

  function activeSpace() { return OKColor.getSpace(state.spaceId) || OKColor.spaces.srgb; }
  function points() { return state.design.points; }
  function selectedIndex() { return clamp(state.selected, 0, points().length - 1); }
  function selected() { return points()[selectedIndex()]; }
  function plotBounds() { return OKColor.spaceBounds(activeSpace()); }
  function refreshCurve() { curve = OKGradient.curveFor(state.design); }
  function sampleAt(L) { return OKGradient.sampleAt(curve, activeSpace(), L); }
  function chromaCeiling(L, H) { return OKColor.maxChroma(activeSpace(), L, H, 22); }

  /**
   * Everything the panel edits goes through here: tidy the design, rebuild the
   * curve, repaint, and hand the result to Photoshop.
   *
   * `final` asks for the refined stop list.  A drag does not wait for it -
   * the seed set is already far inside a visible difference - so the expensive
   * build happens once, when the drag ends.
   */
  function designChanged(opts, isFinal) {
    state.design = OKGradient.normalize(state.design);
    state.selected = selectedIndex();
    refreshCurve();
    syncPreset();
    requestRender(opts || { plot: true, ramps: true });
    pushGradient(isFinal);
  }

  /** Store a relative chroma the user aimed at, undoing the master amount so
   *  the diagram and the tracks read as the colour that actually comes out. */
  function setEffectiveRho(point, rho) {
    point.rho = clamp01(rho / Math.max(state.design.amount, 0.05));
  }

  // --------------------------------------------------------------- painting

  var dirty = { plot: true, ramp: true, c: true, h: true, a: true };
  var frameQueued = false;

  function requestRender(opts) {
    opts = opts || {};
    if (opts.plot) dirty.plot = true;
    if (opts.ramp !== false) dirty.ramp = true;
    if (opts.ramps) { dirty.c = true; dirty.h = true; dirty.a = true; }
    if (frameQueued) return;
    frameQueued = true;
    raf(function () {
      frameQueued = false;
      try {
        renderFrame();
      } catch (e) {
        console.error('okpicker: gradient repaint failed', e);
      }
    });
  }

  function flat() { return function () { return Infinity; }; }

  function trackWidth(el) {
    return Math.max(80, Math.min(640, Math.round(OKSurface.boxWidth(el, 220) * pixelRatio())));
  }

  /**
   * The gamut slice, cached.  The slice only depends on the lightness of the
   * selected point, but the route drawn over it changes with every edit, so the
   * two are kept apart: the expensive picture is painted once per lightness and
   * the cheap overlay goes onto a copy of it.
   */
  var sliceCache = { key: null, img: null, scratch: null };

  function plotImage(L, width, height) {
    var space = activeSpace();
    var key = space.id + '|' + L.toFixed(5) + '|' + width + 'x' + height;
    if (sliceCache.key !== key) {
      sliceCache.key = key;
      sliceCache.img = OKRender.chPlot({
        space: space, L: L, bounds: plotBounds(), width: width, height: height,
        envelope: OKColor.chromaEnvelope(space, L, 720, 20),
        outline: [40, 40, 40]
      });
      sliceCache.scratch = null;
    }
    var base = sliceCache.img;
    if (!sliceCache.scratch || sliceCache.scratch.data.length !== base.data.length) {
      sliceCache.scratch = {
        width: base.width, height: base.height,
        data: new Uint8ClampedArray(base.data.length)
      };
    }
    var out = sliceCache.scratch;
    out.data.set(base.data);
    return out;
  }

  /** The whole ramp as a route across the a/b plane. */
  function routeSamples() {
    var out = [];
    var n = 96;
    for (var i = 0; i <= n; i++) {
      var s = sampleAt(i / n);
      out.push({ C: s.C, H: s.H });
    }
    return out;
  }

  function markSamples() {
    var current = selectedIndex();
    return points().map(function (p, i) {
      var s = sampleAt(p.L);
      return { C: s.C, H: s.H, selected: i === current };
    });
  }

  function renderFrame() {
    var space = activeSpace();
    var ratio = pixelRatio();
    var point = selected();
    var here = sampleAt(point.L);
    var ceiling = chromaCeiling(point.L, point.H);
    var rampHeight = Math.max(6, Math.round(layoutSizes.track * ratio));

    if (dirty.ramp) {
      surfaces.ramp.paint(OKRender.ramp({
        width: trackWidth(els.ramp),
        height: Math.max(8, Math.round(layoutSizes.ramp * ratio)),
        sample: function (t) {
          var s = sampleAt(t);
          return [t, s.C, s.H];
        },
        limit: flat()
      }));
      dirty.ramp = false;
    }

    if (dirty.plot) {
      var plotCap = surfaces.plot.kind === 'canvas' ? 448 : 320;
      var pw = Math.max(96, Math.min(plotCap, Math.round(layoutSizes.plotW * ratio)));
      var ph = Math.max(48, Math.round(pw * layoutSizes.aspect));
      var img = plotImage(point.L, pw, ph);
      OKRender.pathOverlay(img, {
        bounds: plotBounds(), path: routeSamples(), marks: markSamples()
      });
      surfaces.plot.paint(img);
      dirty.plot = false;
    }

    // Relative chroma, from neutral out to the gamut wall at this lightness and
    // hue.  Nothing on this track can be out of gamut, which is the whole point
    // of holding chroma as a fraction.
    if (dirty.c) {
      surfaces.c.paint(OKRender.ramp({
        width: trackWidth(els.cTrack), height: rampHeight,
        sample: function (t) { return [point.L, t * ceiling, point.H]; },
        limit: flat()
      }));
      dirty.c = false;
    }

    // Hue at constant *relative* chroma, so the sweep follows the gamut's own
    // shape rather than running outside it around the blues.
    if (dirty.h) {
      surfaces.h.paint(OKRender.ramp({
        width: trackWidth(els.hTrack), height: rampHeight,
        sample: function (t) {
          var hue = t * 360;
          return [point.L, here.rho * chromaCeiling(point.L, hue), hue];
        },
        limit: flat()
      }));
      dirty.h = false;
    }

    // The master amount, previewed at the selected point.
    if (dirty.a) {
      surfaces.a.paint(OKRender.ramp({
        width: trackWidth(els.aTrack), height: rampHeight,
        sample: function (t) {
          return [point.L, clamp01(point.rho * t * AMOUNT_MAX) * ceiling, point.H];
        },
        limit: flat()
      }));
      dirty.a = false;
    }

    updateMarkers(here);
    updateSwatch(here);
  }

  var AMOUNT_MAX = 2;

  function updateMarkers(here) {
    var point = selected();
    var f = OKRender.markerFraction(here.C, here.H, plotBounds());
    els.plotMarker.style.left = (f.x * 100) + '%';
    els.plotMarker.style.top = (f.y * 100) + '%';
    els.cThumb.style.left = (clamp01(here.rho) * 100) + '%';
    els.hThumb.style.left = ((point.H / 360) * 100) + '%';
    els.aThumb.style.left = ((state.design.amount / AMOUNT_MAX) * 100) + '%';

    var current = selectedIndex();
    for (var i = 0; i < handles.length; i++) {
      var p = points()[i];
      handles[i].style.left = (p.L * 100) + '%';
      handles[i].className = 'handle' +
        (i === current ? ' on' : '') +
        (i === current && doomed ? ' doomed' : '');
    }
  }

  function updateSwatch(here) {
    els.swatch.style.backgroundColor =
      OKColor.describe(activeSpace(), here.L, here.C, here.H).displayHex;
  }

  function rebuildHandles() {
    while (handles.length > points().length) {
      els.handles.removeChild(handles.pop());
    }
    while (handles.length < points().length) {
      var h = doc.createElement('div');
      h.className = 'handle';
      els.handles.appendChild(h);
      handles.push(h);
    }
  }

  // ------------------------------------------------------------ interaction

  /** How close a press has to land to grab an existing control point. */
  var GRAB_FRACTION = 0.035;
  /** ...and how close, in panel pixels, to grab one off the diagram. */
  var GRAB_PIXELS = 9;
  /** How far clear of the row a control point has to be dragged to be dropped. */
  var DROP_FRACTION = 1.4;

  function nearestPoint(L) {
    var best = -1, bestD = Infinity;
    points().forEach(function (p, i) {
      var d = Math.abs(p.L - L);
      if (d < bestD) { bestD = d; best = i; }
    });
    return { index: best, distance: bestD };
  }

  /**
   * Move the selected control point along the ramp, letting it pass its
   * neighbours.  Sorting in place keeps the identity of the point being
   * dragged, so the selection travels with it rather than with the slot.
   */
  function moveSelectedTo(L) {
    var pts = points();
    var point = pts[selectedIndex()];
    point.L = clamp(L, OKGradient.L_MIN, OKGradient.L_MAX);
    pts.sort(function (a, b) { return a.L - b.L; });
    state.selected = pts.indexOf(point);
  }

  function removeSelected() {
    if (points().length < 2) return;
    points().splice(selectedIndex(), 1);
    state.selected = Math.min(state.selected, points().length - 1);
    rebuildHandles();
    designChanged({ plot: true, ramps: true }, true);
  }

  function bindRamp() {
    bindDrag(els.rampRow, function (f, start) {
      var L = clamp01(f.x);
      if (start) {
        doomed = false;
        var near = nearestPoint(L);
        if (near.distance <= GRAB_FRACTION) {
          state.selected = near.index;
        } else if (points().length < OKGradient.MAX_POINTS) {
          // A new point takes the colour the ramp already has there, so
          // dropping one in changes nothing until it is dragged.
          var s = sampleAt(L);
          points().push(OKGradient.makePoint(L, s.rho / Math.max(state.design.amount, 0.05), s.H));
          points().sort(function (a, b) { return a.L - b.L; });
          state.selected = nearestPoint(L).index;
          rebuildHandles();
        } else {
          state.selected = near.index;
        }
      }
      doomed = points().length > 1 && (f.y < -DROP_FRACTION || f.y > 1 + DROP_FRACTION);
      moveSelectedTo(L);
      designChanged({ plot: true, ramps: true });
    }, function () {
      if (doomed) {
        doomed = false;
        removeSelected();
        return;
      }
      designChanged({ plot: true, ramps: true }, true);
    });
  }

  /** Did the gesture in progress on the diagram actually change anything? */
  var plotEdited = false;

  function bindControls() {
    bindDrag(els.plot, function (f, start) {
      if (start) {
        plotEdited = false;
        // A press that lands on a control point picks that point up instead of
        // dragging the selected one onto it.  Nothing moves until the pointer
        // does, so a click can select without also nudging the colour it just
        // selected - but carrying straight on into a drag still works.
        var hit = OKRender.markerHit(markSamples(), f.x, f.y, plotBounds(),
          layoutSizes.plotW, layoutSizes.plotH, GRAB_PIXELS);
        if (hit >= 0) {
          if (hit !== selectedIndex()) {
            state.selected = hit;
            requestRender({ plot: true, ramps: true });
          }
          return;
        }
      }
      plotEdited = true;
      var v = OKRender.fractionToCh(f.x, f.y, plotBounds());
      var point = selected();
      var ceiling = chromaCeiling(point.L, v.H);
      setEffectiveRho(point, ceiling > 0 ? v.C / ceiling : 0);
      point.H = v.H;
      designChanged({ plot: true, ramps: true });
    }, function () {
      // Selecting is not an edit, so it does not need a write to the document.
      if (plotEdited) designChanged({ plot: true, ramps: true }, true);
    });

    bindDrag(els.cTrack, function (f) {
      setEffectiveRho(selected(), clamp01(f.x));
      designChanged({ plot: true, ramps: true });
    }, function () { designChanged({ plot: true, ramps: true }, true); });

    bindDrag(els.hTrack, function (f) {
      selected().H = clamp01(f.x) * 360;
      designChanged({ plot: true, ramps: true });
    }, function () { designChanged({ plot: true, ramps: true }, true); });

    bindDrag(els.aTrack, function (f) {
      state.design.amount = clamp01(f.x) * AMOUNT_MAX;
      designChanged({ plot: true, ramps: true });
    }, function () { designChanged({ plot: true, ramps: true }, true); });

    // Delete removes the selected control point, but only while the gradient
    // panel is the one being used - the two panels share a document.
    doc.addEventListener('mousedown', function (e) {
      focused = els.groot.contains && els.groot.contains(e.target);
    }, true);
    doc.addEventListener('keydown', function (e) {
      if (!focused || e.target === els.preset) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      removeSelected();
    });
  }

  var focused = false;

  function buildPresetList() {
    var custom = doc.createElement('option');
    custom.value = '';
    custom.textContent = 'Custom';
    els.preset.appendChild(custom);

    // Flat, in the order the presets are declared: everyday lighting first,
    // then the stranger sort.  <optgroup> would say so, but UXP does not render
    // it and drops the options nested inside; plain heading rows were not worth
    // the space when they cannot be chosen anyway.
    OKGradient.PRESETS.forEach(function (preset) {
      var option = doc.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      els.preset.appendChild(option);
    });

    els.preset.addEventListener('change', function () {
      var design = OKGradient.presetDesign(els.preset.value);
      if (!design) {
        // "Custom" is a report, not a choice; put the menu back to the design
        // that is actually loaded.
        syncPreset();
        return;
      }
      state.design = design;
      state.selected = Math.min(state.selected, design.points.length - 1);
      rebuildHandles();
      sliceCache.key = null;
      designChanged({ plot: true, ramps: true }, true);
    });
  }

  function syncPreset() {
    var id = OKGradient.matchPreset(state.design) || '';
    if (els.preset.value !== id) els.preset.value = id;
  }

  // ------------------------------------------------------------- Photoshop

  var pushInFlight = false;
  var pushQueued = false;
  var pushQueuedFinal = false;
  var lastPushAt = 0;
  var syncInFlight = false;

  /**
   * Hand the design to the bound layer.  Calls that arrive while a write is in
   * flight collapse into a single follow-up write of whatever the design is by
   * then, so dragging stays live without queueing up work.
   */
  function pushGradient(isFinal) {
    if (!PS.available() || !state.layer) return;
    if (pushInFlight) {
      pushQueued = true;
      pushQueuedFinal = pushQueuedFinal || !!isFinal;
      return;
    }
    writeGradient(isFinal);
  }

  function descriptorFor(isFinal) {
    var built = OKGradient.buildStops(state.design, activeSpace(),
      isFinal ? {} : { measure: false });
    return PS.gradientMapDescriptor(built.stops, OKGradient.encodeDesign(state.design));
  }

  async function writeGradient(isFinal) {
    pushInFlight = true;
    try {
      await PS.updateGradientMap(descriptorFor(isFinal));
    } catch (e) {
      console.error('okpicker: could not update the gradient map', e);
    } finally {
      lastPushAt = Date.now();
      pushInFlight = false;
    }
    if (pushQueued) {
      var wasFinal = pushQueuedFinal;
      pushQueued = false;
      pushQueuedFinal = false;
      writeGradient(wasFinal);
    }
  }

  async function createLayer() {
    if (!PS.available() || !state.hasDocument || state.layer) return;
    try {
      await PS.createGradientMap(descriptorFor(true));
    } catch (e) {
      console.error('okpicker: could not add a gradient map layer', e);
    }
    await refreshLayer();
  }

  function updateAction() {
    var text, enabled = false;
    if (!PS.available()) text = 'Preview only';
    else if (!state.hasDocument) text = 'No document';
    else if (state.layer) text = state.layer.name || 'Gradient Map';
    else { text = 'Create'; enabled = true; }
    els.action.textContent = text;
    els.action.className = 'action' + (enabled ? ' enabled' : '');
  }

  /**
   * Bind to the selected layer if it is a gradient map, and adopt its design
   * when it carries one.  The panel edits the layer the user has selected and
   * nothing else, so there is never a hidden write to a layer out of sight.
   */
  async function refreshLayer() {
    if (!PS.available()) { state.layer = null; updateAction(); return; }
    var info = await PS.getGradientMapLayer();
    if (!info.hasLayer) {
      state.layer = null;
      updateAction();
      return;
    }
    state.layer = { id: info.layerId, name: info.layerName };
    var design = OKGradient.decodeDesign(info.gradientName);
    if (design && OKGradient.encodeDesign(design) !== OKGradient.encodeDesign(state.design)) {
      state.design = design;
      state.selected = Math.min(state.selected, design.points.length - 1);
      rebuildHandles();
      refreshCurve();
      syncPreset();
      sliceCache.key = null;
      requestRender({ plot: true, ramps: true });
    }
    updateAction();
  }

  /** Follow the frontmost document's colour space, as the picker does. */
  async function refreshDocument() {
    var previous = state.spaceId;
    var spaceId = 'srgb';
    state.hasDocument = false;
    if (PS.available()) {
      try {
        var info = await PS.getDocumentInfo();
        state.hasDocument = !!info.hasDocument;
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
    sliceCache.key = null;
    // A different gamut is a different shape, so the diagram's proportions
    // change with it.
    layout();
    requestRender({ plot: true, ramps: true });
  }

  async function syncFromHost() {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      await refreshDocument();
      await refreshLayer();
    } finally {
      syncInFlight = false;
    }
  }

  // ------------------------------------------------------------------ setup
  // Same discipline as the picker: the panel never scrolls, so the rows with a
  // fixed height are laid out first and the diagram takes whatever is left.

  var BODY_PAD = 6;      // must match the body's padding in styles.css
  var SWATCH_MAX = 36;
  var TRACK_MAX = 26;
  var FOOT_HEIGHT = 22;  // must match .foot in styles.css
  var HANDLE_GAP = 2;

  var DENSITY = [
    { track: 15, trackGap: 5, rowGap: 6, ramp: 22, handles: 11, minPlot: 130 },
    { track: 13, trackGap: 4, rowGap: 5, ramp: 18, handles: 10, minPlot: 104 },
    { track: 11, trackGap: 3, rowGap: 4, ramp: 15, handles: 9, minPlot: 84 },
    { track: 9, trackGap: 2, rowGap: 3, ramp: 13, handles: 9, minPlot: 64 },
    { track: 8, trackGap: 2, rowGap: 2, ramp: 11, handles: 8, minPlot: 0 }
  ];

  var layoutSizes = { plotW: 180, plotH: 180, aspect: 1, track: 15, ramp: 22 };

  /** Height of everything that is not the diagram, for one set of metrics. */
  function chromeHeight(d) {
    return d.ramp + HANDLE_GAP + d.handles +
      d.rowGap + (3 * d.track + 2 * d.trackGap) +
      d.rowGap + FOOT_HEIGHT;
  }

  function layout() {
    var width = OKSurface.boxWidth(els.groot, 240);
    var height = OKSurface.boxHeight(els.panel, 460) - 2 * BODY_PAD;
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
      track !== layoutSizes.track || d.ramp !== layoutSizes.ramp;
    layoutSizes = { plotW: plotW, plotH: plotH, aspect: aspect, track: track, ramp: d.ramp };

    els.ramp.style.height = d.ramp + 'px';
    els.handles.style.height = d.handles + 'px';
    els.handles.style.marginTop = HANDLE_GAP + 'px';

    els.plot.style.width = plotW + 'px';
    els.plot.style.height = plotH + 'px';

    var swatch = Math.round(
      clamp(OKColor.freeBottomLeft(activeSpace()) * plotW, 10, SWATCH_MAX));
    els.swatch.style.width = swatch + 'px';
    els.swatch.style.height = swatch + 'px';

    els.sliders.style.marginTop = d.rowGap + 'px';
    for (var t = 0; t < els.tracks.length; t++) {
      els.tracks[t].style.height = track + 'px';
      els.tracks[t].style.marginTop = (t === 0 ? 0 : d.trackGap) + 'px';
    }
    els.foot.style.marginTop = d.rowGap + 'px';

    if (changed) sliceCache.key = null;
    return changed;
  }

  function relayout() {
    if (layout()) requestRender({ plot: true, ramps: true });
    else requestRender({ ramps: true });
  }

  function bindResize() {
    var timer = null;
    function onResize() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; relayout(); }, 80);
    }
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(onResize).observe(els.panel); } catch (e) { /* the event below is the fallback */ }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onResize);
    }
  }

  function init() {
    els = {
      panel: $('gradientPanel'),
      groot: $('groot'),
      rampRow: $('gRampRow'),
      ramp: $('gRamp'),
      handles: $('gHandles'),
      plot: $('gPlot'),
      plotMarker: $('gPlotMarker'),
      swatch: $('gSwatch'),
      sliders: $('gSliders'),
      cTrack: $('gCTrack'), cThumb: $('gCThumb'),
      hTrack: $('gHTrack'), hThumb: $('gHThumb'),
      aTrack: $('gATrack'), aThumb: $('gAThumb'),
      foot: $('gFoot'),
      preset: $('gPreset'),
      action: $('gAction')
    };
    els.tracks = [els.cTrack, els.hTrack, els.aTrack];

    surfaces.ramp = new Surface($('gRampSurface'));
    surfaces.plot = new Surface($('gPlotSurface'));
    surfaces.c = new Surface($('gCTrackSurface'));
    surfaces.h = new Surface($('gHTrackSurface'));
    surfaces.a = new Surface($('gATrackSurface'));

    buildPresetList();
    rebuildHandles();
    refreshCurve();
    syncPreset();
    layout();
    bindRamp();
    bindControls();
    bindResize();
    els.action.addEventListener('click', function () {
      if (els.action.className.indexOf('enabled') >= 0) createLayer();
    });
    updateAction();
    requestRender({ plot: true, ramps: true });

    if (PS.available()) {
      PS.onDocumentChange(function () { syncFromHost(); });
      PS.onLayerChange(function () {
        // Ignore the echo of our own writes; anything else is the user working
        // in Photoshop, and the panel follows.
        if (pushInFlight || pushQueued) return;
        if (Date.now() - lastPushAt < 400) return;
        refreshLayer();
      });
    }
    syncFromHost();

    PS.registerPanel('okpicker.gradient', {
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
