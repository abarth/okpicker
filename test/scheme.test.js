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

test('every value in a scheme sits on a step it can be written down at', () => {
  const scheme = S.normalise({
    chroma: 1.23456, hueShift: 40.7,
    lights: [{ kind: 'lamp', hue: 78.213, chroma: 0.0834567, reach: 0.5551,
      x: 0.38472, y: 0.5211, size: 0.34449, softness: 0.8551, angle: 154.6 }]
  });
  const light = scheme.lights[0];
  assert.strictEqual(scheme.chroma, 1.23);
  assert.strictEqual(scheme.hueShift, 41);
  assert.strictEqual(light.hue, 78);
  assert.strictEqual(light.chroma, 0.083);
  assert.strictEqual(light.reach, 0.56);
  assert.strictEqual(light.x, 0.385);
  assert.strictEqual(light.size, 0.344);
  assert.strictEqual(light.softness, 0.86);
  assert.strictEqual(light.angle, 155);
  assert.deepStrictEqual(S.normalise(scheme), scheme, 'and stays there');
});

test('a light survives the round trip through a layer name', () => {
  S.palettes.forEach((palette) => {
    S.create(palette.id).lights.forEach((light) => {
      const name = S.lightName(light);
      const back = S.lightFromName(name, 0);
      assert.ok(back, palette.id + ': ' + name);
      // Ids are the panel's own business and are minted fresh on the way back.
      const drop = (l) => Object.assign({}, l, { id: null });
      assert.deepStrictEqual(drop(back), drop(light), name);
      assert.strictEqual(S.lightName(back), name, 'and writes itself the same way');
    });
  });
});

test('a whole scheme survives the round trip through its layers', () => {
  S.palettes.forEach((palette) => {
    const scheme = S.create(palette.id);
    scheme.hueShift = 35;
    scheme.chroma = 1.4;
    const normalised = S.normalise(scheme);
    const back = S.fromLayerNames(
      S.schemeName(normalised), normalised.lights.map(S.lightName));

    assert.ok(back, palette.id);
    assert.strictEqual(back.name, normalised.name);
    assert.strictEqual(back.palette, normalised.palette);
    assert.strictEqual(back.blend, normalised.blend);
    assert.strictEqual(back.chroma, normalised.chroma);
    assert.strictEqual(back.hueShift, normalised.hueShift);
    assert.strictEqual(back.lights.length, normalised.lights.length);
    back.lights.forEach((light, i) => {
      const drop = (l) => Object.assign({}, l, { id: null });
      assert.deepStrictEqual(drop(light), drop(normalised.lights[i]), palette.id + ' light ' + i);
    });
  });
});

test('a lone layer carries the scheme as well as the light', () => {
  const scheme = S.normalise({
    name: 'Dusk', palette: 'sunset', blend: 'softLight', chroma: 1.3, hueShift: 20,
    lights: [{ kind: 'sun', name: 'Key', hue: 60, chroma: 0.09, blend: 'overlay' }]
  });
  const name = S.soloName(scheme, scheme.lights[0]);
  const back = S.fromLayerNames(name, [name]);
  assert.strictEqual(back.blend, 'softLight');
  assert.strictEqual(back.chroma, 1.3);
  assert.strictEqual(back.hueShift, 20);
  assert.strictEqual(back.palette, 'sunset');
  assert.strictEqual(back.lights[0].blend, 'overlay', 'the light keeps its own');
  assert.strictEqual(back.lights[0].hue, 60);
});

test('the name a person reads is separable from the part they do not', () => {
  const light = S.create('candle').lights[1];
  const name = S.lightName(light);
  assert.ok(name.startsWith(light.name + ' ['), 'the name comes first: ' + name);
  assert.strictEqual(S.displayName(name), light.name);
  assert.ok(S.hasToken(name));

  // Renaming the layer keeps the light; deleting the token gives it up.
  const renamed = 'The candle ' + name.slice(name.indexOf('['));
  assert.strictEqual(S.lightFromName(renamed, 0).name, 'The candle');
  assert.strictEqual(S.lightFromName('The candle', 0), null);
  assert.strictEqual(S.displayName('An ordinary layer'), 'An ordinary layer');
  assert.strictEqual(S.hasToken('An ordinary layer'), false);
});

test('a name Photoshop will keep whole', () => {
  const light = S.normaliseLight({ kind: 'lamp', name: 'x'.repeat(400) });
  const name = S.lightName(light);
  assert.ok(name.length <= S.MAX_NAME, 'trimmed to ' + name.length);
  assert.ok(S.hasToken(name), 'and it is the display half that gave way');
  assert.strictEqual(S.lightFromName(name, 0).kind, 'lamp');
});

test('a token from a later version degrades instead of failing', () => {
  const light = S.lightFromName('Sun [oklch1 k=sun h=200 zz=novel q=3 t=bogus]', 0);
  assert.strictEqual(light.kind, 'sun');
  assert.strictEqual(light.hue, 200);
  assert.strictEqual(light.tone, 'light', 'an unreadable value falls back to the kind default');
  assert.strictEqual(light.name, 'Sun');
});

test('lights are read in the order they are handed over', () => {
  const scheme = S.create('neon');
  const names = scheme.lights.map(S.lightName);
  const back = S.fromLayerNames(S.schemeName(scheme), names);
  assert.deepStrictEqual(back.lights.map((l) => l.name), scheme.lights.map((l) => l.name));
  assert.notStrictEqual(back.lights[0].id, back.lights[1].id, 'with ids of their own');
});

test('nothing readable means there was no scheme there', () => {
  assert.strictEqual(S.fromLayerNames('Some group', ['Layer 1', 'Layer 2']), null);
  assert.strictEqual(S.fromLayerNames('', []), null);
});

test('hue names cover the circle', () => {
  for (let h = 0; h < 360; h += 7) {
    assert.strictEqual(typeof S.hueName(h), 'string');
    assert.ok(S.hueName(h).length > 2, 'a name at ' + h);
  }
  assert.strictEqual(S.hueName(-10), S.hueName(350), 'wraps');
});
