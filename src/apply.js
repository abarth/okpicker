'use strict';
/*
 * Putting a compiled plan into the document.
 *
 * One gradient-map adjustment layer per light, each with the blend mode the
 * light was solved for and, where the light has a place in the frame, a mask
 * drawn with the gradient tool to the same geometry the panel previewed.  They
 * go in a group, in pass-through so they reach the whole picture, and the group
 * is what the panel looks for the next time round: regenerating replaces it in
 * place rather than piling a second one on top.
 *
 * The whole thing is one modal execution with history suspended, so a rebuild
 * is a single undo and a single history state however many layers it made.
 *
 * Descriptors are written the long way round rather than through the DOM
 * because the DOM cannot make a gradient map with custom stops.
 */
(function (root, factory) {
  var ps = root.OKPhotoshop;
  if (!ps && typeof require === 'function' && typeof module === 'object') ps = require('./ps.js');
  var api = factory(ps);
  root.OKApply = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PS) {

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

  /** The falloff curve as a grey ramp for a layer mask. */
  function maskGradientDescriptor(name, curve) {
    return gradientDescriptor(name, curve.map(function (point) {
      return { location: point.t, color: [point.value, point.value, point.value] };
    }));
  }

  function point(x, y) {
    return {
      _obj: 'paint',
      horizontal: { _unit: 'pixelsUnit', _value: x },
      vertical: { _unit: 'pixelsUnit', _value: y }
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

  /** True when something is selected - the gradient tool would be clipped to it. */
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

  async function nameAndBlend(layer) {
    return play({
      _obj: 'set',
      _target: [TARGET_LAYER],
      to: {
        _obj: 'layer',
        name: layer.name,
        mode: { _enum: 'blendMode', _value: layer.blend },
        opacity: { _unit: 'percentUnit', _value: 100 }
      }
    });
  }

  async function drawMask(layer) {
    var mask = layer.mask;
    await play({
      _obj: 'make',
      new: { _class: 'channel' },
      at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
      using: { _enum: 'userMaskEnabled', _value: 'revealAll' }
    });
    await play({
      _obj: 'select',
      _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
      makeVisible: false
    });
    await play({
      _obj: 'gradientClassEvent',
      from: point(mask.from.x, mask.from.y),
      to: point(mask.to.x, mask.to.y),
      type: { _enum: 'gradientType', _value: mask.type },
      // A soft falloff across a few thousand pixels is exactly the case that
      // bands in 8 bits.
      dither: true,
      gradient: maskGradientDescriptor(layer.name + ' falloff', mask.stops),
      mode: { _enum: 'blendMode', _value: 'normal' },
      opacity: { _unit: 'percentUnit', _value: 100 }
    });
    // Leave the layer itself targeted, not its mask: the next thing the painter
    // does should land where they expect it to.
    try {
      await play({
        _obj: 'select',
        _target: [{ _ref: 'channel', _enum: 'channel', _value: 'RGB' }],
        makeVisible: false
      });
    } catch (e) { /* nothing depends on it */ }
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
    await play({
      _obj: 'set',
      _target: [TARGET_LAYER],
      // Pass-through, so the adjustments reach the drawing under the group
      // rather than only each other.
      to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: 'passThrough' } }
    });
    return activeLayerId();
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
    return PS.findLayer(function (node) { return node.name === name; });
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
  async function generate(plan, options) {
    options = options || {};
    if (!PS.available()) throw new Error('Photoshop is not available');
    if (!plan.layers.length) throw new Error('the scheme has no lights switched on');

    var previous = findPrevious(options.groupId, options.groupName || plan.name);
    var previousId = previous ? previous.id : 0;
    var result = { groupId: 0, layerIds: [], replaced: !!previousId, name: plan.name };

    await PS.modal(plan.name, async function () {
      // A live selection would clip every mask gradient to itself.  Dropping it
      // is part of the same history step, so undo puts it back.
      result.deselected = await hasSelection();
      if (result.deselected) await deselect();

      // New layers land above the active one, so starting on the group we are
      // about to replace leaves the new one exactly where the old one stood.
      if (previousId) await selectLayer(previousId);

      for (var i = 0; i < plan.layers.length; i++) {
        var layer = plan.layers[i];
        var id = await makeGradientMapLayer(layer);
        await nameAndBlend(layer);
        if (layer.mask) await drawMask(layer);
        result.layerIds.push(id);
      }

      if (plan.layers.length > 1) {
        result.groupId = await groupLayers(result.layerIds, plan.name);
      } else {
        // One layer is not a folder full of anything.
        result.groupId = result.layerIds[0];
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
    maskGradientDescriptor: maskGradientDescriptor,
    findPrevious: findPrevious,
    generate: generate
  };
});
