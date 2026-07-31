'use strict';
/*
 * Minimal RGBA -> PNG encoder plus base64, used to feed <img src="data:...">.
 *
 * UXP's canvas support has historically been patchy, so the renderer needs a
 * path that only depends on <img> and data URIs.  Deflate "stored" blocks keep
 * this dependency-free; the images are small and short lived, so the ~1.4x size
 * penalty over real compression does not matter.
 */
(function (root, factory) {
  var api = factory();
  root.OKPng = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, start, end) {
    var c = 0xFFFFFFFF;
    for (var i = start; i < end; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(bytes) {
    var a = 1, b = 0, len = bytes.length, i = 0;
    // Process in blocks so the sums cannot overflow a double's integer range.
    while (i < len) {
      var end = Math.min(i + 5552, len);
      for (; i < end; i++) {
        a += bytes[i];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64(bytes) {
    var out = '';
    var chunk = [];
    var len = bytes.length;
    var i = 0;
    for (; i + 2 < len; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunk.push(
        BASE64_CHARS[(n >>> 18) & 63], BASE64_CHARS[(n >>> 12) & 63],
        BASE64_CHARS[(n >>> 6) & 63], BASE64_CHARS[n & 63]
      );
      if (chunk.length >= 8192) { out += chunk.join(''); chunk.length = 0; }
    }
    var rem = len - i;
    if (rem === 1) {
      var n1 = bytes[i] << 16;
      chunk.push(BASE64_CHARS[(n1 >>> 18) & 63], BASE64_CHARS[(n1 >>> 12) & 63], '=', '=');
    } else if (rem === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      chunk.push(
        BASE64_CHARS[(n2 >>> 18) & 63], BASE64_CHARS[(n2 >>> 12) & 63],
        BASE64_CHARS[(n2 >>> 6) & 63], '='
      );
    }
    out += chunk.join('');
    return out;
  }

  /** Wrap raw bytes in a zlib stream made of uncompressed deflate blocks. */
  function zlibStore(raw) {
    var MAX = 65535;
    var blocks = Math.max(1, Math.ceil(raw.length / MAX));
    var out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
    var p = 0;
    out[p++] = 0x78; // CM = deflate, CINFO = 32K window
    out[p++] = 0x01; // FCHECK, no preset dictionary, fastest compression
    var offset = 0;
    for (var i = 0; i < blocks; i++) {
      var len = Math.min(MAX, raw.length - offset);
      var last = (i === blocks - 1) ? 1 : 0;
      out[p++] = last;
      out[p++] = len & 0xFF;
      out[p++] = (len >>> 8) & 0xFF;
      out[p++] = (~len) & 0xFF;
      out[p++] = ((~len) >>> 8) & 0xFF;
      out.set(raw.subarray(offset, offset + len), p);
      p += len;
      offset += len;
    }
    var ad = adler32(raw);
    out[p++] = (ad >>> 24) & 0xFF;
    out[p++] = (ad >>> 16) & 0xFF;
    out[p++] = (ad >>> 8) & 0xFF;
    out[p++] = ad & 0xFF;
    return out;
  }

  function writeUint32(bytes, p, value) {
    bytes[p] = (value >>> 24) & 0xFF;
    bytes[p + 1] = (value >>> 16) & 0xFF;
    bytes[p + 2] = (value >>> 8) & 0xFF;
    bytes[p + 3] = value & 0xFF;
  }

  var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  /**
   * @param {Uint8Array|Uint8ClampedArray} rgba  width*height*4 samples
   * @returns {Uint8Array} a complete PNG file
   */
  function encode(rgba, width, height) {
    if (rgba.length < width * height * 4) {
      throw new Error('pixel buffer too small for ' + width + 'x' + height);
    }
    var stride = width * 4;
    var raw = new Uint8Array(height * (stride + 1));
    for (var y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0; // filter type: none
      raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    }
    var idat = zlibStore(raw);

    var size = SIGNATURE.length + (12 + 13) + (12 + idat.length) + 12;
    var png = new Uint8Array(size);
    var p = 0;
    for (var i = 0; i < SIGNATURE.length; i++) png[p++] = SIGNATURE[i];

    // IHDR
    writeUint32(png, p, 13); p += 4;
    var ihdrStart = p;
    png[p++] = 73; png[p++] = 72; png[p++] = 68; png[p++] = 82; // "IHDR"
    writeUint32(png, p, width); p += 4;
    writeUint32(png, p, height); p += 4;
    png[p++] = 8; // bit depth
    png[p++] = 6; // colour type: truecolour with alpha
    png[p++] = 0; // compression
    png[p++] = 0; // filter
    png[p++] = 0; // interlace
    writeUint32(png, p, crc32(png, ihdrStart, p)); p += 4;

    // IDAT
    writeUint32(png, p, idat.length); p += 4;
    var idatStart = p;
    png[p++] = 73; png[p++] = 68; png[p++] = 65; png[p++] = 84; // "IDAT"
    png.set(idat, p); p += idat.length;
    writeUint32(png, p, crc32(png, idatStart, p)); p += 4;

    // IEND
    writeUint32(png, p, 0); p += 4;
    var iendStart = p;
    png[p++] = 73; png[p++] = 69; png[p++] = 78; png[p++] = 68; // "IEND"
    writeUint32(png, p, crc32(png, iendStart, p)); p += 4;

    return png;
  }

  function dataUri(rgba, width, height) {
    return 'data:image/png;base64,' + base64(encode(rgba, width, height));
  }

  return {
    crc32: crc32,
    adler32: adler32,
    base64: base64,
    encode: encode,
    dataUri: dataUri
  };
});
