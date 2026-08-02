'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/scheme.js');

const FRAME = { width: 2000, height: 1500 };

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );
}

test('every palette makes a scheme that survives normalising', () => {
  S.palettes.forEach((palette) => {
    const scheme = S.create(palette.id);
    assert.strictEqual(scheme.palette, palette.id);
    assert.ok(scheme.lights.length >= 2, palette.id + ' has lights');
    assert.deepStrictEqual(S.normalise(scheme), scheme, palette.id + ' is a fixed point');
    scheme.lights.forEach((light) => {
      assert.ok(light.chroma > 0 && light.chroma <= S.CHROMA_MAX, palette.id + ' chroma');
      assert.ok(S.kinds[light.kind], palette.id + ' kind');
      assert.ok(S.tones[light.tone], palette.id + ' tone');
      assert.ok(S.shapes[light.shape], palette.id + ' shape');
    });
  });
});

test('the light that reaches everywhere is at the bottom of every palette', () => {
  // Each layer is solved against what will be under it, so the one thing that
  // must not be masked away is the thing everything else stands on.
  S.palettes.forEach((palette) => {
    const scheme = S.create(palette.id);
    const global = scheme.lights.map((l) => l.shape === 'none');
    const firstPlaced = global.indexOf(false);
    if (firstPlaced < 0) return;
    assert.ok(
      global.slice(firstPlaced).every((isGlobal) => !isGlobal),
      palette.id + ': a light with no mask sits above one with a mask'
    );
  });
});

test('a scheme round-trips through its saved form', () => {
  const scheme = S.create('candle');
  scheme.groupId = 4242;
  scheme.groupName = 'Candlelight';
  const back = S.parse(S.stringify(scheme));
  assert.deepStrictEqual(back, scheme);
});

test('normalising repairs anything', () => {
  const scheme = S.normalise({
    name: '   ', chroma: 9, hueShift: -30, lights: [
      { kind: 'nonsense', hue: '400', chroma: 'lots', reach: 5, x: -9 },
      null
    ]
  });
  assert.strictEqual(scheme.name, 'Underpainting');
  assert.strictEqual(scheme.chroma, 2);
  assert.strictEqual(scheme.hueShift, 330);
  assert.strictEqual(scheme.lights.length, 2);
  assert.strictEqual(scheme.lights[0].kind, 'ambient');
  assert.strictEqual(scheme.lights[0].hue, 40);
  assert.strictEqual(scheme.lights[0].reach, 1);
  assert.strictEqual(scheme.lights[0].x, -0.5);
  assert.ok(scheme.lights[0].chroma > 0, 'a nonsense chroma falls back to the kind default');
  assert.notStrictEqual(scheme.lights[0].id, scheme.lights[1].id, 'ids are unique');
});

test('lights come and go and change kind', () => {
  let scheme = S.create('studio');
  const before = scheme.lights.length;

  scheme = S.addLight(scheme, 'lamp');
  assert.strictEqual(scheme.lights.length, before + 1);
  const added = scheme.lights[scheme.lights.length - 1];
  assert.strictEqual(added.kind, 'lamp');
  assert.strictEqual(added.shape, 'radial');

  scheme = S.updateLight(scheme, added.id, { kind: 'ambient' });
  const retyped = S.findLight(scheme, added.id);
  assert.strictEqual(retyped.shape, 'none', 'the new kind brings its own shape');
  assert.strictEqual(retyped.tone, 'shadow');
  assert.strictEqual(retyped.hue, added.hue, 'but the colour is the painter\'s, not the kind\'s');

  scheme = S.removeLight(scheme, added.id);
  assert.strictEqual(scheme.lights.length, before);
  assert.strictEqual(S.findLight(scheme, added.id), null);
});

test('a new light is not one of the colours already in the scheme', () => {
  const scheme = S.create('goldenHour');
  const hue = S.suggestHue(scheme);
  scheme.lights.forEach((light) => {
    let gap = Math.abs(((hue - light.hue) % 360 + 360) % 360);
    if (gap > 180) gap = 360 - gap;
    assert.ok(gap > 40, 'suggested ' + hue + ' against ' + light.hue);
  });
});

test('tonal profiles live where they say they do', () => {
  const shadow = S.normaliseLight({ kind: 'ambient', tone: 'shadow', reach: 0.5 });
  assert.ok(S.toneWeight(shadow, 0.05) > 0.9, 'shadows are in the shadows');
  assert.strictEqual(S.toneWeight(shadow, 0.9), 0, 'and not in the highlights');

  const light = S.normaliseLight({ kind: 'sun', tone: 'light', reach: 0.5 });
  assert.ok(S.toneWeight(light, 0.95) > 0.9, 'lights are in the lights');
  assert.strictEqual(S.toneWeight(light, 0.1), 0, 'and not in the shadows');

  const mid = S.normaliseLight({ kind: 'lamp', tone: 'mid', reach: 0.5 });
  assert.ok(S.toneWeight(mid, 0.5) > 0.99, 'midtones peak in the middle');
  assert.ok(S.toneWeight(mid, 0.05) < 0.01 && S.toneWeight(mid, 0.95) < 0.01, 'and fall off both ways');

  const all = S.normaliseLight({ kind: 'lamp', tone: 'all' });
  [0, 0.3, 0.7, 1].forEach((L) => assert.strictEqual(S.toneWeight(all, L), 1, 'all means all'));
});

