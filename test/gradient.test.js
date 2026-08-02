'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/color.js');
const B = require('../src/blend.js');
const S = require('../src/scheme.js');
const G = require('../src/gradient.js');
const A = require('../src/apply.js');

const srgb = C.spaces.srgb;
const ctx = { space: srgb };
const FRAME = { width: 2400, height: 1600 };

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );
}

function oklchOf(encoded) {
  return C.linearToOklch(srgb, ...C.decodeChannels(srgb, encoded));
}

test('a gradient is a legal ramp: in order, in range, ending at both ends', () => {
  S.palettes.forEach((palette) => {
    const scheme = S.create(palette.id);
    G.compile(scheme, ctx).forEach((gradient) => {
      assert.strictEqual(gradient.stops.length, G.STOPS, palette.id + ' stop count');
      assert.strictEqual(gradient.stops[0].location, 0, palette.id + ' starts at black');
      assert.strictEqual(gradient.stops[G.STOPS - 1].location, 1, palette.id + ' ends at white');
      gradient.stops.forEach((stop, i) => {
        if (i) {
          assert.ok(
            stop.location >= gradient.stops[i - 1].location,
            palette.id + ' locations never go backwards'
          );
        }
        stop.color.forEach((channel) => {
          assert.ok(channel >= 0 && channel <= 1, palette.id + ' stop channel in range');
        });
      });
    });
  });
});

test('stops are spread by lightness, not along the value axis', () => {
  // Which is what keeps the climb out of black from being a single segment.
  const scheme = S.create('goldenHour');
  const [bottom] = G.compile(scheme, ctx);
  const lower = bottom.stops.filter((stop) => stop.location < 0.25).length;
  assert.ok(lower > G.STOPS / 3, 'the dark end gets the stops: ' + lower + ' of ' + G.STOPS);
  assert.ok(bottom.stops[1].location < 0.01, 'the first step is a small one');
});

test('one light over a grey ramp holds every tone exactly', () => {
  B.modeList.forEach((mode) => {
    const scheme = S.normalise({
      blend: mode.id,
      lights: [{ kind: 'ambient', hue: 250, chroma: 0.07, tone: 'all' }]
    });
    const gradients = G.compile(scheme, ctx);
    // Sampled at the tones the stops were solved for, where the answer is not
    // an interpolation between two of them but the thing itself.  Black is
    // checked as a value rather than as a lightness: lightness is vertical at
    // zero, so a difference of one part in a billion reads as a large one.
    G.composite(gradients, 0).forEach((channel) => {
      assert.ok(channel < 1e-6, mode.id + ' leaves black alone');
    });
    for (let i = 1; i < G.STOPS; i++) {
      const L = i / (G.STOPS - 1);
      const gray = G.grayAt(srgb, L);
      const lch = oklchOf(G.composite(gradients, gray));
      close(lch[0], L, 1e-4, mode.id + ' lightness at L ' + L.toFixed(3));
    }
  });
});

test('a whole palette holds the value range to within a level or two', () => {
  S.palettes.forEach((palette) => {
    const scheme = S.create(palette.id);
    const drift = G.simulate(scheme, ctx, { samples: 129 }).driftL;
    assert.ok(drift < 0.02, palette.id + ' drifted ' + (drift * 100).toFixed(2) + '%');
  });
});

test('it stays that way wherever the masks happen to fall', () => {
  // The stack is solved for full coverage; a masked-away light is the case
  // that assumption is least true in, so it is the one worth pinning down.
  S.palettes.forEach((palette) => {
    const scheme = S.create(palette.id);
    const gradients = G.compile(scheme, ctx);
    const lights = S.activeLights(scheme);
    [0, 0.5, 1].forEach((coverage) => {
      const weights = lights.map((light) => (light.shape === 'none' ? 1 : coverage));
      const drift = G.simulate(scheme, ctx, { gradients, weights, samples: 97 }).driftL;
      assert.ok(
        drift < 0.03,
        palette.id + ' at coverage ' + coverage + ' drifted ' + (drift * 100).toFixed(2) + '%'
      );
    });
  });
});

test('lights add up in the direction they were pointed', () => {
  const scheme = S.normalise({
    blend: 'hardLight',
    lights: [
      { kind: 'ambient', hue: 250, chroma: 0.06, tone: 'all' },
      { kind: 'ambient', hue: 250, chroma: 0.06, tone: 'all' }
    ]
  });
  const gradients = G.compile(scheme, ctx);
  const gray = G.grayAt(srgb, 0.5);
  const one = oklchOf(G.composite(gradients.slice(0, 1), gray));
  const both = oklchOf(G.composite(gradients, gray));
  close(one[2], 250, 0.5, 'one light is at its hue');
  close(both[2], 250, 0.5, 'two of the same hue stay there');
  close(both[1], 2 * one[1], 2e-3, 'and twice the chroma');
});

