'use strict';
/*
 * Panel controller: owns the OKLCH state, schedules repaints and talks to
 * Photoshop.  Loaded last; depends on the globals published by the other
 * scripts in index.html.
 */
(function () {

  var OKColor = globalThis.OKColor;
  var OKPng = globalThis.OKPng;
  var OKRender = globalThis.OKRender;
  var PS = globalThis.OKPhotoshop;
  var doc = document;

  function $(id) { return doc.getElementById(id); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
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
      if (el.width !== img.width || el.height !== img.height) {
        el.width = img.width;
        el.height = img.height;
      }
      var ctx = el.getContext('2d');
      var id = ctx.createImageData(img.width, img.height);
      id.data.set(img.data);
      ctx.clearRect(0, 0, img.width, img.height);
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
    target: 'document',
    clampChroma: true,
    autoApply: false,
    docSpaceId: 'srgb',
    docNote: '',
    docWarn: false,
    doc: { hasDocument: false }
  };

  var els = {};
  var surfaces = {};
  var plotSize = 180;
  var maxCCache = {};
  var lastSelfApply = 0;

  function activeSpaceId() {
    return state.target === 'document' ? state.docSpaceId : state.target;
  }

  function activeSpace() {
    return OKColor.getSpace(activeSpaceId()) || OKColor.spaces.srgb;
  }

  /** Chroma at the outer edge of the diagram: the space's own maximum plus a
   *  little headroom so the shape never touches the border. */
  function plotMaxC() {
    var id = activeSpaceId();
    if (maxCCache[id] === undefined) {
      maxCCache[id] = Math.ceil(OKColor.spaceMaxChroma(activeSpace()) * 1.06 * 200) / 200;
    }
    return maxCCache[id];
  }

  function gamutChroma() {
    return OKColor.maxChroma(activeSpace(), state.L, state.H, 22);
  }

  /** Re-derive the effective chroma after L, H, the gamut or the clamp change. */
  function reconcileChroma() {
    var c = Math.min(state.desiredC, plotMaxC());
    if (state.clampChroma) c = Math.min(c, gamutChroma());
    state.C = c;
  }

  function setColor(next, opts) {
    opts = opts || {};
    var plotDirty = !!opts.plot;
    if (next.L !== undefined) {
      var L = clamp01(next.L);
      if (L !== state.L) plotDirty = true;
      state.L = L;
    }
    if (next.H !== undefined) state.H = wrapHue(next.H);
    if (next.C !== undefined) state.desiredC = Math.max(0, next.C);
    reconcileChroma();
    requestRender({ plot: plotDirty, ramps: true, draft: opts.draft });
  }

  // --------------------------------------------------------------- painting

  var dirty = { plot: true, l: true, c: true, h: true, vramp: true };
  var frameQueued = false;
  var draftQuality = false;
  var settleTimer = null;

  function requestRender(opts) {
    opts = opts || {};
    if (opts.plot) { dirty.plot = true; }
    if (opts.ramps) { dirty.l = true; dirty.c = true; dirty.h = true; dirty.vramp = true; }
    if (opts.draft) draftQuality = true;
    if (!frameQueued) {
      frameQueued = true;
      raf(function () {
        frameQueued = false;
        try { renderFrame(); } catch (e) { setStatus(String(e && e.message || e), true); }
      });
    }
    if (opts.draft) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(function () {
        settleTimer = null;
        draftQuality = false;
        requestRender({ plot: true, ramps: true });
      }, 150);
    }
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

  function renderFrame() {
    var space = activeSpace();
    var maxC = plotMaxC();
    // Canvas takes a bitmap straight from memory, so it can afford more pixels
    // than the PNG-through-a-data-URI fallback.
    var plotCap = surfaces.plot.kind === 'canvas' ? 448 : 320;

    if (dirty.plot) {
      var size = draftQuality
        ? 128
        : Math.max(160, Math.min(plotCap, Math.round(plotSize * pixelRatio())));
      var env = OKColor.chromaEnvelope(space, state.L, draftQuality ? 180 : 720, draftQuality ? 14 : 20);
      surfaces.plot.paint(OKRender.chPlot({
        space: space, L: state.L, maxC: maxC, size: size,
        envelope: env, outline: outlineColor()
      }));
      dirty.plot = false;
    }

    var ratio = pixelRatio();
    var rampHeight = Math.round(18 * ratio);

    if (dirty.vramp) {
      surfaces.vramp.paint(OKRender.lightnessRamp({
        space: space, C: state.C, H: state.H,
        width: Math.round(22 * ratio),
        height: Math.max(80, Math.min(420, Math.round(plotSize * ratio))),
        vertical: true
      }));
      dirty.vramp = false;
    }

    if (dirty.l) {
      surfaces.l.paint(OKRender.lightnessRamp({
        space: space, C: state.C, H: state.H,
        width: trackWidth(els.lTrack), height: rampHeight
      }));
      dirty.l = false;
    }

    if (dirty.c) {
      surfaces.c.paint(OKRender.chromaRamp({
        space: space, L: state.L, H: state.H, maxC: maxC,
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
    updateReadout();
  }

  function updateMarkers() {
    var f = OKRender.markerFraction(state.C, state.H, plotMaxC());
    els.plotMarker.style.left = (f.x * 100) + '%';
    els.plotMarker.style.top = (f.y * 100) + '%';
    els.lRampThumb.style.top = ((1 - state.L) * 100) + '%';
    els.lThumb.style.left = (state.L * 100) + '%';
    els.cThumb.style.left = (clamp01(state.C / plotMaxC()) * 100) + '%';
    els.hThumb.style.left = ((state.H / 360) * 100) + '%';
  }

  function setValue(el, text) {
    // Never fight with a field the user is typing into; edits are written back
    // explicitly when they are committed.
    if (doc.activeElement !== el) el.value = text;
  }

  function formatL() { return (state.L * 100).toFixed(2); }
  function formatC() { return state.C.toFixed(4); }
  function formatH() { return state.H.toFixed(2); }

  function currentHex() {
    return OKColor.describe(activeSpace(), state.L, state.C, state.H).docHex;
  }

  function updateReadout() {
    var space = activeSpace();
    var info = OKColor.describe(space, state.L, state.C, state.H);
    els.swatch.style.backgroundColor = info.displayHex;
    if (info.inGamut) els.swatch.classList.remove('clipped');
    else els.swatch.classList.add('clipped');

    setValue(els.hexInput, info.docHex);
    setValue(els.lValue, formatL());
    setValue(els.cValue, formatC());
    setValue(els.hValue, formatH());
    els.oklchOut.textContent = OKColor.formatOklch(state.L, state.C, state.H);
    els.cLimit.textContent = '/ ' + gamutChroma().toFixed(3);
  }

  var statusTimer = null;

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    if (isError) els.status.classList.add('error');
    else els.status.classList.remove('error');
    if (statusTimer) clearTimeout(statusTimer);
    if (text) {
      statusTimer = setTimeout(function () {
        statusTimer = null;
        els.status.textContent = '';
        els.status.classList.remove('error');
      }, 5000);
    }
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

  function interactionEnd() {
    if (state.autoApply) applyColor('foreground');
  }

  /**
   * Wire up one of the numeric fields.  `format` reports the canonical text for
   * the current state and is written straight back after every edit, so a value
   * the gamut clamp rejected never lingers in the box.
   */
  function bindNumeric(el, step, apply, format) {
    function commit() {
      var v = parseFloat(String(el.value).replace(/[^0-9.eE+-]/g, ''));
      if (isFinite(v)) apply(v);
      el.value = format();
      updateReadout();
    }
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', function (e) {
      var key = e.key;
      if (key === 'Enter') {
        commit();
        if (state.autoApply) applyColor('foreground');
        return;
      }
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
      var v = parseFloat(String(el.value).replace(/[^0-9.eE+-]/g, ''));
      if (!isFinite(v)) return;
      if (e.preventDefault) e.preventDefault();
      apply(v + step * (e.shiftKey ? 10 : 1) * (key === 'ArrowUp' ? 1 : -1));
      el.value = format();
      updateReadout();
    });
  }

  // ------------------------------------------------------------- Photoshop

  function describeTarget() {
    var space = activeSpace();
    if (state.target !== 'document') return space.label + ' (manual)';
    return state.docNote || space.label;
  }

  function updateDocBar() {
    var info = state.doc;
    if (!PS.available()) {
      els.docName.textContent = 'Preview mode';
    } else if (!info.hasDocument) {
      els.docName.textContent = 'No document';
    } else {
      els.docName.textContent = info.name || 'Untitled';
    }
    els.docProfile.textContent = describeTarget();
    if (state.docWarn && state.target === 'document') els.docProfile.classList.add('warn');
    else els.docProfile.classList.remove('warn');

    var hasHost = PS.available();
    els.fgBtn.disabled = !hasHost;
    els.bgBtn.disabled = !hasHost;
    els.pickBtn.disabled = !hasHost;
  }

  async function refreshDocument() {
    var previousSpace = activeSpaceId();
    var info = { hasDocument: false };
    if (PS.available()) {
      info = await PS.getDocumentInfo();
    }
    state.doc = info;
    state.docWarn = false;

    if (!PS.available()) {
      state.docSpaceId = 'srgb';
      state.docNote = 'sRGB (Photoshop not connected)';
      state.docWarn = true;
    } else if (!info.hasDocument) {
      state.docSpaceId = 'srgb';
      state.docNote = 'sRGB (no document)';
    } else if (info.modeId && info.modeId !== 'RGBColor') {
      // We can only compute a gamut hull for the RGB working spaces we know the
      // primaries of; an ICC CMYK/Gray gamut would need the profile itself.
      state.docSpaceId = 'srgb';
      state.docNote = info.mode + ' document — showing sRGB';
      state.docWarn = true;
    } else {
      var match = OKColor.matchProfile(info.profile);
      if (match && match.exact) {
        state.docSpaceId = match.spaceId;
        state.docNote = info.profile;
      } else if (match) {
        state.docSpaceId = match.spaceId;
        state.docNote = info.profile + ' ≈ ' + OKColor.getSpace(match.spaceId).label;
        state.docWarn = true;
      } else {
        state.docSpaceId = 'srgb';
        state.docNote = (info.profile || 'Unknown profile') + ' → sRGB';
        state.docWarn = true;
      }
    }

    updateDocBar();
    reconcileChroma();
    requestRender({ plot: activeSpaceId() !== previousSpace, ramps: true });
  }

  async function applyColor(which) {
    if (!PS.available()) {
      setStatus('Photoshop API is not available in this context', true);
      return;
    }
    var info = OKColor.describe(activeSpace(), state.L, state.C, state.H);
    lastSelfApply = Date.now();
    try {
      await PS.setColor(which, { lab: info.lab });
      setStatus((which === 'background' ? 'Background' : 'Foreground') + ' set to ' + info.docHex +
        (info.inGamut ? '' : ' (clipped to gamut)'));
    } catch (e) {
      try {
        await PS.setColor(which, { rgb: info.doc255 });
        setStatus((which === 'background' ? 'Background' : 'Foreground') + ' set via RGB fallback');
      } catch (e2) {
        setStatus('Could not set colour: ' + (e2 && e2.message ? e2.message : e2), true);
      }
    }
  }

  async function pickUpColor() {
    if (!PS.available()) {
      setStatus('Photoshop API is not available in this context', true);
      return;
    }
    var c = await PS.getColor('foreground');
    if (!c) {
      setStatus('Could not read the foreground colour', true);
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
    state.L = clamp01(lch[0]);
    state.H = wrapHue(lch[2]);
    state.desiredC = lch[1];
    reconcileChroma();
    requestRender({ plot: true, ramps: true });
    setStatus('Loaded ' + OKColor.formatOklch(state.L, state.C, state.H));
  }

  async function copy(text) {
    try {
      var ok = await PS.copyText(text);
      setStatus(ok ? 'Copied ' + text : 'Clipboard is not available', !ok);
    } catch (e) {
      setStatus('Clipboard is not available', true);
    }
  }

  // ------------------------------------------------------------------ setup

  function layout() {
    var width = 0;
    try { width = els.root.getBoundingClientRect().width; } catch (e) { width = 0; }
    if (!(width > 0)) width = 260;
    var size = Math.round(width - 30); // vertical ramp (22) + its margin (8)
    plotSize = Math.max(110, Math.min(420, size));
    els.plot.style.width = plotSize + 'px';
    els.plot.style.height = plotSize + 'px';
    els.lRamp.style.height = plotSize + 'px';
  }

  function buildTargetOptions() {
    var select = els.targetSelect;
    var options = [{ value: 'document', label: 'Document profile' }];
    OKColor.spaceList.forEach(function (sp) {
      options.push({ value: sp.id, label: sp.label });
    });
    options.forEach(function (o) {
      var el = doc.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      select.appendChild(el);
    });
    select.value = state.target;
  }

  function bindEvents() {
    var maxC = plotMaxC;

    bindDrag(els.plot, function (f) {
      var v = OKRender.fractionToCh(f.x, f.y, maxC());
      setColor({ C: v.C, H: v.H }, { draft: true });
    }, interactionEnd);

    bindDrag(els.lRamp, function (f) {
      setColor({ L: 1 - clamp01(f.y) }, { draft: true, plot: true });
    }, interactionEnd);

    bindDrag(els.lTrack, function (f) {
      setColor({ L: clamp01(f.x) }, { draft: true, plot: true });
    }, interactionEnd);

    bindDrag(els.cTrack, function (f) {
      setColor({ C: clamp01(f.x) * maxC() }, { draft: true });
    }, interactionEnd);

    bindDrag(els.hTrack, function (f) {
      setColor({ H: clamp01(f.x) * 360 }, { draft: true });
    }, interactionEnd);

    bindNumeric(els.lValue, 0.5,
      function (v) { setColor({ L: v / 100 }, { plot: true }); }, formatL);
    bindNumeric(els.cValue, 0.005,
      function (v) { setColor({ C: v }); }, formatC);
    bindNumeric(els.hValue, 1,
      function (v) { setColor({ H: v }); }, formatH);

    function commitHex() {
      var enc = OKColor.parseHex(els.hexInput.value);
      if (!enc) {
        els.hexInput.value = currentHex();
        setStatus('Enter a hex colour such as #3A7BD5', true);
        return;
      }
      var space = activeSpace();
      var lin = OKColor.decodeChannels(space, enc);
      var lch = OKColor.linearToOklch(space, lin[0], lin[1], lin[2]);
      state.L = clamp01(lch[0]);
      state.H = wrapHue(lch[2]);
      state.desiredC = lch[1];
      reconcileChroma();
      els.hexInput.value = currentHex();
      requestRender({ plot: true, ramps: true });
      if (state.autoApply) applyColor('foreground');
    }
    els.hexInput.addEventListener('change', commitHex);
    els.hexInput.addEventListener('blur', commitHex);
    els.hexInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') commitHex();
    });

    els.targetSelect.addEventListener('change', function () {
      state.target = els.targetSelect.value;
      updateDocBar();
      reconcileChroma();
      requestRender({ plot: true, ramps: true });
    });

    els.clampCheck.addEventListener('change', function () {
      state.clampChroma = !!els.clampCheck.checked;
      reconcileChroma();
      requestRender({ ramps: true });
    });

    els.autoApplyCheck.addEventListener('change', function () {
      state.autoApply = !!els.autoApplyCheck.checked;
      if (state.autoApply) applyColor('foreground');
    });

    els.fgBtn.addEventListener('click', function () { applyColor('foreground'); });
    els.bgBtn.addEventListener('click', function () { applyColor('background'); });
    els.pickBtn.addEventListener('click', function () { pickUpColor(); });
    els.refreshBtn.addEventListener('click', function () { refreshDocument(); });
    els.copyHexBtn.addEventListener('click', function () { copy(els.hexInput.value); });
    els.copyCssBtn.addEventListener('click', function () {
      copy(OKColor.formatOklch(state.L, state.C, state.H));
    });

    var resizeTimer = null;
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          resizeTimer = null;
          layout();
          requestRender({ plot: true, ramps: true });
        }, 120);
      });
    }
  }

  function init() {
    els = {
      root: $('root'),
      plot: $('plot'),
      plotMarker: $('plotMarker'),
      lRamp: $('lRamp'),
      lRampThumb: $('lRampThumb'),
      swatch: $('swatch'),
      hexInput: $('hexInput'),
      oklchOut: $('oklchOut'),
      copyHexBtn: $('copyHexBtn'),
      copyCssBtn: $('copyCssBtn'),
      lTrack: $('lTrack'), lThumb: $('lThumb'), lValue: $('lValue'),
      cTrack: $('cTrack'), cThumb: $('cThumb'), cValue: $('cValue'), cLimit: $('cLimit'),
      hTrack: $('hTrack'), hThumb: $('hThumb'), hValue: $('hValue'),
      targetSelect: $('targetSelect'),
      clampCheck: $('clampCheck'),
      autoApplyCheck: $('autoApplyCheck'),
      fgBtn: $('fgBtn'), bgBtn: $('bgBtn'), pickBtn: $('pickBtn'),
      refreshBtn: $('refreshBtn'),
      docName: $('docName'), docProfile: $('docProfile'),
      status: $('status')
    };

    surfaces.plot = new Surface($('plotSurface'));
    surfaces.vramp = new Surface($('lRampSurface'));
    surfaces.l = new Surface($('lTrackSurface'));
    surfaces.c = new Surface($('cTrackSurface'));
    surfaces.h = new Surface($('hTrackSurface'));

    buildTargetOptions();
    layout();
    bindEvents();
    updateDocBar();
    reconcileChroma();
    requestRender({ plot: true, ramps: true });

    if (PS.available()) {
      PS.onDocumentChange(function () { refreshDocument(); });
      PS.onSwatchChange(function (which) {
        if (which !== 'foreground') return;
        if (Date.now() - lastSelfApply < 1500) return; // our own write coming back
        setStatus('Foreground changed in Photoshop — press "Pick up" to load it');
      });
    }
    // Also runs without a host: it is what labels the fallback target.
    refreshDocument();

    PS.registerPanel('okpicker.panel', {
      create: function () {},
      show: function () { layout(); requestRender({ plot: true, ramps: true }); refreshDocument(); },
      hide: function () {},
      destroy: function () {},
      menuItems: [
        { id: 'copyCss', label: 'Copy CSS oklch()' },
        { id: 'copyHex', label: 'Copy hex' },
        { id: 'pickUp', label: 'Pick up foreground colour' },
        { id: 'reset', label: 'Reset picker' }
      ],
      invokeMenu: function (id) {
        if (id === 'copyCss') copy(OKColor.formatOklch(state.L, state.C, state.H));
        else if (id === 'copyHex') copy(els.hexInput.value);
        else if (id === 'pickUp') pickUpColor();
        else if (id === 'reset') {
          state.L = 0.68;
          state.desiredC = 0.14;
          state.H = 250;
          reconcileChroma();
          requestRender({ plot: true, ramps: true });
        }
      }
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