test('reach widens a profile without moving its home', () => {
  const near = S.normaliseLight({ kind: 'ambient', tone: 'shadow', reach: 0.1 });
  const far = S.normaliseLight({ kind: 'ambient', tone: 'shadow', reach: 0.9 });
  assert.ok(S.toneWeight(far, 0.45) > S.toneWeight(near, 0.45), 'further up the range');
  assert.strictEqual(S.toneWeight(near, 0), 1);
  assert.strictEqual(S.toneWeight(far, 0), 1);
});

test('an ambient light is everywhere and a disc is not', () => {
  const ambient = S.normaliseLight({ kind: 'ambient' });
  [[0, 0], [0.5, 0.5], [1, 1]].forEach(([x, y]) => {
    assert.strictEqual(S.maskWeight(ambient, x, y, FRAME), 1);
  });

  const lamp = S.normaliseLight({ kind: 'lamp', x: 0.5, y: 0.5, size: 0.25, softness: 0.5 });
  assert.strictEqual(S.maskWeight(lamp, 0.5, 0.5, FRAME), 1, 'full at the centre');
  assert.strictEqual(S.maskWeight(lamp, 1, 1, FRAME), 0, 'nothing in the far corner');
  // Softness 0.5 means the first half of the radius is flat, so the falloff
  // has to be sampled past that to be seen at all.
  const edge = S.maskWeight(lamp, 0.68, 0.5, FRAME);
  assert.ok(edge > 0 && edge < 1, 'partway out it is partway on, got ' + edge);
  assert.ok(edge > S.maskWeight(lamp, 0.72, 0.5, FRAME), 'and less further out');
});

test('a disc is round in pixels, not in fractions of the frame', () => {
  const wide = { width: 2000, height: 1000 };
  const lamp = S.normaliseLight({ kind: 'lamp', x: 0.5, y: 0.5, size: 0.2, softness: 1 });
  // 200px away along each axis: same distance, so the same coverage.
  const across = S.maskWeight(lamp, 0.5 + 200 / wide.width, 0.5, wide);
  const down = S.maskWeight(lamp, 0.5, 0.5 + 200 / wide.height, wide);
  close(across, down, 1e-12, 'coverage is isotropic');
});

test('a wash is full on the side its light comes from', () => {
  const east = S.normaliseLight({ kind: 'sun', angle: 0, softness: 1 });
  assert.ok(S.maskWeight(east, 0.98, 0.5, FRAME) > 0.95, 'full at the right');
  assert.ok(S.maskWeight(east, 0.02, 0.5, FRAME) < 0.05, 'gone at the left');
  close(S.maskWeight(east, 0.5, 0.5, FRAME), 0.5, 0.02, 'half way across');

  const north = S.normaliseLight({ kind: 'sun', angle: 90, softness: 1 });
  assert.ok(S.maskWeight(north, 0.5, 0.02, FRAME) > 0.95, 'full at the top');
  assert.ok(S.maskWeight(north, 0.5, 0.98, FRAME) < 0.05, 'gone at the bottom');
});

test('the falloff curve is the mask, sampled', () => {
  const lamp = S.normaliseLight({ kind: 'lamp', x: 0.5, y: 0.5, size: 0.3, softness: 0.6 });
  const curve = S.falloffCurve(lamp, 21);
  assert.strictEqual(curve[0].value, 1);
  assert.strictEqual(curve[curve.length - 1].value, 0);
  curve.forEach((point, i) => {
    if (i) assert.ok(point.value <= curve[i - 1].value + 1e-12, 'never goes back up');
    close(point.value, S.falloff(point.t, lamp.softness), 1e-12, 'point ' + i);
  });
});

test('the scheme-wide knobs move every light together', () => {
  const scheme = S.create('sunset');
  scheme.hueShift = 40;
  scheme.chroma = 0.5;
  scheme.lights.forEach((light) => {
    assert.strictEqual(S.effectiveHue(scheme, light), (light.hue + 40) % 360);
    close(S.effectiveChroma(scheme, light), light.chroma * 0.5, 1e-12);
  });
});

test('a light switched off is not an active light', () => {
  let scheme = S.create('goldenHour');
  assert.strictEqual(S.activeLights(scheme).length, scheme.lights.length);
  scheme = S.updateLight(scheme, scheme.lights[0].id, { enabled: false });
  assert.strictEqual(S.activeLights(scheme).length, scheme.lights.length - 1);
});

test('hue names cover the circle', () => {
  for (let h = 0; h < 360; h += 7) {
    assert.strictEqual(typeof S.hueName(h), 'string');
    assert.ok(S.hueName(h).length > 2, 'a name at ' + h);
  }
  assert.strictEqual(S.hueName(-10), S.hueName(350), 'wraps');
});