test('opposite lights cancel instead of fighting', () => {
  const scheme = S.normalise({
    lights: [
      { kind: 'ambient', hue: 30, chroma: 0.05, tone: 'all' },
      { kind: 'ambient', hue: 210, chroma: 0.05, tone: 'all' }
    ]
  });
  const gray = G.grayAt(srgb, 0.5);
  const lch = oklchOf(G.composite(G.compile(scheme, ctx), gray));
  close(lch[1], 0, 2e-3, 'chroma back to nothing');
  close(lch[0], 0.5, 1e-4, 'and the tone untouched');
});

test('a light only colours the tones it was given', () => {
  const scheme = S.normalise({
    lights: [{ kind: 'ambient', hue: 250, chroma: 0.1, tone: 'shadow', reach: 0.4 }]
  });
  const gradients = G.compile(scheme, ctx);
  const shadow = oklchOf(G.composite(gradients, G.grayAt(srgb, 0.1)));
  const mid = oklchOf(G.composite(gradients, G.grayAt(srgb, 0.3)));
  const highlight = oklchOf(G.composite(gradients, G.grayAt(srgb, 0.9)));
  // Deep shadow has hardly any gamut to work in, so what matters is that the
  // colour is there and that it fades the way the profile says it should.
  assert.ok(shadow[1] > 0.02, 'shadows are coloured, got ' + shadow[1].toFixed(4));
  assert.ok(mid[1] < shadow[1] * 0.9, 'and less so further up');
  assert.ok(highlight[1] < 0.002, 'highlights are left alone, got ' + highlight[1].toFixed(4));
});

test('the ends of the ramp stay black and white', () => {
  S.palettes.forEach((palette) => {
    const gradients = G.compile(S.create(palette.id), ctx);
    close(oklchOf(G.composite(gradients, 0))[1], 0, 1e-3, palette.id + ' black');
    close(oklchOf(G.composite(gradients, 1))[1], 0, 1e-3, palette.id + ' white');
  });
});

test('a switched-off light is still built, switched off', () => {
  // The document is the only place a scheme is kept, so a light that is not in
  // it is a light that is gone.  It goes in hidden instead.
  let scheme = S.create('neon');
  const plan = G.plan(scheme, ctx, FRAME);
  assert.strictEqual(plan.layers.length, scheme.lights.length);
  assert.strictEqual(plan.name, scheme.name);
  assert.ok(plan.layers.every((layer) => layer.visible));

  scheme = S.updateLight(scheme, scheme.lights[1].id, { enabled: false });
  const off = G.plan(scheme, ctx, FRAME);
  assert.strictEqual(off.layers.length, scheme.lights.length, 'still one layer each');
  assert.deepStrictEqual(off.layers.map((l) => l.visible), [true, false, true]);
  assert.ok(off.layers[1].stops.length, 'and it is a real gradient, ready to switch on');
});

test('a switched-off light changes nothing about the others', () => {
  const scheme = S.create('neon');
  const off = S.updateLight(scheme, scheme.lights[1].id, { enabled: false });
  const gray = G.grayAt(srgb, 0.4);

  // What the stack does with the middle light hidden is what it does without it.
  const without = S.normalise(Object.assign({}, scheme, {
    lights: [scheme.lights[0], scheme.lights[2]]
  }));
  const hidden = G.composite(G.compile(off, ctx), gray);
  const absent = G.composite(G.compile(without, ctx), gray);
  hidden.forEach((channel, i) => close(channel, absent[i], 1e-12, 'channel ' + i));
});

test('a light solved while switched off is solved as though it were on', () => {
  // So that switching it on in Photoshop gives what the panel designed, rather
  // than a layer that was compiled against a stack it is not standing on.
  const scheme = S.create('candle');
  const off = S.updateLight(scheme, scheme.lights[1].id, { enabled: false });
  const one = G.compile(scheme, ctx)[1];
  const other = G.compile(off, ctx)[1];
  assert.deepStrictEqual(other.stops, one.stops);
});

test('a plan carries a blend mode and a mask for each light', () => {
  const scheme = S.create('candle');
  const plan = G.plan(scheme, ctx, FRAME);
  plan.layers.forEach((layer, i) => {
    const light = S.activeLights(scheme)[i];
    assert.strictEqual(layer.name, light.name);
    assert.strictEqual(layer.blend, B.getMode(light.blend || scheme.blend).ps);
    if (light.shape === 'none') assert.strictEqual(layer.mask, null, light.name + ' needs no mask');
    else assert.ok(layer.mask, light.name + ' needs a mask');
  });
});

