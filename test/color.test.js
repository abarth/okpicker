'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/color.js');

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );
}

const ALL = C.spaceList.map((s) => s.id);

test('matrix inverse round-trips', () => {
  const m = [0.4, 0.35, 0.18, 0.21, 0.71, 0.07, 0.02, 0.12, 0.95];
  const identity = C.matMul(m, C.matInv(m));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((expected, i) => {
    close(identity[i], expected, 1e-12, 'identity[' + i + ']');
  });
});

test('every space maps its own white to equal RGB', () => {
  ALL.forEach((id) => {
    const space = C.getSpace(id);
    const lin = C.oklchToLinear(space, 1, 0, 0);
    close(lin[0], 1, 2e-6, id + ' r');
    close(lin[1], 1, 2e-6, id + ' g');
    close(lin[2], 1, 2e-6, id + ' b');
  });
});

test('sRGB primaries have the published OKLCH coordinates', () => {
  const srgb = C.spaces.srgb;
  const red = C.linearToOklch(srgb, 1, 0, 0);
  close(red[0], 0.6280, 1e-3, 'red L');
  close(red[1], 0.2577, 1e-3, 'red C');
  close(red[2], 29.234, 1e-2, 'red H');

  const green = C.linearToOklch(srgb, 0, 1, 0);
  close(green[0], 0.8664, 1e-3, 'green L');
  close(green[1], 0.2948, 1e-3, 'green C');
  close(green[2], 142.495, 1e-2, 'green H');

  const blue = C.linearToOklch(srgb, 0, 0, 1);
  close(blue[0], 0.4520, 1e-3, 'blue L');
  close(blue[1], 0.3132, 1e-3, 'blue C');
  close(blue[2], 264.052, 1e-2, 'blue H');
});

test('OKLCH -> linear -> OKLCH round-trips in every space', () => {
  const samples = [
    [0.15, 0.05, 12], [0.4, 0.12, 95], [0.62, 0.2, 210],
    [0.8, 0.08, 330], [0.95, 0.02, 180]
  ];
  ALL.forEach((id) => {
    const space = C.getSpace(id);
    samples.forEach((s) => {
      const lin = C.oklchToLinear(space, s[0], s[1], s[2]);
      const back = C.linearToOklch(space, lin[0], lin[1], lin[2]);
      close(back[0], s[0], 1e-9, id + ' L');
      close(back[1], s[1], 1e-9, id + ' C');
      close(back[2], s[2], 1e-6, id + ' H');
    });
  });
});

test('transfer functions round-trip', () => {
  ALL.forEach((id) => {
    const trc = C.getSpace(id).trc;
    [0, 0.0005, 0.002, 0.03, 0.25, 0.5, 0.98, 1].forEach((v) => {
      close(trc.decode(trc.encode(v)), v, 1e-9, id + ' trc at ' + v);
    });
    // ...and are sign symmetric, which keeps out-of-gamut maths well behaved.
    close(trc.encode(-0.3), -trc.encode(0.3), 1e-12, id + ' trc symmetry');
  });
});

test('sRGB hex round-trips through OKLCH', () => {
  const srgb = C.spaces.srgb;
  ['#000000', '#FFFFFF', '#3A7BD5', '#FF0000', '#7F7F7F', '#123456'].forEach((hex) => {
    const enc = C.parseHex(hex);
    const lin = C.decodeChannels(srgb, enc);
    const lch = C.linearToOklch(srgb, lin[0], lin[1], lin[2]);
    const info = C.describe(srgb, lch[0], lch[1], lch[2]);
    assert.strictEqual(info.docHex, hex.toUpperCase(), 'round trip of ' + hex);
  });
});

test('parseHex accepts short form and rejects junk', () => {
  assert.deepStrictEqual(C.parseHex('#fff'), [1, 1, 1]);
  assert.deepStrictEqual(C.parseHex('000'), [0, 0, 0]);
  assert.strictEqual(C.parseHex('#12345'), null);
  assert.strictEqual(C.parseHex('nope'), null);
  assert.strictEqual(C.parseHex(null), null);
});

test('maxChroma sits exactly on the gamut boundary', () => {
  ALL.forEach((id) => {
    const space = C.getSpace(id);
    for (let L = 0.1; L < 1; L += 0.1) {
      for (let h = 0; h < 360; h += 37) {
        const c = C.maxChroma(space, L, h);
        assert.ok(
          C.inGamut(space, L, c * 0.999, h),
          id + ': just inside the limit should be in gamut (L=' + L + ' h=' + h + ')'
        );
        assert.ok(
          !C.inGamut(space, L, c * 1.02 + 1e-4, h),
          id + ': past the limit should be out of gamut (L=' + L + ' h=' + h + ')'
        );
      }
    }
  });
});

