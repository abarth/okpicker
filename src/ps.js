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

  function activeDocument() {
    try { return ps.app.activeDocument || null; } catch (e) { return null; }
  }

  /** Photoshop's pixel API, for writing a layer mask without a tool. */
  function imaging() {
    try { return ps.imaging || null; } catch (e) { return null; }
  }

  /**
   * Name / colour mode / ICC profile / pixel size of the frontmost document.
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
      // The descriptor reports size in the ruler's unit, which may be inches;
      // the DOM always answers in pixels, so ask it first.
      var dom = activeDocument();
      var width = 0, height = 0;
      try {
        width = (dom && dom.width) || 0;
        height = (dom && dom.height) || 0;
      } catch (e) { /* fall back below */ }
      return {
        hasDocument: true,
        id: (d.documentID || (dom && dom.id) || 0),
        name: d.title || d.name || '',
        path: (d.fileReference && d.fileReference._path) || '',
        profile: d.profile || '',
        modeId: modeId || '',
        mode: MODE_LABELS[modeId] || modeId || '',
        depth: d.depth || 8,
        width: width > 0 ? width : 2000,
        height: height > 0 ? height : 1500,
        knownSize: width > 0 && height > 0
      };
    } catch (e) {
      return { hasDocument: false, reason: String((e && e.message) || e) };
    }
  }

  /**
   * Run `fn` as one undoable step.  Suspending history is what collapses a
   * dozen batchPlay commands into a single entry, so rebuilding a lighting
   * scheme costs the painter one press of undo rather than a dozen.
   */
  async function modal(name, fn) {
    if (!available()) throw new Error('Photoshop API is not available');
    return ps.core.executeAsModal(async function (context) {
      var suspension = null;
      var doc = activeDocument();
      try {
        if (doc && context.hostControl && context.hostControl.suspendHistory) {
          suspension = await context.hostControl.suspendHistory({
            documentID: doc.id, name: name
          });
        }
      } catch (e) { suspension = null; }
      try {
        return await fn(context);
      } finally {
        if (suspension !== null) {
          try { await context.hostControl.resumeHistory(suspension); } catch (e) { /* nothing to do */ }
        }
      }
    }, { commandName: name });
  }

  /**
   * The document's layers as plain objects, groups nested.  Used to find a
   * group the panel made earlier - by id first, since Photoshop keeps layer ids
   * in the file, and by name for a document that has been through something
   * that did not.
   */
  function layerTree() {
    var doc = activeDocument();
    if (!doc) return [];
    function walk(layers) {
      var out = [];
      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var node = {
          id: layer.id, name: layer.name, visible: layer.visible !== false,
          group: false, layers: []
        };
        try {
          if (layer.layers && layer.layers.length !== undefined) {
            node.group = true;
            node.layers = walk(layer.layers);
          }
        } catch (e) { /* not a group */ }
        out.push(node);
      }
      return out;
    }
    try { return walk(doc.layers); } catch (e) { return []; }
  }

  function findLayer(match) {
    var found = null;
    (function walk(nodes) {
      for (var i = 0; i < nodes.length && !found; i++) {
        if (match(nodes[i])) { found = nodes[i]; return; }
        if (nodes[i].layers.length) walk(nodes[i].layers);
      }
    })(layerTree());
    return found;
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

  // ------------------------------------------------------------------ files
  // Nothing is kept here between sessions.  A lighting scheme lives in the
  // document, written into the names of the layers it made, so that there is
  // one copy of it and it is inside the file it belongs to.  These two are for
  // moving a scheme between documents by hand.

  function fileSystem() {
    try { return uxp.storage.localFileSystem; } catch (e) { return null; }
  }

  /** Ask for somewhere to save, then write there.  Null if the user backed out. */
  async function saveAs(suggestedName, text) {
    var fs = fileSystem();
    if (!fs) return null;
    var file = await fs.getFileForSaving(suggestedName, { types: ['json'] });
    if (!file) return null;
    await file.write(text);
    return file.name || suggestedName;
  }

  async function openFile() {
    var fs = fileSystem();
    if (!fs) return null;
    var picked = await fs.getFileForOpening({ types: ['json'], allowMultiple: false });
    // Some UXP versions answer with a list even when asked for one file.
    var file = Array.isArray(picked) ? picked[0] : picked;
    if (!file) return null;
    return { name: file.name, text: await file.read() };
  }

  function panelsSupported() {
    return !!(uxp && uxp.entrypoints && uxp.entrypoints.setup);
  }

  var panelsRegistered = false;

  /**
   * Register every panel the plugin has, in one call.
   *
   * `setup` may be called exactly once, and the once has to cover every entry
   * point the manifest declares - it throws both on a second call and on data
   * that does not match.  A plugin with two panels that registers them one at a
   * time therefore ends up with neither, and because a plugin with more than
   * one panel is no longer shown the document's body, neither panel has
   * anything in it at all.  Hence one call, with all of them, from one place.
   */
  function registerPanels(panels) {
    if (!panelsSupported() || panelsRegistered) return false;
    try {
      uxp.entrypoints.setup({ panels: panels });
      panelsRegistered = true;
      return true;
    } catch (e) {
      console.error('okpicker: Photoshop refused the panel entry points', e);
      return false;
    }
  }

  return {
    available: available,
    hostVersion: hostVersion,
    batchPlay: batchPlay,
    modal: modal,
    activeDocument: activeDocument,
    imaging: imaging,
    getDocumentInfo: getDocumentInfo,
    layerTree: layerTree,
    findLayer: findLayer,
    setColor: setColor,
    getColor: getColor,
    onDocumentChange: onDocumentChange,
    onSwatchChange: onSwatchChange,
    saveAs: saveAs,
    openFile: openFile,
    panelsSupported: panelsSupported,
    registerPanels: registerPanels
  };
});