test('the mask Photoshop draws is the mask the panel previewed', () => {
  const light = S.normaliseLight({ kind: 'lamp', x: 0.3, y: 0.6, size: 0.28, softness: 0.7 });
  const mask = G.maskGeometry(light, FRAME);
  assert.strictEqual(mask.type, 'radial');
  close(mask.from.x, 0.3 * FRAME.width, 1e-9, 'centred on the light');
  close(mask.from.y, 0.6 * FRAME.height, 1e-9);
  const radius = Math.hypot(mask.to.x - mask.from.x, mask.to.y - mask.from.y);
  close(radius, 0.28 * FRAME.width, 1e-9, 'out to its size');

  // Walk the gradient the tool would draw and compare it with the preview.
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const x = mask.from.x + (mask.to.x - mask.from.x) * t;
    const drawn = sampleCurve(mask.stops, t);
    const previewed = S.maskWeight(light, x / FRAME.width, mask.from.y / FRAME.height, FRAME);
    close(drawn, previewed, 0.03, 'coverage at ' + t);
  }
});

test('a wash runs from the side its light is on', () => {
  const light = S.normaliseLight({ kind: 'sun', angle: 0, softness: 1 });
  const mask = G.maskGeometry(light, FRAME);
  assert.strictEqual(mask.type, 'linear');
  close(mask.from.x, FRAME.width, 1e-9, 'starts at the right edge');
  close(mask.to.x, 0, 1e-9, 'and ends at the left');
  close(mask.from.y, FRAME.height / 2, 1e-9);
  assert.strictEqual(mask.stops[0].value, 1);
  assert.strictEqual(mask.stops[mask.stops.length - 1].value, 0);
});

function sampleCurve(stops, t) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const span = stops[i].t - stops[i - 1].t;
      const f = span > 0 ? (t - stops[i - 1].t) / span : 0;
      return stops[i - 1].value + (stops[i].value - stops[i - 1].value) * f;
    }
  }
  return stops[stops.length - 1].value;
}

test('a tone slice at full coverage is the composite it stands in for', () => {
  const scheme = S.create('underwater');
  const gradients = G.compile(scheme, ctx);
  [0.2, 0.5, 0.8].forEach((L) => {
    const gray = G.grayAt(srgb, L);
    const slice = G.toneSlice(gradients, gray);
    const ones = gradients.map(() => 1);
    G.sliceColor(slice, ones).forEach((channel, i) => {
      close(channel, G.composite(gradients, gray)[i], 1e-12, 'channel ' + i + ' at L ' + L);
    });
  });
});

test('the descriptors handed to Photoshop are well formed', () => {
  const plan = G.plan(S.create('neon'), ctx, FRAME);
  plan.layers.forEach((layer) => {
    const gradient = A.gradientDescriptor(layer.name, layer.stops);
    assert.strictEqual(gradient._obj, 'gradientClassEvent');
    assert.strictEqual(gradient.colors.length, layer.stops.length);
    assert.strictEqual(gradient.colors[0].location, 0);
    assert.strictEqual(gradient.colors[gradient.colors.length - 1].location, A.RAMP);
    gradient.colors.forEach((stop, i) => {
      assert.strictEqual(stop._obj, 'colorStop');
      if (i) {
        assert.ok(
          stop.location > gradient.colors[i - 1].location,
          layer.name + ': two stops in the same place'
        );
      }
      [stop.color.red, stop.color.grain, stop.color.blue].forEach((v) => {
        assert.ok(v >= 0 && v <= 255, layer.name + ' channel in range');
      });
    });
    assert.strictEqual(gradient.transparency.length, 2);

    if (!layer.mask) return;
    const mask = A.maskGradientDescriptor(layer.name, layer.mask.stops);
    assert.strictEqual(mask.colors.length, layer.mask.stops.length);
    mask.colors.forEach((stop) => {
      assert.strictEqual(stop.color.red, stop.color.grain, 'masks are neutral');
      assert.strictEqual(stop.color.red, stop.color.blue);
    });
  });
});

test('crowded stops are nudged apart rather than dropped', () => {
  const stops = [
    { location: 0, color: [0, 0, 0] },
    { location: 0.00001, color: [0.5, 0.5, 0.5] },
    { location: 0.00002, color: [1, 1, 1] }
  ];
  const out = A.colorStops(stops);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((s) => s.location), [0, 1, 2]);
});