test('maxChroma degenerates to zero outside the lightness range', () => {
  const srgb = C.spaces.srgb;
  assert.strictEqual(C.maxChroma(srgb, 0, 120), 0);
  assert.strictEqual(C.maxChroma(srgb, 1, 120), 0);
  assert.strictEqual(C.maxChroma(srgb, 1.4, 120), 0);
  assert.strictEqual(C.maxChroma(srgb, -0.2, 120), 0);
});

test('wider spaces contain narrower ones', () => {
  const pairs = [['srgb', 'p3'], ['srgb', 'adobe1998'], ['p3', 'rec2020'], ['rec2020', 'prophoto']];
  pairs.forEach(([narrowId, wideId]) => {
    const narrow = C.getSpace(narrowId);
    const wide = C.getSpace(wideId);
    for (let L = 0.1; L < 1; L += 0.1) {
      for (let h = 0; h < 360; h += 23) {
        const inner = C.maxChroma(narrow, L, h);
        assert.ok(
          C.inGamut(wide, L, inner, h, 1e-4),
          wideId + ' should contain ' + narrowId + ' at L=' + L.toFixed(1) + ' h=' + h
        );
      }
    }
  });
});

test('space maximum chroma is an upper bound on the envelope', () => {
  ALL.forEach((id) => {
    const space = C.getSpace(id);
    const max = C.spaceMaxChroma(space);
    assert.ok(max > 0.2, id + ' should reach a usable chroma, got ' + max);
    for (let L = 0.05; L < 1; L += 0.05) {
      const env = C.chromaEnvelope(space, L, 72, 16);
      for (let i = 0; i < env.length; i++) {
        // The scan samples on a grid, so allow the true peak to poke out a
        // little; the panel adds 6% headroom on top of this.
        assert.ok(env[i] <= max * 1.02 + 1e-3, id + ' envelope exceeds the space maximum at L=' + L);
      }
    }
  });
});

test('chroma envelope interpolation wraps around the hue circle', () => {
  const env = C.chromaEnvelope(C.spaces.srgb, 0.7, 360, 18);
  close(C.envelopeAt(env, 0), env[0], 1e-12, 'hue 0');
  close(C.envelopeAt(env, 360), env[0], 1e-12, 'hue 360');
  close(C.envelopeAt(env, 720), env[0], 1e-9, 'hue 720');
  close(C.envelopeAt(env, 90), env[90], 1e-12, 'hue 90');
  close(C.envelopeAt(env, 90.5), (env[90] + env[91]) / 2, 1e-12, 'hue 90.5');
});

test('Lab (D50) matches known reference values', () => {
  const white = C.oklchToLabD50(1, 0, 0);
  close(white[0], 100, 1e-3, 'white L*');
  close(white[1], 0, 1e-3, 'white a*');
  close(white[2], 0, 1e-3, 'white b*');

  const black = C.oklchToLabD50(0, 0, 0);
  close(black[0], 0, 1e-6, 'black L*');

  // sRGB red, as reported by Photoshop's Lab readout for an sRGB document.
  const srgb = C.spaces.srgb;
  const red = C.linearToOklch(srgb, 1, 0, 0);
  const lab = C.oklchToLabD50(red[0], red[1], red[2]);
  close(lab[0], 54.29, 0.15, 'red L*');
  close(lab[1], 80.8, 0.6, 'red a*');
  close(lab[2], 69.9, 0.6, 'red b*');
});

test('Lab round-trips back to OKLCH', () => {
  [[0.2, 0.05, 20], [0.5, 0.15, 140], [0.75, 0.1, 265], [0.9, 0.02, 300]].forEach((s) => {
    const lab = C.oklchToLabD50(s[0], s[1], s[2]);
    const back = C.labD50ToOklch(lab[0], lab[1], lab[2]);
    close(back[0], s[0], 1e-9, 'L');
    close(back[1], s[1], 1e-9, 'C');
    close(back[2], s[2], 1e-6, 'H');
  });
});

test('profile names map to working spaces', () => {
  const cases = [
    ['sRGB IEC61966-2.1', 'srgb', true],
    ['Adobe RGB (1998)', 'adobe1998', true],
    ['Display P3', 'p3', true],
    ['ProPhoto RGB', 'prophoto', true],
    ['ROMM RGB: ISO 22028-2:2013', 'prophoto', true],
    ['Rec. 2020', 'rec2020', true],
    ['Wide Gamut RGB', 'widegamut', true],
    ['ColorMatch RGB', 'colormatch', true],
    ['Apple RGB', 'apple', true],
    ['eciRGB v2', 'ecirgb', true],
    ['Generic RGB Profile', 'apple', false]
  ];
  cases.forEach(([name, id, exact]) => {
    const match = C.matchProfile(name);
    assert.ok(match, 'no match for ' + name);
    assert.strictEqual(match.spaceId, id, name);
    assert.strictEqual(match.exact, exact, name + ' exactness');
  });
  assert.strictEqual(C.matchProfile('U.S. Web Coated (SWOP) v2'), null);
  assert.strictEqual(C.matchProfile('Dot Gain 20%'), null);
  assert.strictEqual(C.matchProfile(''), null);
});

