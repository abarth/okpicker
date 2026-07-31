'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const Png = require('../src/png.js');

function readChunks(png) {
  const chunks = [];
  let p = 8;
  while (p < png.length) {
    const length = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + length);
    const crc = png.readUInt32BE(p + 8 + length);
    chunks.push({ type, data, crc, crcInput: png.subarray(p + 4, p + 8 + length) });
    p += 12 + length;
  }
  return chunks;
}

function makePixels(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 37) & 255;
    rgba[i * 4 + 1] = (i * 91 + 7) & 255;
    rgba[i * 4 + 2] = (255 - i * 13) & 255;
    rgba[i * 4 + 3] = (i * 5) & 255;
  }
  return rgba;
}

test('base64 matches the platform encoder', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 17, 256, 1000, 24576]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 101 + 3) & 255;
    assert.strictEqual(Png.base64(bytes), Buffer.from(bytes).toString('base64'), 'length ' + length);
  }
});

test('adler32 matches zlib', () => {
  const bytes = new Uint8Array(5000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
  // zlib's own header carries the Adler-32 of the uncompressed data at the end.
  const deflated = zlib.deflateSync(Buffer.from(bytes));
  const expected = deflated.readUInt32BE(deflated.length - 4);
  assert.strictEqual(Png.adler32(bytes), expected);
});

test('encodes a structurally valid PNG', () => {
  const width = 5;
  const height = 3;
  const png = Buffer.from(Png.encode(makePixels(width, height), width, height));

  assert.deepStrictEqual(
    Array.from(png.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
    'signature'
  );

  const chunks = readChunks(png);
  assert.deepStrictEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);

  chunks.forEach((chunk) => {
    assert.strictEqual(
      Png.crc32(chunk.crcInput, 0, chunk.crcInput.length),
      chunk.crc,
      chunk.type + ' CRC'
    );
    assert.strictEqual(zlib.crc32(chunk.crcInput), chunk.crc, chunk.type + ' CRC vs zlib');
  });

  const ihdr = chunks[0].data;
  assert.strictEqual(ihdr.readUInt32BE(0), width);
  assert.strictEqual(ihdr.readUInt32BE(4), height);
  assert.strictEqual(ihdr[8], 8, 'bit depth');
  assert.strictEqual(ihdr[9], 6, 'colour type RGBA');
  assert.strictEqual(ihdr[10], 0, 'compression');
  assert.strictEqual(ihdr[11], 0, 'filter');
  assert.strictEqual(ihdr[12], 0, 'interlace');
});

test('pixels survive the deflate stream unchanged', () => {
  const width = 9;
  const height = 7;
  const pixels = makePixels(width, height);
  const png = Buffer.from(Png.encode(pixels, width, height));
  const idat = readChunks(png).find((c) => c.type === 'IDAT');
  const raw = zlib.inflateSync(idat.data);

  assert.strictEqual(raw.length, height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    assert.strictEqual(raw[rowStart], 0, 'filter byte for row ' + y);
    for (let i = 0; i < width * 4; i++) {
      assert.strictEqual(raw[rowStart + 1 + i], pixels[y * width * 4 + i], 'row ' + y + ' byte ' + i);
    }
  }
});

test('stored blocks handle payloads larger than 64 KiB', () => {
  const width = 200;
  const height = 200; // 160 KB of raw scanlines, i.e. three deflate blocks
  const pixels = makePixels(width, height);
  const png = Buffer.from(Png.encode(pixels, width, height));
  const idat = readChunks(png).find((c) => c.type === 'IDAT');
  const raw = zlib.inflateSync(idat.data);
  assert.strictEqual(raw.length, height * (width * 4 + 1));
  assert.strictEqual(raw[raw.length - 1], pixels[pixels.length - 1]);
});

test('dataUri produces a decodable image', () => {
  const uri = Png.dataUri(makePixels(4, 4), 4, 4);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  const decoded = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64');
  assert.deepStrictEqual(Array.from(decoded.subarray(0, 4)), [137, 80, 78, 71]);
});

test('rejects a buffer that is too small', () => {
  assert.throws(() => Png.encode(new Uint8ClampedArray(4), 4, 4), /too small/);
});
