'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/color.js');
const G = require('../src/gradient.js');
const PS = require('../src/ps.js');

const srgb = C.spaces.srgb;
const SPACES = ['srgb', 'p3', 'adobe1998', 'prophoto', 'rec2020'];

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );
}

/** OKLab lightness of a document-encoded grey, the value the ramp must keep. */
function lightnessOfGrey(space, g) {
  return C.linearToOklab(space, ...C.decodeChannels(space, [g, g, g]))[0];
}

// --------------------------------------------------------------- the identity

test('a neutral has OKLab lightness equal to the cube root of its linear value', () => {
  SPACES.forEach((id) => {
    const space = C.getSpace(id);
    for (let i = 1; i <= 20; i++) {
      const y = i / 20;
      const lab = C.linearToOklab(space, y, y, y);
      close(lab[0], Math.cbrt(y), 2e-6, id + ' L at y=' + y);
      close(lab[1], 0, 2e-6, id + ' a at y=' + y);
      close(lab[2], 0, 2e-6, id + ' b at y=' + y);
    }
  });
});

test('lightness and gradient position are inverses of each other', () => {
  SPACES.forEach((id) => {
    const space = C.getSpace(id);
    for (let i = 0; i <= 50; i++) {
      const L = i / 50;
      close(G.lForPosition(space, G.positionForL(space, L)), L, 1e-9, id + ' L=' + L);
    }
  });
  // The number that makes placing control points in L rather than along the
  // gradient worth the trouble.
  close(G.positionForL(srgb, 0.5) * 255, 99.1, 0.1, 'OKLab L=0.5 in sRGB');
});

// ---------------------------------------------------------------- the spline

test('the monotone spline interpolates its data and does not overshoot', () => {
  const xs = [0.2, 0.5, 0.8];
  const ys = [0.3, 0.9, 0.4];
  const f = G.pchip(xs, ys);
  xs.forEach((x, i) => close(f(x), ys[i], 1e-12, 'knot ' + i));
  for (let i = 0; i <= 400; i++) {
    const x = i / 400;
    assert.ok(f(x) >= 0.3 - 1e-12 && f(x) <= 0.9 + 1e-12, 'no overshoot at ' + x);
  }
  // Constant outside the data, which is what carries a design to the ends.
  close(f(0), 0.3, 1e-12, 'below');
  close(f(1), 0.4, 1e-12, 'above');
});

// ------------------------------------------------------------- the guarantees

test('every preset keeps the ramp inside the gamut at every lightness', () => {
  SPACES.forEach((id) => {
    const space = C.getSpace(id);
    G.PRESETS.forEach((preset) => {
      const curve = G.curveFor(G.presetDesign(preset.id));
      for (let i = 0; i <= 200; i++) {
        const L = i / 200;
        const s = G.sampleAt(curve, space, L);
        const lin = C.oklchToLinear(space, s.L, s.C, s.H);
        assert.ok(
          C.inGamutLinear(lin, 1e-4),
          preset.id + ' in ' + id + ' left the gamut at L=' + L + ' (C=' + s.C + ')'
        );
      }
    });
  });
});

test('black stays black and white stays white', () => {
  SPACES.forEach((id) => {
    const space = C.getSpace(id);
    G.PRESETS.forEach((preset) => {
      const { stops } = G.buildStops(G.presetDesign(preset.id), space, { measure: false });
      const first = stops[0];
      const last = stops[stops.length - 1];
      assert.strictEqual(first.location, 0, preset.id + ' starts at 0');
      assert.strictEqual(last.location, G.LOCATION_SCALE, preset.id + ' ends at 4096');
      first.encoded.forEach((v, i) => close(v, 0, 1e-12, preset.id + ' black channel ' + i));
      last.encoded.forEach((v, i) => close(v, 1, 1e-12, preset.id + ' white channel ' + i));
    });
  });
});

