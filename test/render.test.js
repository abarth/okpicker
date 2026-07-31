'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/color.js');
const R = require('../src/render.js');

const srgb = C.spaces.srgb;

function alphaAt(img, x, y) {
  return img.data[(y * img.width + x) * 4 + 3];
}

function rgbAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

test('encode255 tracks the exact sRGB transfer curve', () => {
  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000;
    const exact = C.TRC.srgb.encode(x) * 255;
    assert.ok(
      Math.abs(R.encode255(x) - exact) < 0.05,
      'encode255(' + x + ') = ' + R.encode255(x) + ', expected ' + exact
    );
  }
  assert.strictEqual(R.encode255(-1), 0);
  assert.strictEqual(R.encode255(2), 255);
});

test('the C/H plot is opaque inside the gamut and clear outside it', () => {
  const L = 0.7;
  const size = 129; // odd, so there is an exact centre pixel
  const maxC = C.spaceMaxChroma(srgb) * 1.06;
  const img = R.chPlot({ space: srgb, L, maxC, size });

  assert.strictEqual(img.width, size);
  assert.strictEqual(img.height, size);

  const mid = (size - 1) / 2;
  assert.strictEqual(alphaAt(img, mid, mid), 255, 'the neutral centre is in gamut');
  assert.strictEqual(alphaAt(img, 0, 0), 0, 'the corner is outside any gamut');

  // The centre of the plot is the achromatic colour at this lightness.
  const expected = C.oklchToSrgb255(L, 0, 0);
  rgbAt(img, mid, mid).forEach((v, i) => {
    assert.ok(Math.abs(v - expected[i]) <= 2, 'centre channel ' + i);
  });
});

test('the plot boundary follows the gamut, not a circle', () => {
  const L = 0.7;
  const size = 201;
  const maxC = C.spaceMaxChroma(srgb) * 1.06;
  const img = R.chPlot({ space: srgb, L, maxC, size });
  const half = size / 2;
  let differing = 0;

  for (let h = 0; h < 360; h += 5) {
    const limit = C.maxChroma(srgb, L, h);
    const rad = h * Math.PI / 180;

    // A sample comfortably inside the hull must be painted...
    const inside = (limit * 0.85) / maxC * half;
    const ix = Math.round(half + inside * Math.cos(rad) - 0.5);
    const iy = Math.round(half - inside * Math.sin(rad) - 0.5);
    assert.strictEqual(alphaAt(img, ix, iy), 255, 'inside the hull at hue ' + h);

    // ...and one comfortably outside must not be.
    const outside = Math.min(limit * 1.2, maxC * 0.98) / maxC * half;
    if (outside > inside + 2) {
      const ox = Math.round(half + outside * Math.cos(rad) - 0.5);
      const oy = Math.round(half - outside * Math.sin(rad) - 0.5);
      assert.strictEqual(alphaAt(img, ox, oy), 0, 'outside the hull at hue ' + h);
      differing++;
    }
  }
  assert.ok(differing > 40, 'expected the hull to be reachable at most hues');

  // If the shape were a disc, every radius would be identical.
  const radii = [0, 90, 180, 270].map((h) => C.maxChroma(srgb, L, h));
  assert.ok(Math.max(...radii) - Math.min(...radii) > 0.05, 'the hull is not circular');
});

test('the plot is anti-aliased along the gamut edge', () => {
  const size = 201;
  const maxC = C.spaceMaxChroma(srgb) * 1.06;
  const img = R.chPlot({ space: srgb, L: 0.6, maxC, size });
  let partial = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3];
    if (a > 0 && a < 255) partial++;
  }
  assert.ok(partial > 100, 'expected a soft edge, found ' + partial + ' partial pixels');
});

test('a precomputed envelope gives the same image as an implicit one', () => {
  const L = 0.55;
  const maxC = 0.34;
  const env = C.chromaEnvelope(srgb, L, 720, 20);
  const a = R.chPlot({ space: srgb, L, maxC, size: 64, envelope: env });
  const b = R.chPlot({ space: srgb, L, maxC, size: 64 });
  assert.deepStrictEqual(Array.from(a.data), Array.from(b.data));
});

test('a wider target space produces a larger painted area', () => {
  const opts = { L: 0.7, maxC: 0.5, size: 128 };
  function painted(space) {
    const img = R.chPlot(Object.assign({ space }, opts));
    let n = 0;
    for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4 + 3] > 128) n++;
    return n;
  }
  const small = painted(srgb);
  const large = painted(C.spaces.rec2020);
  assert.ok(large > small * 1.1, 'Rec.2020 should cover more area than sRGB (' + large + ' vs ' + small + ')');
});

test('ramps mark their out-of-gamut stretch', () => {
  const width = 128;
  const height = 18;

  // Chroma far beyond what this lightness/hue can hold: the top end is invalid.
  const c = R.chromaRamp({ space: srgb, L: 0.9, H: 250, maxC: 0.34, width, height });
  assert.strictEqual(alphaAt(c, 0, 4), 255, 'zero chroma is always in gamut');
  assert.ok(alphaAt(c, width - 1, 4) < 255, 'maximum chroma is out of gamut here');

  // The hatch alternates, so an out-of-gamut column is not uniform.
  const column = [];
  for (let y = 0; y < height; y++) column.push(alphaAt(c, width - 1, y));
  assert.ok(new Set(column).size > 1, 'out-of-gamut area should be hatched');

  const l = R.lightnessRamp({ space: srgb, C: 0.3, H: 250, width, height });
  assert.ok(alphaAt(l, 0, 4) < 255, 'black cannot carry chroma 0.3');
  assert.ok(alphaAt(l, width - 1, 4) < 255, 'white cannot carry chroma 0.3 either');

  const h = R.hueRamp({ space: srgb, L: 0.5, C: 0.02, width, height });
  for (let x = 0; x < width; x++) {
    assert.strictEqual(alphaAt(h, x, 4), 255, 'a tiny chroma fits at every hue');
  }
});

test('the vertical ramp runs dark at the bottom', () => {
  const img = R.lightnessRamp({ space: srgb, C: 0, H: 0, width: 8, height: 64, vertical: true });
  const top = rgbAt(img, 4, 0);
  const bottom = rgbAt(img, 4, 63);
  assert.ok(top[0] > 240, 'top of the strip is light, got ' + top[0]);
  assert.ok(bottom[0] < 15, 'bottom of the strip is dark, got ' + bottom[0]);
});

test('marker geometry round-trips through the plot square', () => {
  const maxC = 0.34;
  [[0, 0], [0.2, 45], [0.34, 180], [0.1, 275]].forEach(([c, h]) => {
    const f = R.markerFraction(c, h, maxC);
    assert.ok(f.x >= -0.001 && f.x <= 1.001, 'x within the square');
    assert.ok(f.y >= -0.001 && f.y <= 1.001, 'y within the square');
    const back = R.fractionToCh(f.x, f.y, maxC);
    assert.ok(Math.abs(back.C - c) < 1e-9, 'chroma round trip');
    if (c > 0) assert.ok(Math.abs(back.H - h) < 1e-9, 'hue round trip');
  });

  // Hue 0 is at 3 o'clock and hue increases counter-clockwise.
  assert.ok(R.markerFraction(0.34, 0, maxC).x > 0.99);
  assert.ok(R.markerFraction(0.34, 90, maxC).y < 0.01);
  assert.ok(R.markerFraction(0.34, 180, maxC).x < 0.01);
  assert.ok(R.markerFraction(0.34, 270, maxC).y > 0.99);
});
