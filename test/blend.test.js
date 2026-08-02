'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/color.js');
const B = require('../src/blend.js');

const srgb = C.spaces.srgb;

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual
  );
}

test('every mode inverts exactly wherever it can reach', () => {
  B.modeList.forEach((mode) => {
    for (let gi = 0; gi <= 40; gi++) {
      for (let ri = 0; ri <= 40; ri++) {
        const base = gi / 40;
        const want = ri / 40;
        const stop = mode.invert(base, want);
        if (stop === null) continue;
        assert.ok(stop >= 0 && stop <= 1, mode.id + ' stop in range');
        close(mode.apply(base, stop), want, 1e-9, mode.id + ' apply(invert)');
      }
    }
  });
});

test('every mode leaves the tone alone at its neutral', () => {
  B.modeList.forEach((mode) => {
    for (let i = 0; i <= 20; i++) {
      const base = i / 20;
      close(mode.apply(base, mode.neutral(base)), base, 1e-12, mode.id + ' neutral');
    }
  });
});

test('the contrast modes are all neutral at mid grey, normal is not', () => {
  ['softLight', 'overlay', 'hardLight', 'linearLight'].forEach((id) => {
    assert.strictEqual(B.modes[id].neutral(0.3), 0.5, id);
  });
  assert.strictEqual(B.modes.normal.neutral(0.3), 0.3);
});

test('soft light cannot reach as far as hard light', () => {
  // Soft light only spans g^2 .. sqrt(g); hard light spans the lot.
  const base = 0.5;
  assert.strictEqual(B.modes.softLight.invert(base, 0.05), null, 'soft light cannot get that dark');
  assert.ok(B.modes.hardLight.invert(base, 0.05) !== null, 'hard light can');
  assert.ok(B.modes.linearLight.invert(base, 0.05) !== null, 'linear light can');
});

test('grey lightness and its inverse round-trip in every space', () => {
  C.spaceList.forEach((space) => {
    for (let i = 0; i <= 20; i++) {
      const gray = i / 20;
      const L = B.grayLightness(space, gray);
      close(B.grayForLightness(space, L), gray, 1e-6, space.id + ' grey ' + gray);
    }
  });
});

test('a neutral has no chroma in any space', () => {
  C.spaceList.forEach((space) => {
    [0.1, 0.4, 0.9].forEach((gray) => {
      const lab = B.encodedToOklab(space, [gray, gray, gray]);
      close(lab[1], 0, 1e-7, space.id + ' a');
      close(lab[2], 0, 1e-7, space.id + ' b');
    });
  });
});

test('a solved stop holds lightness and delivers the chroma it reports', () => {
  const hue = 250;
  B.modeList.forEach((mode) => {
    for (let i = 2; i < 20; i++) {
      const gray = i / 20;
      const L = B.grayLightness(srgb, gray);
      const base = [gray, gray, gray];
      const rad = hue * Math.PI / 180;
      const solved = B.solveStop({
        space: srgb, mode, base, lightness: L,
        da: 0.08 * Math.cos(rad), db: 0.08 * Math.sin(rad)
      });

      const result = solved.color.map((stop, ch) => mode.apply(base[ch], stop));
      const lch = C.linearToOklch(srgb, ...C.decodeChannels(srgb, result));
      close(lch[0], L, 2e-6, mode.id + ' lightness at grey ' + gray);
      // Loosest of the tolerances here: a stop that had to give chroma back
      // lands on a bisected ceiling, and the encode/decode round trip through
      // the transfer curve costs a few more digits.
      close(lch[1], solved.chroma, 2e-5, mode.id + ' chroma at grey ' + gray);
      assert.ok(solved.added <= 0.08 + 1e-9, mode.id + ' never adds more than asked');
    }
  });
});

test('a stop asked for no chroma is the mode doing nothing', () => {
  B.modeList.forEach((mode) => {
    const gray = 0.42;
    const solved = B.solveStop({
      space: srgb, mode, base: [gray, gray, gray],
      lightness: B.grayLightness(srgb, gray), da: 0, db: 0
    });
    solved.color.forEach((stop, i) => {
      close(stop, mode.neutral(gray), 1e-6, mode.id + ' channel ' + i);
    });
    close(solved.chroma, 0, 1e-6, mode.id + ' chroma');
  });
});

test('chroma is given back rather than clipped when a mode runs out of room', () => {
  // Deep shadow under soft light: the mode can barely move at all.
  const gray = 0.06;
  const L = B.grayLightness(srgb, gray);
  const soft = B.solveStop({
    space: srgb, mode: B.modes.softLight, base: [gray, gray, gray],
    lightness: L, da: 0.2, db: 0.05
  });
  const hard = B.solveStop({
    space: srgb, mode: B.modes.hardLight, base: [gray, gray, gray],
    lightness: L, da: 0.2, db: 0.05
  });
  assert.ok(soft.added < 0.2, 'soft light had to give some back');
  assert.ok(hard.added > soft.added, 'hard light reaches further');

  // Whatever survived is still exactly on lightness.
  [[B.modes.softLight, soft], [B.modes.hardLight, hard]].forEach(([mode, solved]) => {
    const result = solved.color.map((stop, ch) => mode.apply(gray, stop));
    close(C.linearToOklch(srgb, ...C.decodeChannels(srgb, result))[0], L, 1e-5, mode.id);
  });
});

test('a solve over a coloured base corrects it back onto lightness', () => {
  // What the second layer of a stack is really doing.
  const gray = 0.5;
  const L = B.grayLightness(srgb, gray);
  const base = C.encodeChannels(srgb, C.oklchToLinear(srgb, L + 0.04, 0.05, 30));
  const solved = B.solveStop({
    space: srgb, mode: B.modes.hardLight, base, lightness: L, da: 0, db: 0
  });
  const result = solved.color.map((stop, ch) => B.modes.hardLight.apply(base[ch], stop));
  close(C.linearToOklch(srgb, ...C.decodeChannels(srgb, result))[0], L, 1e-5, 'pulled back to L');
});

test('a layer at no coverage changes nothing', () => {
  const base = [0.3, 0.4, 0.5];
  const out = B.over(B.modes.hardLight, base, [0.9, 0.1, 0.2], 0);
  base.forEach((v, i) => close(out[i], v, 1e-12, 'channel ' + i));
});

test('luminosity is the classic weighting', () => {
  close(B.luminosity([1, 1, 1]), 1, 1e-12);
  close(B.luminosity([0.5, 0.5, 0.5]), 0.5, 1e-12);
  close(B.luminosity([1, 0, 0]), 0.3, 1e-12);
});