test('the neutral design reproduces the grey ramp exactly under classic interpolation', () => {
  // rho = 0 puts every stop on the diagonal - the colour is (g, g, g) at
  // exactly 4096g - so straight interpolation between them is the grey ramp
  // itself, at any stop count.
  SPACES.forEach((id) => {
    const space = C.getSpace(id);
    const { stops } = G.buildStops(G.presetDesign('neutral'), space,
      { methods: ['classic'], stops: 9 });
    const read = G.sampler(stops, space, 'classic');
    for (let g = 0; g <= 255; g++) {
      const enc = read(g / 255);
      enc.forEach((v, i) => close(v, g / 255, 1e-9, id + ' channel ' + i + ' at ' + g));
    }
  });
});

test('every preset reproduces its design whichever way Photoshop interpolates', () => {
  SPACES.forEach((id) => {
    const space = C.getSpace(id);
    G.PRESETS.forEach((preset) => {
      const design = G.presetDesign(preset.id);
      const built = G.buildStops(design, space);
      const where = preset.id + ' in ' + id;
      assert.ok(
        built.stops.length <= G.DEFAULTS.maxStops,
        where + ' needed ' + built.stops.length + ' stops'
      );

      // Lightness is the half that matters: a chroma error is a slightly
      // different colour, a lightness error is the painting's values moving.
      // An 8-bit step is about 0.0035 of OKLab L, so this is under half of one.
      assert.ok(
        built.error.deltaL <= 0.002,
        where + ' moved lightness by ' + built.error.deltaL
      );

      // Colour agreement is looser, and has a floor that stops cannot lower.
      // Below the darkest 8-bit level the linear values are the same order as
      // the epsilon maxChroma tests the gamut with, so the chroma it hands back
      // there is a shade optimistic and the clamp takes some of it away again.
      // It happens at L = 0.01, in a colour that quantises to RGB (1, 0, 0),
      // and no number of stops moves it - so it is bounded, not chased.
      assert.ok(
        built.error.deltaE <= 0.005,
        where + ' is out by dE ' + built.error.deltaE
      );

      // Everywhere a document can actually address, the agreement is a fraction
      // of a just-noticeable difference, which is about 0.02 in OKLab.
      const refs = G.reference(design, space, 513).filter((r) => r.p >= 1 / 255);
      G.METHODS.forEach((method) => {
        const read = G.sampler(built.stops, space, method);
        refs.forEach((r) => {
          const off = G.deltaE(G.labOf(space, read(r.p)), r.lab);
          assert.ok(
            off <= 0.004,
            where + ' is out by dE ' + off + ' at grey ' + Math.round(r.p * 255) +
              ' under ' + method
          );
        });
      });
    });
  });
});

test('the ramp maps each grey onto its own lightness', () => {
  const built = G.buildStops(G.presetDesign('goldenhour'), srgb);
  G.METHODS.forEach((method) => {
    const read = G.sampler(built.stops, srgb, method);
    for (let g = 0; g <= 255; g++) {
      const wanted = lightnessOfGrey(srgb, g / 255);
      const got = G.labOf(srgb, read(g / 255))[0];
      close(got, wanted, 2e-3, method + ' at grey ' + g);
    }
  });
});

// ------------------------------------------------------------------ the model

test('the master amount scales chroma and nothing else', () => {
  const design = G.presetDesign('daylight');
  const full = G.curveFor(design);
  const half = G.curveFor(Object.assign(G.cloneDesign(design), { amount: 0.5 }));
  const none = G.curveFor(Object.assign(G.cloneDesign(design), { amount: 0 }));
  for (let i = 1; i < 40; i++) {
    const L = i / 40;
    close(half(L).rho, full(L).rho * 0.5, 1e-9, 'half at ' + L);
    close(half(L).H, full(L).H, 1e-9, 'hue is untouched at ' + L);
    close(none(L).rho, 0, 1e-12, 'nothing at ' + L);
  }
});

