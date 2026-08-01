'use strict';
/*
 * Thin bridge to the Photoshop UXP APIs.
 *
 * Every entry point degrades gracefully when the host is missing, so the same
 * files can be opened in a browser (or required from node) while working on the
 * UI.  `available()` tells the panel which controls to disable.
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

  /** Register the panel entry point so Photoshop can drive its lifecycle. */
  function registerPanel(id, handlers) {
    if (!uxp || !uxp.entrypoints || !uxp.entrypoints.setup) return false;
    var panels = {};
    panels[id] = handlers;
    try {
      uxp.entrypoints.setup({ panels: panels });
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    available: available,
    hostVersion: hostVersion,
    getDocumentInfo: getDocumentInfo,
    setColor: setColor,
    getColor: getColor,
    onDocumentChange: onDocumentChange,
    onSwatchChange: onSwatchChange,
    registerPanel: registerPanel
  };
});
