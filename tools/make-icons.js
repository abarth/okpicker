#!/usr/bin/env node
'use strict';
/*
 * Regenerates the plugin icons.  Both are drawn by the panels' own code, so an
 * icon cannot drift away from what the thing behind it does.
 *
 * The picker's is a slice of the sRGB gamut at the lightness it opens on.  The
 * underpaint panel's is one of its own lighting schemes - golden hour, the sun
 * coming from the right - laid over a value ramp running dark at the bottom to
 * light at the top: the warm-lit, cool-shadowed picture the panel exists to
 * make.  Run with `npm run icons`.
 */

const fs = require('fs');
const path = require('path');
const OKColor = require('../src/color.js');
const OKRender = require('../src/render.js');
const OKPng = require('../src/png.js');
const OKScheme = require('../src/scheme.js');
const OKGradient = require('../src/gradient.js');

const space = OKColor.spaces.srgb;
const outDir = path.join(__dirname, '..', 'icons');
const SIZES = [['@1x', 23], ['@2x', 46]];

fs.mkdirSync(outDir, { recursive: true });

/**
 * A square window around one lightness slice, sized to the slice rather than to
 * the whole gamut: the panel keeps its scale still while lightness moves, but
 * an icon is one picture and may as well fill itself.
 */
function sliceBounds(envelope) {
  let aMin = 0, aMax = 0, bMin = 0, bMax = 0;
  for (let i = 0; i < envelope.length - 1; i++) {
    const h = (i / (envelope.length - 1)) * 2 * Math.PI;
    const a = envelope[i] * Math.cos(h), b = envelope[i] * Math.sin(h);
    aMin = Math.min(aMin, a); aMax = Math.max(aMax, a);
    bMin = Math.min(bMin, b); bMax = Math.max(bMax, b);
  }
  const side = Math.max(aMax - aMin, bMax - bMin) * 1.04;
  const midA = (aMin + aMax) / 2, midB = (bMin + bMax) / 2;
  return {
    aMin: midA - side / 2, aMax: midA + side / 2,
    bMin: midB - side / 2, bMax: midB + side / 2
  };
}

function pickerIcon(size) {
  const envelope = OKColor.chromaEnvelope(space, 0.74, 1440, 24);
  return OKRender.chPlot({
    space,
    L: 0.74,
    bounds: sliceBounds(envelope),
    width: size,
    height: size,
    envelope,
    outline: [30, 30, 30]
  });
}

function underpaintIcon(size) {
  const scheme = OKScheme.create('goldenHour');
  const ctx = { space };
  const gradients = OKGradient.compile(scheme, ctx);
  const lights = OKScheme.activeLights(scheme);
  const frame = { width: size, height: size };
  const weights = new Array(lights.length);
  const encoded = [0, 0, 0];

  return OKRender.field({
    width: size,
    height: size,
    sample(fx, fy, out) {
      const slice = OKGradient.toneSlice(
        gradients, OKGradient.grayAt(space, 1 - fy));
      for (let i = 0; i < lights.length; i++) {
        weights[i] = OKScheme.maskWeight(lights[i], fx, 0.5, frame);
      }
      OKGradient.sliceColor(slice, weights, encoded);
      const display = OKColor.linearToSrgb255(
        space, OKColor.decodeChannels(space, encoded));
      out[0] = display[0];
      out[1] = display[1];
      out[2] = display[2];
    }
  });
}

[['icon', pickerIcon], ['paint', underpaintIcon]].forEach(([stem, draw]) => {
  SIZES.forEach(([suffix, size]) => {
    const img = draw(size);
    const file = path.join(outDir, stem + suffix + '.png');
    fs.writeFileSync(file, OKPng.encode(img.data, img.width, img.height));
    console.log('wrote', path.relative(process.cwd(), file), `(${size}x${size})`);
  });
});