test('the direct path crosses through neutral between opposite hues', () => {
  const opposed = G.normalize({
    points: [{ L: 0.3, rho: 0.6, H: 250 }, { L: 0.7, rho: 0.6, H: 70 }],
    amount: 1, path: 'direct'
  });
  const direct = G.curveFor(opposed);
  const arc = G.curveFor(Object.assign(G.cloneDesign(opposed), { path: 'arc' }));
  // Halfway between two nearly opposite hues the chroma vector cancels, which
  // is what a light-to-shadow ramp wants; the arc path keeps it up instead.
  assert.ok(direct(0.5).rho < 0.15, 'direct dips to ' + direct(0.5).rho);
  close(arc(0.5).rho, 0.6, 1e-6, 'arc holds chroma');
});

test('normalize sorts, clamps and separates control points', () => {
  const d = G.normalize({
    points: [
      { L: 0.9, rho: 3, H: 400 },
      { L: -1, rho: -1, H: -30 },
      { L: 0.9, rho: 0.5, H: 100 }
    ],
    amount: 9, path: 'nonsense'
  });
  assert.strictEqual(d.points.length, 3);
  assert.ok(d.points[0].L < d.points[1].L && d.points[1].L < d.points[2].L, 'sorted');
  assert.ok(d.points.every((p) => p.L >= G.L_MIN && p.L <= G.L_MAX), 'inside the range');
  assert.ok(d.points.every((p) => p.rho >= 0 && p.rho <= 1), 'chroma clamped');
  assert.ok(d.points.every((p) => p.H >= 0 && p.H < 360), 'hue wrapped');
  assert.strictEqual(d.amount, 2);
  assert.strictEqual(d.path, 'direct');
});

test('a design round-trips through the gradient name', () => {
  G.PRESETS.forEach((preset) => {
    const design = G.presetDesign(preset.id);
    const text = G.encodeDesign(design);
    const back = G.decodeDesign(text);
    assert.ok(back, preset.id + ' did not decode');
    assert.strictEqual(G.encodeDesign(back), text, preset.id + ' changed on the way round');
    assert.strictEqual(G.matchPreset(back), preset.id, preset.id + ' lost its identity');
  });
  assert.strictEqual(G.decodeDesign('Foreground to Background'), null);
  assert.strictEqual(G.decodeDesign('okg1:1:direct:junk'), null);
  assert.strictEqual(G.decodeDesign(null), null);
});

// ------------------------------------------------------------- the descriptor

test('the gradient map descriptor is what Photoshop expects', () => {
  const { stops } = G.buildStops(G.presetDesign('tungsten'), srgb, { measure: false });
  const desc = PS.gradientMapDescriptor(stops, G.encodeDesign(G.presetDesign('tungsten')));

  assert.strictEqual(desc._obj, 'gradientMapClass');
  assert.strictEqual(desc.gradient._obj, 'gradientClassEvent');
  assert.strictEqual(desc.gradient.gradientForm._value, 'customStops');
  assert.strictEqual(desc.gradient.interfaceIconFrameDimmed, 0, 'smoothness off');
  assert.strictEqual(desc.gradient.colors.length, stops.length);
  assert.strictEqual(desc.gradient.transparency.length, 2);
  assert.ok(G.decodeDesign(desc.gradient.name), 'the design travels in the name');

  let previous = -1;
  desc.gradient.colors.forEach((stop, i) => {
    assert.strictEqual(stop._obj, 'colorStop');
    assert.strictEqual(stop.color._obj, 'RGBColor');
    assert.ok(stop.location > previous, 'stop ' + i + ' moves forward');
    previous = stop.location;
    assert.ok(stop.location >= 0 && stop.location <= 4096, 'stop ' + i + ' is in range');
    [stop.color.red, stop.color.grain, stop.color.blue].forEach((v) => {
      assert.ok(v >= 0 && v <= 255 && isFinite(v), 'channel in range');
    });
  });
});
