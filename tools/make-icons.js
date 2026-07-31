#!/usr/bin/env node
'use strict';
/*
 * Regenerates the plugin icons.  They are literally the panel's own C/H gamut
 * slice, rendered by the same code path, so the icon always matches what the
 * plugin draws.  Run with `npm run icons`.
 */

const fs = require('fs');
const path = require('path');
const OKColor = require('../src/color.js');
const OKRender = require('../src/render.js');
const OKPng = require('../src/png.js');

const space = OKColor.spaces.srgb;
const maxC = OKColor.spaceMaxChroma(space) * 1.02;
const outDir = path.join(__dirname, '..', 'icons');

fs.mkdirSync(outDir, { recursive: true });

[['icon@1x.png', 23], ['icon@2x.png', 46]].forEach(([name, size]) => {
  const img = OKRender.chPlot({
    space,
    L: 0.74,
    maxC,
    size,
    envelope: OKColor.chromaEnvelope(space, 0.74, 1440, 24),
    outline: [30, 30, 30]
  });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, OKPng.encode(img.data, img.width, img.height));
  console.log('wrote', path.relative(process.cwd(), file), `(${size}x${size})`);
});