test('describe reports gamut state and both colour readouts', () => {
  const srgb = C.spaces.srgb;
  const inside = C.describe(srgb, 0.68, 0.14, 250);
  assert.strictEqual(inside.inGamut, true);
  assert.strictEqual(inside.docHex, '#4C9DEB');
  assert.deepStrictEqual(inside.doc255, [76, 157, 235]);
  // For an sRGB document the document and display readouts agree.
  assert.strictEqual(inside.displayHex, inside.docHex);

  const outside = C.describe(srgb, 0.68, 0.34, 250);
  assert.strictEqual(outside.inGamut, false);
  assert.ok(outside.linear.some((v) => v < -1e-6 || v > 1 + 1e-6), 'should leave the unit cube');
  outside.docEncoded.forEach((v) => assert.ok(v >= 0 && v <= 1, 'clipped values stay in range'));
});

test('describe converts wide-gamut colours for an sRGB display', () => {
  const p3 = C.spaces.p3;
  const srgb = C.spaces.srgb;

  // A saturated green that fits Display P3 but not sRGB: the document readout
  // and the on-screen approximation must not be confused for each other.
  const wide = C.linearToOklch(p3, 0.05, 0.95, 0.1);
  const info = C.describe(p3, wide[0], wide[1], wide[2]);
  assert.strictEqual(info.inGamut, true, 'inside Display P3');
  assert.strictEqual(C.inGamut(srgb, wide[0], wide[1], wide[2]), false, 'outside sRGB');
  assert.strictEqual(info.docHex, '#3FF959');
  assert.notDeepStrictEqual(info.displayRgb, info.doc255);

  // A colour both spaces can hold still has different numbers in each.
  const shared = C.linearToOklch(p3, 0.5, 0.6, 0.7);
  const both = C.describe(p3, shared[0], shared[1], shared[2]);
  assert.strictEqual(both.inGamut, true);
  assert.strictEqual(C.inGamut(srgb, shared[0], shared[1], shared[2]), true);
  assert.strictEqual(both.docHex, '#BCCBDA');
  assert.strictEqual(both.displayHex, '#B8CCDB');
});

test('CSS oklch() formatting round-trips', () => {
  const text = C.formatOklch(0.6283, 0.2577, 29.23);
  assert.strictEqual(text, 'oklch(62.83% 0.2577 29.23)');
  const parsed = C.parseOklch(text);
  close(parsed[0], 0.6283, 1e-9, 'L');
  close(parsed[1], 0.2577, 1e-9, 'C');
  close(parsed[2], 29.23, 1e-9, 'H');
  assert.deepStrictEqual(C.parseOklch('oklch(50% 0.1 120deg)').map((v) => +v.toFixed(4)), [0.5, 0.1, 120]);
  assert.strictEqual(C.parseOklch('rgb(1 2 3)'), null);
});

test('the plot bounds contain the gamut and hug it on every side', () => {
  C.spaceList.forEach((sp) => {
    const b = C.spaceBounds(sp);
    const e = C.spaceExtent(sp);
    const w = b.aMax - b.aMin;
    const h = b.bMax - b.bMin;

    assert.ok(b.aMin <= e.aMin && b.aMax >= e.aMax, sp.id + ' contains the hull in a');
    assert.ok(b.bMin <= e.bMin && b.bMax >= e.bMax, sp.id + ' contains the hull in b');

    assert.ok((e.aMin - b.aMin) / w < 0.06, sp.id + ' slack on the left');
    assert.ok((b.aMax - e.aMax) / w < 0.06, sp.id + ' slack on the right');
    assert.ok((e.bMin - b.bMin) / h < 0.06, sp.id + ' slack at the bottom');
    assert.ok((b.bMax - e.bMax) / h < 0.06, sp.id + ' slack at the top');

    // The neutral axis has to be somewhere inside the picture.
    assert.ok(b.aMin < 0 && b.aMax > 0 && b.bMin < 0 && b.bMax > 0, sp.id + ' holds the neutral');
  });
});

test('the plot bounds beat a square drawn to the largest chroma', () => {
  const srgb = C.spaces.srgb;
  const maxC = C.spaceMaxChroma(srgb);
  const e = C.spaceExtent(srgb);
  const b = C.spaceBounds(srgb);

  // The square wasted a fifth of its height: sRGB reaches much further towards
  // blue than towards yellow, so the top of the square was never painted.
  assert.ok((maxC - e.bMax) / (2 * maxC) > 0.15,
    'expected a wide dead band above the hull, got ' + ((maxC - e.bMax) / (2 * maxC)));

  const cropped = (b.aMax - b.aMin) * (b.bMax - b.bMin);
  assert.ok(cropped < 0.8 * 4 * maxC * maxC,
    'cropped window should be much smaller, got ' + (cropped / (4 * maxC * maxC)));
});
