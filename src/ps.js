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
        var node = { id: layer.id, name: layer.name, group: false, layers: [] };
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
  // The plugin's own data folder is where a lighting scheme lives between
  // sessions, keyed to the document it was written for.  It is not inside the
  // PSD - a UXP plugin has no way to put it there - so there are also plain
  // Save and Load, and a scheme file is small enough to keep next to the
  // artwork or hand to somebody else.

  function fileSystem() {
    try { return uxp.storage.localFileSystem; } catch (e) { return null; }
  }

  async function dataFolder() {
    var fs = fileSystem();
    if (!fs) return null;
    try { return await fs.getDataFolder(); } catch (e) { return null; }
  }

  /** Contents of a file in the plugin's data folder, or null if it is not there. */
  async function readData(name) {
    var folder = await dataFolder();
    if (!folder) return null;
    try {
      var entry = await folder.getEntry(name);
      return entry ? await entry.read() : null;
    } catch (e) {
      return null;
    }
  }

  async function writeData(name, text) {
    var folder = await dataFolder();
    if (!folder) return false;
    try {
      var file = await folder.createFile(name, { overwrite: true });
      await file.write(text);
      return true;
    } catch (e) {
      return false;
    }
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
    batchPlay: batchPlay,
    modal: modal,
    activeDocument: activeDocument,
    getDocumentInfo: getDocumentInfo,
    layerTree: layerTree,
    findLayer: findLayer,
    setColor: setColor,
    getColor: getColor,
    onDocumentChange: onDocumentChange,
    onSwatchChange: onSwatchChange,
    readData: readData,
    writeData: writeData,
    saveAs: saveAs,
    openFile: openFile,
    registerPanel: registerPanel
  };
});
