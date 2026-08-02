'use strict';
/*
 * The underpaint panel: designing the light in a picture, rather than the
 * gradients and masks that will carry it.
 *
 * Everything on screen edits one small object - the scheme - and everything
 * below the buttons is regenerated from it.  Nothing here decides what a light
 * does to a tone or what colour a stop should be; scheme.js holds the ideas,
 * gradient.js turns them into gradients, apply.js puts them in the document.
 * This file is the part that draws the two pictures and moves the numbers.
 *
 * The two pictures parameterise each other.  The frame shows where the lights
 * fall, at the value picked on the ramp; the ramp shows what happens to the
 * whole value range, at the point picked in the frame.  Between them you can
 * see both halves of a lighting scheme - which is the thing Photoshop's own
 * gradient and mask editors cannot show you at all.
 *
 * The panel's markup is built here rather than in index.html: half of it is a
 * list that changes as lights come and go, and building the fixed half the same
 * way keeps one description of the panel instead of two.
 */
(function () {

  var OKColor = globalThis.OKColor;
  var OKRender = globalThis.OKRender;
  var OKDom = globalThis.OKDom;
  var OKScheme = globalThis.OKScheme;
  var OKBlend = globalThis.OKBlend;
  var OKGradient = globalThis.OKGradient;
  var OKApply = globalThis.OKApply;
  var PS = globalThis.OKPhotoshop;
  var doc = document;

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : function (fn) { return setTimeout(fn, 16); };

  // Where the ramp's marker starts, and how much of the value range the frame
  // preview spreads around it.  A frame drawn at one tone would show nothing at
  // all of a light that lives in the shadows, so it is drawn over a stand-in
  // for a drawing instead: light at the top, dark at the bottom, the way most
  // pictures are lit.  Sliding the marker moves that window up and down.
  var DEFAULT_TONE = 0.52;
  var TONE_SPREAD = 0.6;
  var FIELD_WIDTH = 190;   // pixels the lighting map is computed at
  var RAMP_SAMPLES = 65;

  // ------------------------------------------------------------------ state

  var state = {
    scheme: OKScheme.create('goldenHour'),
    selected: '',
    probe: { x: 0.5, y: 0.45 },
    tone: DEFAULT_TONE,
    spaceId: 'srgb',
    frame: { width: 2000, height: 1500 },
    document: null,
    key: '',
    status: 'Pick a palette, place the lights, then build.',
    busy: false
  };

  var els = {};
  var lightRows = {};
  var handles = {};
  var compiled = null;

  function space() {
    return OKColor.getSpace(state.spaceId) || OKColor.spaces.srgb;
  }

  function context() {
    return { space: space() };
  }

  function selectedLight() {
    return OKScheme.findLight(state.scheme, state.selected) ||
      state.scheme.lights[state.scheme.lights.length - 1] || null;
  }

  /** Everything downstream of the scheme is derived, so throw it away together. */
  function changed(scheme) {
    if (scheme) state.scheme = scheme;
    compiled = null;
    requestRender();
  }

  function status(message) {
    state.status = message;
    if (els.status) els.status.textContent = message;
  }

  // -------------------------------------------------------- little widgets

  function make(tag, className, parent) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function label(parent, className, string) {
    var node = make('div', className, parent);
    node.textContent = string;
    return node;
  }

  /**
   * A labelled track with a painted ramp behind it.  `paint` is called with the
   * pixel size when the panel repaints, and returns an image or nothing.
   */
  function Slider(parent, name, opts) {
    var row = make('div', 'field', parent);
    label(row, 'name', name);
    var track = make('div', 'track', row);
    this.surface = new OKDom.Surface(make('div', 'surface', track));
    this.thumb = make('div', 'thumb', track);
    this.readout = make('div', 'readout', row);
    this.track = track;
    this.row = row;
    this.paint = opts.paint;
    OKDom.bindDrag(track, function (f) { opts.change(clamp01(f.x)); }, opts.done);
  }

  Slider.prototype.update = function (fraction, readout) {
    this.thumb.style.left = (clamp01(fraction) * 100) + '%';
    this.readout.textContent = readout;
  };

  Slider.prototype.repaint = function (height) {
    var width = Math.max(40, Math.round(this.track.getBoundingClientRect().width || 120));
    var img = this.paint(width, height);
    if (img) this.surface.paint(img);
  };

  Slider.prototype.show = function (visible) {
    this.row.style.display = visible ? '' : 'none';
  };

  /** A row of buttons where exactly one is on. */
  function Choice(parent, name, options, onPick) {
    var row = make('div', 'field', parent);
    if (name) label(row, 'name', name);
    var group = make('div', 'choice', row);
    this.buttons = options.map(function (option) {
      var button = make('div', 'chip', group);
      button.textContent = option.label;
      if (option.hint) button.setAttribute('title', option.hint);
      button.addEventListener('click', function () { onPick(option.id); });
      return { id: option.id, el: button };
    });
    this.row = row;
  }

  Choice.prototype.update = function (id) {
    this.buttons.forEach(function (button) {
      button.el.className = button.id === id ? 'chip on' : 'chip';
    });
  };

  Choice.prototype.show = function (visible) {
    this.row.style.display = visible ? '' : 'none';
  };

  // ------------------------------------------------------------- the panel

  function build(root) {
    var body = make('div', 'paintbody', root);

    // -- scheme
    var head = make('div', 'row', body);
    els.name = make('input', 'name-input', head);
    els.name.setAttribute('type', 'text');
    els.name.setAttribute('spellcheck', 'false');
    els.name.setAttribute('title', 'What the group of layers will be called');
    // Both events, because hosts differ on which of them a text field sends.
    onText(els.name, function () {
      state.scheme.name = els.name.value;
    });

    els.palette = make('select', 'palette', head);
    OKScheme.palettes.forEach(function (palette) {
      var option = make('option', '', els.palette);
      option.value = palette.id;
      option.textContent = palette.label;
      option.setAttribute('title', palette.note);
    });
    els.palette.addEventListener('change', function () {
      var scheme = OKScheme.create(els.palette.value);
      // The group in the document belongs to the panel, not to the palette:
      // switching palettes rebuilds the same folder rather than starting a
      // second one beside it.
      scheme.groupId = state.scheme.groupId;
      scheme.groupName = state.scheme.groupName;
      state.selected = scheme.lights.length ? scheme.lights[0].id : '';
      changed(scheme);
      status(OKScheme.getPalette(els.palette.value).note);
    });

    // -- the value ramp
    els.ramp = make('div', 'ramp', body);
    els.rampSurface = new OKDom.Surface(make('div', 'surface', els.ramp));
    els.rampMark = make('div', 'rampmark', els.ramp);
    OKDom.bindDrag(els.ramp, function (f) {
      state.tone = clamp01(f.x);
      requestRender();
    });
    els.rampNote = label(body, 'note', '');

    // -- the frame
    els.frame = make('div', 'frame', body);
    els.frameSurface = new OKDom.Surface(make('div', 'surface', els.frame));
    els.probe = make('div', 'probe', els.frame);
    OKDom.bindDrag(els.frame, function (f) {
      state.probe.x = clamp01(f.x);
      state.probe.y = clamp01(f.y);
      requestRender();
    });

    // -- scheme-wide colour
    els.hueShift = new Slider(body, 'Hue shift', {
      change: function (f) {
        // Modulo, not a clamp: a full turn is no turn, and leaving 360 in the
        // scheme would have it wrap to 0 under the next edit and jump.
        state.scheme.hueShift = Math.round(f * 360) % 360;
        changed();
      },
      paint: function (width, height) {
        // The circle the shift travels along, so the readout has somewhere to
        // point: every light in the scheme moves this far round it.
        return OKRender.hueRamp({
          space: space(), L: 0.62, C: 0.11, width: width, height: height
        });
      }
    });

    els.chroma = new Slider(body, 'Chroma', {
      change: function (f) {
        state.scheme.chroma = Math.round(f * 200) / 100;
        changed();
      },
      paint: function (width, height) {
        // What the multiplier does to the selected light, end to end, rather
        // than an abstract chroma axis it does not travel along.
        var light = selectedLight();
        return OKRender.chromaRamp({
          space: space(), L: 0.62, H: light ? OKScheme.effectiveHue(state.scheme, light) : 250,
          maxC: light ? Math.max(0.02, light.chroma * 2) : 0.2,
          width: width, height: height
        });
      }
    });

    // -- lights
    label(body, 'heading', 'Lights');
    els.lights = make('div', 'lights', body);
    els.add = new Choice(body, '', OKScheme.kindList.map(function (kind) {
      return { id: kind.id, label: '+ ' + kind.label, hint: kind.hint };
    }), function (kindId) {
      var scheme = OKScheme.addLight(state.scheme, kindId);
      state.selected = scheme.lights[scheme.lights.length - 1].id;
      changed(scheme);
      status(OKScheme.getKind(kindId).hint);
    });
    els.add.row.className = 'field add';

    // -- the selected light
    els.editor = make('div', 'editor', body);

    var title = make('div', 'row', els.editor);
    els.lightName = make('input', 'name-input', title);
    els.lightName.setAttribute('type', 'text');
    els.lightName.setAttribute('spellcheck', 'false');
    els.lightName.setAttribute('title', 'What this light\'s layer will be called');
    onText(els.lightName, function () {
      // An empty box is somebody retyping, not a light called nothing: a light
      // always has a name, so leave the old one alone until there is a new one.
      if (els.lightName.value) update({ name: els.lightName.value });
    });
    button(title, 'Down', 'Move down the stack: the first light is the bottom layer', function () {
      reorder(-1);
    });
    button(title, 'Up', 'Move up the stack', function () { reorder(1); });
    button(title, 'Remove', 'Delete this light', function () {
      var scheme = OKScheme.removeLight(state.scheme, state.selected);
      state.selected = scheme.lights.length ? scheme.lights[0].id : '';
      changed(scheme);
    });

    els.kind = new Choice(els.editor, 'Kind', OKScheme.kindList.map(function (kind) {
      return { id: kind.id, label: kind.label, hint: kind.hint };
    }), function (kindId) {
      update({ kind: kindId });
      status(OKScheme.getKind(kindId).hint);
    });

    els.hue = new Slider(els.editor, 'Hue', {
      change: function (f) { update({ hue: f * 360 }); },
      paint: function (width, height) {
        return OKRender.hueRamp({
          space: space(), L: 0.62, C: 0.11, width: width, height: height
        });
      }
    });

    els.lightChroma = new Slider(els.editor, 'Chroma', {
      change: function (f) { update({ chroma: f * OKScheme.CHROMA_MAX }); },
      paint: function (width, height) {
        var light = selectedLight();
        return OKRender.chromaRamp({
          space: space(), L: 0.62, H: light ? light.hue : 250,
          maxC: OKScheme.CHROMA_MAX, width: width, height: height
        });
      }
    });

    els.tone = new Choice(els.editor, 'Tones', OKScheme.toneList.map(function (tone) {
      return { id: tone.id, label: tone.label };
    }), function (toneId) {
      update({ tone: toneId });
    });

    els.reach = new Slider(els.editor, 'Reach', {
      change: function (f) { update({ reach: f }); },
      paint: paintToneProfile
    });

    els.blend = new Choice(els.editor, 'Blend', OKBlend.modeList.map(function (mode) {
      return { id: mode.id, label: mode.label.replace(' light', '') };
    }), function (modeId) {
      update({ blend: modeId });
    });

    els.size = new Slider(els.editor, 'Size', {
      change: function (f) { update({ size: 0.04 + f * 0.96 }); },
      paint: paintFalloff
    });

    els.softness = new Slider(els.editor, 'Falloff', {
      change: function (f) { update({ softness: 0.02 + f * 0.98 }); },
      paint: paintFalloff
    });

    els.angle = new Slider(els.editor, 'Angle', {
      change: function (f) { update({ angle: f * 360 }); },
      paint: function (width, height) {
        return OKRender.hueRamp({
          space: space(), L: 0.5, C: 0, width: width, height: height
        });
      }
    });

    // -- actions
    var foot = make('div', 'paintfoot', root);
    els.status = label(foot, 'status', state.status);
    var actions = make('div', 'row', foot);
    els.build = button(actions, 'Build', 'Make the layers in the document', run);
    els.build.className = 'button primary';
    var files = make('div', 'row', foot);
    button(files, 'Save…', 'Write this scheme to a file', save);
    button(files, 'Load…', 'Read a scheme from a file', load);
    els.reread = button(files, 'From layers',
      'Read the scheme back out of the layers in this document', reread);
  }

  function onText(input, handler) {
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  }

  function button(parent, text, title, onClick) {
    var node = make('button', 'button', parent);
    node.textContent = text;
    node.setAttribute('title', title);
    node.addEventListener('click', onClick);
    return node;
  }

  function update(changes) {
    if (!state.selected) return;
    changed(OKScheme.updateLight(state.scheme, state.selected, changes));
  }

  function reorder(direction) {
    var scheme = OKScheme.clone(state.scheme);
    var from = -1;
    scheme.lights.forEach(function (light, i) { if (light.id === state.selected) from = i; });
    var to = from + direction;
    if (from < 0 || to < 0 || to >= scheme.lights.length) return;
    var moved = scheme.lights.splice(from, 1)[0];
    scheme.lights.splice(to, 0, moved);
    changed(OKScheme.normalise(scheme));
  }

  // ------------------------------------------------------------- painting

  function paintToneProfile(width, height) {
    var light = selectedLight();
    if (!light) return null;
    var colors = [];
    var hue = OKScheme.effectiveHue(state.scheme, light);
    var chroma = OKScheme.effectiveChroma(state.scheme, light);
    for (var i = 0; i < 48; i++) {
      var L = i / 47;
      var weight = OKScheme.toneWeight(light, L);
      // Laid on thicker than the light really is: this track is about the shape
      // of the profile, and the honest amount is too faint to read at 14 pixels.
      colors.push(OKColor.oklchToSrgb255(L, chroma * weight * 1.6, hue));
    }
    return OKRender.colorStrip({ colors: colors, width: width, height: height });
  }

  function paintFalloff(width, height) {
    var light = selectedLight();
    if (!light) return null;
    var curve = OKScheme.falloffCurve(light, 48);
    var colors = curve.map(function (point) {
      var v = Math.round(30 + point.value * 200);
      return [v, v, v];
    });
    return OKRender.colorStrip({ colors: colors, width: width, height: height });
  }

  /** Compile once per change; both previews and the readouts share the result. */
  function ensureCompiled() {
    if (compiled) return compiled;
    var ctx = context();
    var gradients = OKGradient.compile(state.scheme, ctx);
    var weights = OKGradient.weightsAt(state.scheme, state.frame, state.probe.x, state.probe.y);
    compiled = {
      gradients: gradients,
      weights: weights,
      ramp: OKGradient.simulate(state.scheme, ctx, {
        gradients: gradients, weights: weights, samples: RAMP_SAMPLES
      })
    };
    return compiled;
  }

  function paintRamp() {
    var data = ensureCompiled();
    var colors = data.ramp.samples.map(function (sample) { return sample.display; });
    var box = els.ramp.getBoundingClientRect();
    var width = Math.max(60, Math.round(box.width || 240));
    var height = Math.max(10, Math.round(box.height || 26));
    els.rampSurface.paint(OKRender.colorStrip({ colors: colors, width: width, height: height }));
    els.rampMark.style.left = (state.tone * 100) + '%';

    var drift = data.ramp.driftL;
    var lights = OKScheme.activeLights(state.scheme).length;
    els.rampNote.textContent = lights
      ? lights + (lights === 1 ? ' light' : ' lights') + ' · value held to ' +
        (drift * 100).toFixed(1) + '% · frame centred on ' + toneName(state.tone)
      : 'No lights switched on.';
  }

  function toneName(L) {
    if (L < 0.25) return 'the shadows';
    if (L < 0.45) return 'the low midtones';
    if (L < 0.65) return 'the midtones';
    if (L < 0.85) return 'the high midtones';
    return 'the highlights';
  }

  function paintFrame() {
    var data = ensureCompiled();
    var aspect = state.frame.height / state.frame.width;
    // The preview keeps the document's shape.  Its height follows its width, so
    // measuring the width and writing the height cannot feed back on itself.
    var boxWidth = Math.max(60, Math.round(els.frame.getBoundingClientRect().width || 200));
    var boxHeight = Math.round(boxWidth * aspect);
    els.frame.style.height = boxHeight + 'px';

    var width = Math.min(FIELD_WIDTH, boxWidth);
    var height = Math.max(40, Math.round(width * aspect));
    // Every light, switched off ones included: the slice below is indexed the
    // same way and skips them itself.
    var lights = state.scheme.lights;
    var frame = state.frame;
    var sp = space();
    var weights = new Array(lights.length);
    var encoded = [0, 0, 0];

    // One tone per row of the preview, so the stand-in drawing runs from light
    // at the top to dark at the bottom and every light has somewhere to land.
    var slices = [];
    for (var row = 0; row < height; row++) {
      var L = clamp01(state.tone + TONE_SPREAD * (0.5 - (row + 0.5) / height));
      slices.push(OKGradient.toneSlice(data.gradients, OKGradient.grayAt(sp, L)));
    }

    els.frameSurface.paint(OKRender.field({
      width: width, height: height,
      sample: function (fx, fy, out) {
        for (var i = 0; i < lights.length; i++) {
          weights[i] = OKScheme.maskWeight(lights[i], fx, fy, frame);
        }
        var index = Math.min(height - 1, Math.floor(fy * height));
        OKGradient.sliceColor(slices[index], weights, encoded);
        var display = OKColor.linearToSrgb255(sp, OKColor.decodeChannels(sp, encoded));
        out[0] = display[0]; out[1] = display[1]; out[2] = display[2];
      }
    }));

    els.probe.style.left = (state.probe.x * 100) + '%';
    els.probe.style.top = (state.probe.y * 100) + '%';
    syncHandles(boxWidth, boxHeight);
  }

  /**
   * One handle per light that has a place in the frame: a ring the size of a
   * disc light, a dot on the edge for the direction a wash comes from.  They
   * are made once per light and only moved afterwards, so the drag handlers
   * survive a repaint.
   */
  function syncHandles(boxWidth, boxHeight) {
    var lights = state.scheme.lights;
    var seen = {};

    lights.forEach(function (light) {
      if (light.shape === 'none' || !light.enabled) return;
      seen[light.id] = true;
      var handle = handles[light.id];
      if (!handle) {
        handle = { el: make('div', 'handle', els.frame) };
        handle.ring = make('i', '', handle.el);
        bindHandle(handle.el, light.id);
        handles[light.id] = handle;
      }
      place(handle, light, boxWidth, boxHeight);
    });

    Object.keys(handles).forEach(function (id) {
      if (seen[id]) return;
      els.frame.removeChild(handles[id].el);
      delete handles[id];
    });
  }

  function place(handle, light, boxWidth, boxHeight) {
    var el = handle.el;
    el.className = 'handle' + (light.id === state.selected ? ' on' : '');
    if (light.shape === 'radial') {
      el.style.left = (light.x * 100) + '%';
      el.style.top = (light.y * 100) + '%';
      // The radius is a fraction of the document's longer side, and the preview
      // is the document to scale, so it is that fraction of the preview's.
      var diameter = 2 * light.size * Math.max(boxWidth, boxHeight);
      handle.ring.style.width = diameter + 'px';
      handle.ring.style.height = diameter + 'px';
      handle.ring.style.marginLeft = (-diameter / 2) + 'px';
      handle.ring.style.marginTop = (-diameter / 2) + 'px';
    } else {
      // Out towards the side the light comes from.  The direction is in
      // document pixels, which the preview is a straight scaling of.
      var a = light.angle * Math.PI / 180;
      var reach = 0.42 * Math.min(boxWidth, boxHeight);
      el.style.left = (boxWidth / 2 + Math.cos(a) * reach) + 'px';
      el.style.top = (boxHeight / 2 - Math.sin(a) * reach) + 'px';
      handle.ring.style.width = '0px';
      handle.ring.style.height = '0px';
    }
  }

  function bindHandle(el, id) {
    OKDom.bindDrag(el, function (f) {
      var light = OKScheme.findLight(state.scheme, id);
      if (!light) return;
      state.selected = id;
      if (light.shape === 'radial') {
        changed(OKScheme.updateLight(state.scheme, id, {
          x: clamp(f.x, -0.2, 1.2), y: clamp(f.y, -0.2, 1.2)
        }));
      } else {
        var dx = (f.x - 0.5) * state.frame.width;
        var dy = (f.y - 0.5) * state.frame.height;
        var angle = Math.atan2(-dy, dx) * 180 / Math.PI;
        changed(OKScheme.updateLight(state.scheme, id, { angle: angle }));
      }
    }, null, els.frame);
  }

  // ------------------------------------------------------------- the list

  function renderLights() {
    var lights = state.scheme.lights;
    var wanted = {};
    lights.forEach(function (light) { wanted[light.id] = true; });

    Object.keys(lightRows).forEach(function (id) {
      if (wanted[id]) return;
      els.lights.removeChild(lightRows[id].el);
      delete lightRows[id];
    });

    lights.forEach(function (light, index) {
      var row = lightRows[light.id];
      if (!row) {
        // Handlers close over the id, not the light: every edit builds a fresh
        // scheme, so the object this row was made from is stale by the next one.
        var id = light.id;
        row = { el: make('div', 'light', els.lights) };
        row.swatch = make('div', 'lightswatch', row.el);
        row.title = make('div', 'lightname', row.el);
        row.kind = make('div', 'lightkind', row.el);
        row.toggle = make('div', 'lighttoggle', row.el);
        row.el.addEventListener('click', function () {
          state.selected = id;
          requestRender();
        });
        row.toggle.addEventListener('click', function (e) {
          if (e.stopPropagation) e.stopPropagation();
          var current = OKScheme.findLight(state.scheme, id);
          if (!current) return;
          changed(OKScheme.updateLight(state.scheme, id, { enabled: !current.enabled }));
        });
        lightRows[id] = row;
      }
      // Keep the rows in the scheme's order: the first light is the bottom
      // layer, and the list is the layer stack upside down would be a lie.
      if (els.lights.childNodes[index] !== row.el) {
        els.lights.insertBefore(row.el, els.lights.childNodes[index] || null);
      }
      var hue = OKScheme.effectiveHue(state.scheme, light);
      var chroma = OKScheme.effectiveChroma(state.scheme, light);
      row.el.className = 'light' +
        (light.id === state.selected ? ' on' : '') +
        (light.enabled ? '' : ' off');
      row.swatch.style.backgroundColor = OKColor.hexOf(
        OKColor.oklchToSrgb255(0.62, Math.min(chroma * 2.2, 0.2), hue).map(function (v) { return v / 255; }));
      row.title.textContent = light.name;
      row.kind.textContent = OKScheme.getTone(light.tone).label.toLowerCase() +
        ' · ' + OKScheme.getShape(light.shape).label.toLowerCase();
      row.toggle.textContent = light.enabled ? 'on' : 'off';
    });
  }

  function renderEditor() {
    var light = selectedLight();
    els.editor.style.display = light ? '' : 'none';
    if (!light) return;
    if (state.selected !== light.id) state.selected = light.id;
    if (els.lightName.value !== light.name) els.lightName.value = light.name;

    els.kind.update(light.kind);
    els.tone.update(light.tone);
    els.blend.update(light.blend || state.scheme.blend);

    els.hue.update(light.hue / 360, Math.round(light.hue) + '° ' + OKScheme.hueName(light.hue));
    els.lightChroma.update(light.chroma / OKScheme.CHROMA_MAX, light.chroma.toFixed(3));
    els.reach.update(light.reach, Math.round(light.reach * 100) + '%');

    // Only the controls the light's shape actually has: an ambient light is
    // everywhere and has no edge to soften.
    els.size.show(light.shape === 'radial');
    els.size.update((light.size - 0.04) / 0.96, Math.round(light.size * 100) + '%');
    els.angle.show(light.shape === 'linear');
    els.angle.update(light.angle / 360, Math.round(light.angle) + '°');
    els.softness.show(light.shape !== 'none');
    els.softness.update((light.softness - 0.02) / 0.98, Math.round(light.softness * 100) + '%');
  }

  // ------------------------------------------------------------- repaints

  var frameQueued = false;

  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    raf(function () {
      frameQueued = false;
      try {
        render();
      } catch (e) {
        console.error('okpicker: the underpaint panel could not repaint', e);
      }
    });
  }

  function render() {
    if (els.name.value !== state.scheme.name) els.name.value = state.scheme.name;
    if (els.palette.value !== state.scheme.palette) els.palette.value = state.scheme.palette;

    renderLights();
    renderEditor();
    paintRamp();
    paintFrame();

    var height = 14;
    els.hueShift.update(state.scheme.hueShift / 360,
      (state.scheme.hueShift ? '+' + Math.round(state.scheme.hueShift) + '°' : 'none'));
    els.chroma.update(state.scheme.chroma / 2, state.scheme.chroma.toFixed(2) + '×');
    els.hueShift.repaint(height);
    els.chroma.repaint(height);
    if (selectedLight()) {
      els.hue.repaint(height);
      els.lightChroma.repaint(height);
      els.reach.repaint(height);
      els.size.repaint(height);
      els.softness.repaint(height);
      els.angle.repaint(height);
    }

    els.build.disabled = !!state.busy || !canBuild();
  }

  function canBuild() {
    // A scheme whose lights are all switched off still builds: the layers are
    // made and hidden, which is how the document holds on to them.
    return !!(state.document && state.document.hasDocument &&
      state.document.modeId === 'RGBColor' &&
      state.document.depth !== 32 &&
      state.scheme.lights.length);
  }

  /**
   * What the panel has to assume about this document, and cannot check.
   *
   * The blend modes are solved on the values Photoshop blends: the document's
   * own, carrying its own transfer curve.  Both things that break that
   * assumption break it badly rather than slightly - mid grey stops meaning
   * "leave this tone alone" - so they are worth saying out loud.
   */
  function documentWarning(info) {
    if (info.depth === 32) {
      return 'A 32-bit document is blended in linear light, where mid grey is ' +
        'not the neutral these modes are solved for. Convert it to 16-bit.';
    }
    if (!OKColor.matchProfile(info.profile)) {
      return 'The profile "' + (info.profile || 'none') + '" is not one the ' +
        'panel knows, so it is working in sRGB. Lightness will hold less ' +
        'exactly than the readout says.';
    }
    return '';
  }

  // ------------------------------------------------------------- Photoshop

  async function refreshDocument() {
    if (!PS.available()) {
      state.document = { hasDocument: false };
      requestRender();
      return;
    }
    var info = await PS.getDocumentInfo();
    var before = state.key;
    state.document = info;
    if (info.hasDocument) {
      state.frame = { width: info.width, height: info.height };
      var match = info.modeId === 'RGBColor' ? OKColor.matchProfile(info.profile) : null;
      state.spaceId = match ? match.spaceId : 'srgb';
      state.key = info.id + '|' + (info.path || info.name);
      if (info.modeId !== 'RGBColor') {
        status('This is a ' + (info.mode || 'non-RGB') +
          ' document. Convert it to RGB and the panel can colour it.');
      } else {
        var warning = documentWarning(info);
        if (warning) status(warning);
      }
    } else {
      state.key = '';
      status('Open the drawing you want to colour.');
    }
    compiled = null;

    // Only when the document under the panel really changed.  Re-reading on
    // every notification would throw away edits that have not been built yet,
    // and there is nowhere else they are kept.
    if (state.key && state.key !== before) {
      // Layer ids belong to the document that issued them, so the anchor from
      // the last one cannot be trusted to mean anything here.
      state.scheme.groupId = 0;
      var built = readDocument();
      if (built) useScheme(built, 'Read the lighting scheme out of this document\'s layers.');
    }
    requestRender();
  }

  /**
   * The scheme written into this document's own layer names, if there is one.
   *
   * This is the only place a scheme is kept: it is inside the file it belongs
   * to, so it survives the document being moved, copied or handed to somebody
   * else, and there is never a second copy to disagree with it.  Photoshop
   * lists layers top first and the panel lists lights bottom first, hence the
   * reversal.
   */
  function readDocument() {
    if (!PS.available()) return null;
    var node = OKApply.findAny(
      state.scheme.groupId, state.scheme.groupName || state.scheme.name);
    if (!node) return null;
    var layers = node.group ? node.layers.slice().reverse() : [node];
    var scheme = OKScheme.fromLayers(node.name, layers);
    if (!scheme) return null;
    scheme.groupId = node.id;
    scheme.groupName = OKScheme.displayName(node.name);
    return scheme;
  }

  function useScheme(scheme, message) {
    state.scheme = scheme;
    state.selected = scheme.lights.length ? scheme.lights[0].id : '';
    compiled = null;
    status(message);
    requestRender();
  }

  async function run() {
    if (state.busy || !canBuild()) return;
    state.busy = true;
    status('Building…');
    render();
    try {
      var plan = OKGradient.plan(state.scheme, context(), state.frame);
      var result = await OKApply.generate(plan, {
        groupId: state.scheme.groupId,
        groupName: state.scheme.groupName || plan.name
      });
      state.scheme.groupId = result.groupId;
      // What it ended up called, which for a lone layer is the light's name.
      state.scheme.groupName = result.name;
      var count = plan.layers.length;
      status((result.replaced ? 'Rebuilt ' : 'Built ') + count +
        (count === 1 ? ' layer' : ' layers') + ' in "' + plan.name + '"' +
        (result.deselected ? '. The selection was dropped so the masks could be drawn.' : '.'));
    } catch (e) {
      status('Could not build: ' + ((e && e.message) || e));
      console.error('okpicker: building the underpainting failed', e);
    } finally {
      state.busy = false;
      requestRender();
    }
  }

  async function save() {
    try {
      var name = await PS.saveAs(
        (state.scheme.name || 'scheme').replace(/[^A-Za-z0-9._ -]+/g, '') + '.json',
        OKScheme.stringify(state.scheme));
      if (name) status('Saved to ' + name + '.');
    } catch (e) {
      status('Could not save: ' + ((e && e.message) || e));
    }
  }

  function reread() {
    var scheme = readDocument();
    if (scheme) {
      useScheme(scheme, 'Read ' + scheme.lights.length +
        (scheme.lights.length === 1 ? ' light' : ' lights') + ' out of "' +
        (scheme.groupName || scheme.name) + '".');
    } else {
      status(PS.available()
        ? 'Nothing in this document\'s layers to read: build a scheme first, or one of them has been renamed.'
        : 'Photoshop is not here, so there are no layers to read.');
    }
  }

  async function load() {
    try {
      var file = await PS.openFile();
      if (!file) return;
      var scheme = OKScheme.parse(file.text);
      // The layers in *this* document are not the ones the file remembers.
      scheme.groupId = state.scheme.groupId;
      state.selected = scheme.lights.length ? scheme.lights[0].id : '';
      changed(scheme);
      status('Loaded ' + file.name + '.');
    } catch (e) {
      status('Could not load that file: ' + ((e && e.message) || e));
    }
  }

  // ----------------------------------------------------------------- setup

  function init() {
    if (!claimPanel()) return;

    build(root);
    state.selected = state.scheme.lights.length ? state.scheme.lights[0].id : '';

    var resizeTimer = null;
    function onResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        requestRender();
      }, 80);
    }
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(onResize).observe(root); } catch (e) { /* the event below covers it */ }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onResize);
    }

    if (PS.available()) {
      PS.onDocumentChange(function () { refreshDocument(); });
      refreshDocument();
    } else {
      status('Photoshop is not here, so the panel is running on a 4:3 frame.');
      requestRender();
    }

    // Outside Photoshop every panel in the document is on screen at once.
    if (!PS.panelsSupported()) {
      OKDom.devSwitcher([
        { label: 'Picker', el: doc.getElementById('root') },
        { label: 'Underpaint', el: root, onShow: requestRender }
      ]);
    }
  }

  /**
   * Take the panel entry point, before this panel has any contents.
   *
   * The plugin's panels are registered in a single call - see `registerPanels`
   * in ps.js - so a panel that never mounts costs the other one its entry point
   * as well.  Mounting first and building afterwards means a panel Photoshop
   * creates early, or a controller that falls over on the way up, still leaves
   * both entry points registered.  The contents land in the same element either
   * way, whether Photoshop has taken it by then or not.
   */
  var root = null;

  function claimPanel() {
    if (root) return root;
    root = doc.getElementById('paint');
    if (!root) return null;
    OKDom.mountPanel(PS, 'okpicker.underpaint', root, {
      show: function () { refreshDocument(); }
    });
    return root;
  }

  claimPanel();

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
