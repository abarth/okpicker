'use strict';
/*
 * Thin bridge to the Photoshop UXP APIs.
 *
 * Every entry point degrades gracefully when the host is missing, so the same
 * files can be opened in a browser (or required from node) while working on the
 * UI.  `available()` tells the panel whether there is anything to sync with.
 */
(function (root, factory) {
  var api = factory();
  root.OKPhotoshop = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var ps = null;
  var uxp = null;

  if (typeof require === 'function') {
    try { ps = require('photoshop'); } catch (e) { ps = null; }
    try { uxp = require('uxp'); } catch (e) { uxp = null; }
  }

  function available() {
    return !!(ps && ps.app && ps.action);
  }

  function hostVersion() {
    try { return ps.app.version; } catch (e) { return null; }
  }

  function batchPlay(commands, options) {
    return ps.action.batchPlay(commands, options || {});
  }

  // ------------------------------------------------------------- document

  var MODE_LABELS = {
    RGBColor: 'RGB',
    CMYKColorEnum: 'CMYK',
    grayScale: 'Grayscale',
    labColor: 'Lab',
    duotone: 'Duotone',
    indexedColor: 'Indexed',
    bitmap: 'Bitmap',
    multichannel: 'Multichannel'
  };

  /**
   * Name / colour mode / ICC profile of the frontmost document.
   * Resolves to `{hasDocument:false}` rather than throwing when nothing is open.
   */
  async function getDocumentInfo() {
    if (!available()) return { hasDocument: false, reason: 'no-host' };
    try {
      var result = await batchPlay([{
        _obj: 'get',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
      }], { synchronousExecution: false });
      var d = result && result[0];
      if (!d) return { hasDocument: false };
      var modeId = d.mode && d.mode._value;
      return {
        hasDocument: true,
        name: d.title || d.name || '',
        profile: d.profile || '',
        modeId: modeId || '',
        mode: MODE_LABELS[modeId] || modeId || '',
        depth: d.depth || 8
      };
    } catch (e) {
      return { hasDocument: false, reason: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------- colours

  function colorDescriptor(color) {
    if (color.lab) {
      return {
        _obj: 'labColor',
        luminance: color.lab[0],
        a: color.lab[1],
        b: color.lab[2]
      };
    }
    return {
      _obj: 'RGBColor',
      red: color.rgb[0],
      // Photoshop's RGBColor descriptor really does call the green channel
      // "grain" - a decades-old key name, not a typo.
      grain: color.rgb[1],
      blue: color.rgb[2]
    };
  }

  /**
   * Push a colour to the foreground or background swatch.
   * `color` is `{lab:[L,a,b]}` (device independent, preferred) or
   * `{rgb:[r,g,b]}` in 0..255 document values.
   */
  async function setColor(which, color) {
    if (!available()) throw new Error('Photoshop API is not available');
    var property = which === 'background' ? 'backgroundColor' : 'foregroundColor';
    var descriptor = {
      _obj: 'set',
      _target: [{ _ref: 'color', _property: property }],
      to: colorDescriptor(color),
      source: 'photoshopPicker'
    };
    await ps.core.executeAsModal(async function () {
      await batchPlay([descriptor], {});
    }, { commandName: 'Set OKLCH colour' });
  }

  function readSolidColor(solid) {
    if (!solid) return null;
    try {
      var lab = solid.lab;
      if (lab && typeof lab.l === 'number' && isFinite(lab.l)) {
        return { lab: [lab.l, lab.a, lab.b] };
      }
    } catch (e) { /* fall through to RGB */ }
    try {
      var rgb = solid.rgb;
      if (rgb && typeof rgb.red === 'number') {
        return { rgb: [rgb.red, rgb.green, rgb.blue] };
      }
    } catch (e) { /* fall through to batchPlay */ }
    return null;
  }

  /** Current foreground/background swatch, as Lab when Photoshop offers it. */
  async function getColor(which) {
    if (!available()) return null;
    var property = which === 'background' ? 'backgroundColor' : 'foregroundColor';
    var direct = readSolidColor(which === 'background' ? ps.app.backgroundColor : ps.app.foregroundColor);
    if (direct) return direct;
    try {
      var result = await batchPlay([{
        _obj: 'get',
        _target: [
          { _property: property },
          { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }
        ]
      }], { synchronousExecution: false });
      var c = result && result[0] && result[0][property];
      if (!c) return null;
      if (c._obj === 'labColor') return { lab: [c.luminance, c.a, c.b] };
      if (c._obj === 'RGBColor') return { rgb: [c.red, c.grain, c.blue] };
      return null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------ gradient map

  /**
   * Which of Photoshop's gradient interpolation rules to ask for: 'Perc'
   * (OKLab, the default since 2023), 'Lnr' (linear light) or 'Classic'.
   *
   * Left null on purpose.  The exact enum spellings are not documented, and a
   * wrong one would fail the whole descriptor - while the stop list is refined
   * until all three rules reproduce the design to within half an 8-bit step, so
   * inheriting whatever the host is set to costs nothing.  Set this once the
   * spelling has been confirmed against a real Photoshop.
   */
  var INTERPOLATION_METHOD = null;

  /**
   * A `gradientMapClass` descriptor built from a stop list.
   * Stop colours are passed as fractional 0..255 doubles rather than rounded
   * bytes, which is what a 16-bit document needs.
   */
  function gradientMapDescriptor(stops, name) {
    var desc = {
      _obj: 'gradientMapClass',
      gradient: {
        _obj: 'gradientClassEvent',
        name: name || 'OKLCH',
        gradientForm: { _enum: 'gradientForm', _value: 'customStops' },
        // Photoshop's "smoothness", under a key name that is a decades-old
        // accident rather than a typo.  Zero asks for straight interpolation
        // between stops, which is the one the panel simulates.
        interfaceIconFrameDimmed: 0,
        colors: stops.map(function (s) {
          return {
            _obj: 'colorStop',
            color: {
              _obj: 'RGBColor',
              red: channel255(s.encoded[0]),
              // Photoshop really does call the green channel "grain".
              grain: channel255(s.encoded[1]),
              blue: channel255(s.encoded[2])
            },
            type: { _enum: 'colorStopType', _value: 'userStop' },
            location: s.location,
            midpoint: 50
          };
        }),
        transparency: [
          opacityStop(0),
          opacityStop(4096)
        ]
      }
    };
    if (INTERPOLATION_METHOD) {
      desc.gradientsInterpolationMethod = {
        _enum: 'gradientInterpolationMethodType',
        _value: INTERPOLATION_METHOD
      };
    }
    return desc;
  }

  function channel255(v) {
    var x = v * 255;
    return x < 0 ? 0 : (x > 255 ? 255 : x);
  }

  function opacityStop(location) {
    return {
      _obj: 'transferSpec',
      opacity: { _unit: 'percentUnit', _value: 100 },
      location: location,
      midpoint: 50
    };
  }

  /**
   * The selected layer, if it is a gradient map.
   * The panel edits the layer the user has selected and nothing else, so there
   * is never a hidden write to a layer they are not looking at.
   */
  async function getGradientMapLayer() {
    if (!available()) return { hasLayer: false, reason: 'no-host' };
    try {
      var result = await batchPlay([{
        _obj: 'get',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
      }], { synchronousExecution: false });
      var layer = result && result[0];
      if (!layer) return { hasLayer: false };
      var adjustment = layer.adjustment && layer.adjustment[0];
      if (!adjustment || adjustment._obj !== 'gradientMapClass') {
        return { hasLayer: false, layerName: layer.name || '' };
      }
      return {
        hasLayer: true,
        layerId: layer.layerID,
        layerName: layer.name || '',
        gradientName: (adjustment.gradient && adjustment.gradient.name) || ''
      };
    } catch (e) {
      return { hasLayer: false, reason: String((e && e.message) || e) };
    }
  }

  /** Add a gradient map adjustment layer above the selection. */
  async function createGradientMap(descriptor) {
    if (!available()) throw new Error('Photoshop API is not available');
    await ps.core.executeAsModal(async function () {
      await batchPlay([{
        _obj: 'make',
        _target: [{ _ref: 'adjustmentLayer' }],
        using: { _obj: 'adjustmentLayer', type: descriptor }
      }], {});
    }, { commandName: 'Add OKLCH gradient map' });
  }

  /** Replace the selected gradient map's gradient. */
  async function updateGradientMap(descriptor) {
    if (!available()) throw new Error('Photoshop API is not available');
    await ps.core.executeAsModal(async function () {
      await batchPlay([{
        _obj: 'set',
        _target: [{ _ref: 'adjustmentLayer', _enum: 'ordinal', _value: 'targetEnum' }],
        to: descriptor
      }], {});
    }, { commandName: 'Edit OKLCH gradient map' });
  }

  // ---------------------------------------------------------- notifications

  var DOCUMENT_EVENTS = [
    'open', 'close', 'select', 'make', 'newDocument',
    'assignProfile', 'convertToProfile', 'convertMode'
  ];

  function addListener(events, handler) {
    if (!available() || !ps.action.addNotificationListener) return function () {};
    var descriptors = events.map(function (e) { return { event: e }; });
    try {
      ps.action.addNotificationListener(descriptors, handler);
    } catch (e) {
      return function () {};
    }
    return function () {
      try {
        if (ps.action.removeNotificationListener) {
          ps.action.removeNotificationListener(descriptors, handler);
        }
      } catch (e) { /* nothing useful to do */ }
    };
  }

  /** Fires when the active document, its profile, or its mode changes. */
  function onDocumentChange(callback) {
    return addListener(DOCUMENT_EVENTS, function () { callback(); });
  }

  var LAYER_EVENTS = [
    'select', 'make', 'delete', 'move', 'hide', 'show', 'set', 'undo', 'redo',
    'historyStateChanged'
  ];

  /** Fires when the selected layer, or its content, may have changed. */
  function onLayerChange(callback) {
    return addListener(LAYER_EVENTS, function () { callback(); });
  }

  /** Fires when the user changes the foreground/background swatch elsewhere. */
  function onSwatchChange(callback) {
    return addListener(['set'], function (event, descriptor) {
      try {
        var target = descriptor && descriptor._target && descriptor._target[0];
        if (!target) return;
        if (target._property === 'foregroundColor') callback('foreground', descriptor);
        else if (target._property === 'backgroundColor') callback('background', descriptor);
      } catch (e) { /* ignore malformed notifications */ }
    });
  }

  var pendingPanels = null;

  /**
   * Register a panel entry point so Photoshop can drive its lifecycle.
   *
   * `entrypoints.setup` takes every panel at once and may only be called once,
   * so registrations are collected and handed over together on the next turn of
   * the event loop - by which time each panel's controller has had its say.
   */
  function registerPanel(id, handlers) {
    if (!uxp || !uxp.entrypoints || !uxp.entrypoints.setup) return false;
    if (!pendingPanels) {
      pendingPanels = {};
      setTimeout(function () {
        var panels = pendingPanels;
        pendingPanels = null;
        try {
          uxp.entrypoints.setup({ panels: panels });
        } catch (e) {
          console.error('okpicker: could not register the panels', e);
        }
      }, 0);
    }
    pendingPanels[id] = handlers;
    return true;
  }

  return {
    available: available,
    hostVersion: hostVersion,
    getDocumentInfo: getDocumentInfo,
    setColor: setColor,
    getColor: getColor,
    onDocumentChange: onDocumentChange,
    onSwatchChange: onSwatchChange,
    onLayerChange: onLayerChange,
    registerPanel: registerPanel,

    gradientMapDescriptor: gradientMapDescriptor,
    getGradientMapLayer: getGradientMapLayer,
    createGradientMap: createGradientMap,
    updateGradientMap: updateGradientMap
  };
});
