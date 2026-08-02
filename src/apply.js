'use strict';
/*
 * Putting a compiled plan into the document.
 *
 * One gradient-map adjustment layer per light, each with the blend mode the
 * light was solved for and, where the light has a place in the frame, a mask
 * whose pixels are the falloff the panel previewed.  They go in a group, in
 * pass-through so they reach the whole picture, and the group is what the panel
 * looks for the next time round: regenerating replaces it in place rather than
 * piling a second one on top.
 *
 * Everything after a layer is made addresses it by id, and everything made is
 * checked afterwards.  Both because the failures that matter here are silent
 * ones: a command that lands on the wrong layer, or a blend mode that does not
 * take, leaves a ramp built for hard light sitting in normal mode - and that
 * replaces every tone in the drawing with mid grey.
 *
 * The whole thing is one modal execution with history suspended, so a rebuild
 * is a single undo and a single history state however many layers it made.
 *
 * Descriptors are written the long way round rather than through the DOM
 * because the DOM cannot make a gradient map with custom stops.
 */
(function (root, factory) {
  var ps = root.OKPhotoshop;
  var scheme = root.OKScheme;
  if (typeof require === 'function' && typeof module === 'object') {
    if (!ps) ps = require('./ps.js');
    if (!scheme) scheme = require('./scheme.js');
  }
  var api = factory(ps, scheme);
  root.OKApply = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PS, OKScheme) {

  var RAMP = 4096;   // Photoshop's gradient location scale

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function round2(x) { return Math.round(x * 100) / 100; }

  // ---------------------------------------------------------- descriptors

  function rgbDescriptor(color) {
    return {
      _obj: 'RGBColor',
      red: round2(clamp01(color[0]) * 255),
      // Photoshop's RGBColor descriptor really does call the green channel
      // "grain" - a decades-old key name, not a typo.
      grain: round2(clamp01(color[1]) * 255),
      blue: round2(clamp01(color[2]) * 255)
    };
  }

  /**
   * Stops at whole ramp positions, strictly increasing.
   *
   * The ramp has 4096 places and the panel puts its stops where lightness is
   * evenly spaced, which crowds them together at the black end - close enough
   * that two can round to the same place.  Nudging the second one along keeps
   * the ramp legal without moving anything that matters.
   */
  function colorStops(stops) {
    var out = [];
    var last = -1;
    for (var i = 0; i < stops.length; i++) {
      var location = Math.round(clamp01(stops[i].location) * RAMP);
      if (location <= last) location = last + 1;
      if (location > RAMP) break;
      last = location;
      out.push({
        _obj: 'colorStop',
        color: rgbDescriptor(stops[i].color),
        type: { _enum: 'colorStopType', _value: 'userStop' },
        location: location,
        midpoint: 50
      });
    }
    return out;
  }

  function transparencyStops() {
    return [0, RAMP].map(function (location) {
      return {
        _obj: 'transferSpec',
        location: location,
        midpoint: 50,
        opacity: { _unit: 'percentUnit', _value: 100 }
      };
    });
  }

  function gradientDescriptor(name, stops) {
    return {
      _obj: 'gradientClassEvent',
      name: name,
      gradientForm: { _enum: 'gradientForm', _value: 'customStops' },
      interfaceIconFrameDimmed: RAMP,
      colors: colorStops(stops),
      transparency: transparencyStops()
    };
  }

  var TARGET_LAYER = { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' };

  // -------------------------------------------------------------- commands

  async function play(commands) {
    return PS.batchPlay(Array.isArray(commands) ? commands : [commands], {});
  }

  /** Play `command`, and if the host refuses it, play it again without `key`. */
  async function playTolerating(command, key, path) {
    try {
      return await play(command);
    } catch (e) {
      var fallback = JSON.parse(JSON.stringify(command));
      var node = fallback;
      for (var i = 0; i < path.length && node; i++) node = node[path[i]];
      if (!node || node[key] === undefined) throw e;
      delete node[key];
      return play(fallback);
    }
  }

  async function activeLayerId() {
    var result = await play({
      _obj: 'get',
      _target: [{ _ref: 'property', _property: 'layerID' }, TARGET_LAYER]
    });
    return (result && result[0] && result[0].layerID) || 0;
  }

  async function selectLayer(id, add) {
    var command = {
      _obj: 'select',
      _target: [{ _ref: 'layer', _id: id }],
      makeVisible: false
    };
    if (add) {
      command.selectionModifier = {
        _enum: 'selectionModifierType', _value: 'addToSelection'
      };
    }
    return play(command);
  }

  /** True when something is selected - a new mask would be made from it. */
  async function hasSelection() {
    try {
      var result = await play({
        _obj: 'get',
        _target: [
          { _ref: 'property', _property: 'selection' },
          { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }
        ]
      });
      return !!(result && result[0] && result[0].selection);
    } catch (e) {
      return false;
    }
  }

  async function deselect() {
    return play({
      _obj: 'set',
      _target: [{ _ref: 'channel', _property: 'selection' }],
      to: { _enum: 'ordinal', _value: 'none' }
    });
  }

  // ----------------------------------------------------------- one light

  async function makeGradientMapLayer(layer) {
    var command = {
      _obj: 'make',
      _target: [{ _ref: 'adjustmentLayer' }],
      using: {
        _obj: 'adjustmentLayer',
        type: {
          _obj: 'gradientMapClass',
          // The stops are solved densely and in the document's own values, so
          // straight interpolation between them is the one that matches what
          // the panel drew.  Older hosts have no say in it at all, hence the
          // tolerated retry.
          gradientsInterpolationMethod: {
            _enum: 'gradientInterpolationMethodType', _value: 'classic'
          },
          gradient: gradientDescriptor(layer.name, layer.stops)
        }
      }
    };
    await playTolerating(
      command, 'gradientsInterpolationMethod', ['using', 'type']);
    return activeLayerId();
  }

  /**
   * Name, blend mode and opacity, one property per command.
   *
   * One `set` carrying all three is not obviously wrong, and that is the
   * trouble with it: if the host takes only the first, the layer ends up named
   * correctly and in the wrong blend mode - and a ramp solved for hard light,
   * laid down in normal, replaces every tone in the drawing with mid grey.
   * Separate commands fail loudly instead, and `verify` below checks anyway.
   */
  async function nameAndBlend(id, layer) {
    var target = [{ _ref: 'layer', _id: id }];
    return play([
      {
        _obj: 'set', _target: target,
        to: { _obj: 'layer', name: layer.title || layer.name }
      },
      {
        _obj: 'set', _target: target,
        to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: layer.blend } }
      },
      {
        _obj: 'set', _target: target,
        to: { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: 100 } }
      }
    ]);
  }

  /**
   * A light switched off is built and hidden rather than left out: a hidden
   * adjustment layer does nothing at all, so it is off in every sense the
   * document has, and it is still there to be read back and switched on again.
   */
  async function hideLayer(id) {
    var target = [{ _ref: 'layer', _id: id }];
    try {
      await play({ _obj: 'hide', 'null': target });
    } catch (e) {
      await play({
        _obj: 'set', _target: target,
        to: { _obj: 'layer', visible: false }
      });
    }
  }

  /**
   * Give the layer a mask and write the light's own falloff into it.
   *
   * The pixels go in through the imaging API rather than being drawn with the
   * gradient tool.  Since Photoshop 2023 that tool makes a gradient *fill
   * layer* instead of painting, which fills no masks and leaves an opaque
   * gradient lying across the artwork; and pixels mean the mask is the very
   * function the panel previewed rather than an approximation of it in
   * gradient stops.
   */
  async function paintMask(id, light, frame) {
    var imaging = PS.imaging();
    if (!imaging || !imaging.putLayerMask || !imaging.createImageDataFromBuffer) {
      throw new Error('this version of Photoshop cannot be handed mask pixels');
    }
    await play({
      _obj: 'make',
      new: { _class: 'channel' },
      at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
      using: { _enum: 'userMaskEnabled', _value: 'revealAll' }
    });

    var width = Math.max(1, Math.round(frame.width));
    var height = Math.max(1, Math.round(frame.height));
    var imageData = await imaging.createImageDataFromBuffer(
      OKScheme.maskPixels(light, { width: width, height: height }),
      {
        width: width, height: height,
        components: 1, chunky: false,
        colorProfile: 'Gray Gamma 2.2', colorSpace: 'Grayscale'
      });
    var options = { layerID: id, imageData: imageData };
    var open = PS.activeDocument();
    if (open && open.id) options.documentID = open.id;
    try {
      await imaging.putLayerMask(options);
    } finally {
      try { imageData.dispose(); } catch (e) { /* already gone */ }
    }
  }

  /**
   * Check that Photoshop made what it was asked for.
   *
   * Both of these have been wrong in the field and neither announces itself:
   * an adjustment layer of the wrong class, and a blend mode that did not take.
   * The second is the dangerous one - the ramps are mid grey wherever a light
   * does nothing, because mid grey is what "leave this tone alone" looks like
   * to the contrast modes, so the same ramp in normal mode flattens the whole
   * drawing to grey.  Better to stop and say so than to leave that behind.
   */
  async function verify(id, layer) {
    var made;
    try {
      var result = await play({ _obj: 'get', _target: [{ _ref: 'layer', _id: id }] });
      made = result && result[0];
    } catch (e) {
      return null; // cannot look; the build is no worse for trying
    }
    if (!made) return null;

    var adjustment = made.adjustment && made.adjustment[0];
    var kind = adjustment && adjustment._obj;
    if (kind && kind !== 'gradientMapClass') {
      throw new Error('Photoshop made a ' + kind + ' where a gradient map was asked for');
    }
    var mode = made.mode && made.mode._value;
    if (mode && mode !== layer.blend) {
      throw new Error('"' + layer.name + '" came out in ' + mode +
        ' rather than ' + layer.blend + ', which would flatten the drawing');
    }
    return { kind: kind, mode: mode };
  }

  // -------------------------------------------------------------- grouping

  async function groupLayers(ids, name) {
    for (var i = 0; i < ids.length; i++) {
      await selectLayer(ids[i], i > 0);
    }
    await play({
      _obj: 'make',
      _target: [{ _ref: 'layerSection' }],
      from: TARGET_LAYER,
      using: { _obj: 'layerSection', name: name }
    });
    var id = await activeLayerId();
    await play({
      _obj: 'set',
      _target: [{ _ref: 'layer', _id: id }],
      // Pass-through, so the adjustments reach the drawing under the group
      // rather than only each other.  A group left in normal mode would isolate
      // them and the pass would do nothing at all.
      to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: 'passThrough' } }
    });
    return id;
  }

  /**
   * What a previous run left behind - a group, or a lone layer when the scheme
   * had one light in it.  By id first, because Photoshop keeps layer ids in the
   * file and they survive being saved and re-opened; by name for a document
   * that has been through something that did not keep them.
   */
  function findPrevious(groupId, name) {
    if (groupId) {
      var byId = PS.findLayer(function (node) { return node.id === groupId; });
      if (byId) return byId;
    }
    if (!name) return null;
    // By what the layer is called, not by its whole name: the scheme written
    // after it changes with every edit, and a group is still the same group.
    return PS.findLayer(function (node) {
      return OKScheme.displayName(node.name) === name;
    });
  }

  /**
   * Any group or layer in the document that the panel wrote, whether or not
   * this session is the one that wrote it.  How a document that arrives from
   * somewhere else gives its lighting scheme up.
   */
  function findAny(groupId, name) {
    return findPrevious(groupId, name) ||
      PS.findLayer(function (node) { return OKScheme.hasToken(node.name); });
  }

  // ------------------------------------------------------------- generate

  /**
   * Build the plan's layers in the frontmost document.
   *
   * @param {object} plan     from OKGradient.plan
   * @param {object} options  {groupId, groupName} of a group to replace
   * @returns {Promise<{groupId:number, layerIds:number[], replaced:boolean,
   *                    name:string, deselected:boolean}>}
   */
  /** Undo a half-built stack, layer by layer, without giving up on the first failure. */
  async function discard(ids) {
    for (var i = ids.length - 1; i >= 0; i--) {
      try {
        await play({ _obj: 'delete', _target: [{ _ref: 'layer', _id: ids[i] }] });
      } catch (e) { /* it may already be gone; keep going */ }
    }
    ids.length = 0;
  }

  async function generate(plan, options) {
    options = options || {};
    if (!PS.available()) throw new Error('Photoshop is not available');
    if (!plan.layers.length) throw new Error('the scheme has no lights in it');

    var previous = findPrevious(options.groupId, options.groupName || plan.name);
    var previousId = previous ? previous.id : 0;
    var result = { groupId: 0, layerIds: [], replaced: !!previousId, name: plan.name };

    await PS.modal(plan.name, async function () {
      // A new mask is made from whatever is selected, so a live selection would
      // cut every one of them to its own shape.  Dropping it is part of the same
      // history step, so undo puts it back.
      result.deselected = await hasSelection();
      if (result.deselected) await deselect();

      // New layers land above the active one, so starting on the group we are
      // about to replace leaves the new one exactly where the old one stood.
      if (previousId) await selectLayer(previousId);

      try {
        for (var i = 0; i < plan.layers.length; i++) {
          var layer = plan.layers[i];
          var id = await makeGradientMapLayer(layer);
          // Written down before it is finished, so that a failure part way
          // through setting it up can still take it back.
          result.layerIds.push(id);
          // Everything after the make addresses the layer by its id rather than
          // by whatever happens to be selected, so nothing that changes the
          // selection behind our back can send a command to the wrong layer.
          await nameAndBlend(id, layer);
          if (layer.mask) await paintMask(id, layer.mask, plan.frame);
          await verify(id, layer);
          if (layer.visible === false) await hideLayer(id);
        }
      } catch (e) {
        // A build that stopped half way is worse than one that did not start:
        // take back what was made and leave the document as it was found.
        await discard(result.layerIds);
        throw e;
      }

      if (plan.layers.length > 1) {
        result.groupId = await groupLayers(result.layerIds, plan.title || plan.name);
      } else {
        // One layer is not a folder full of anything.
        result.groupId = result.layerIds[0];
        result.name = plan.layers[0].name;
        await selectLayer(result.groupId);
      }

      if (previousId) await play({ _obj: 'delete', _target: [{ _ref: 'layer', _id: previousId }] });
    });

    return result;
  }

  return {
    RAMP: RAMP,
    rgbDescriptor: rgbDescriptor,
    colorStops: colorStops,
    gradientDescriptor: gradientDescriptor,
    findPrevious: findPrevious,
    findAny: findAny,
    generate: generate
  };
});
