'use strict';
/*
 * DOM plumbing shared by the panels: somewhere to put a bitmap, and pointer
 * dragging.
 *
 * UXP's canvas implementation has improved a lot but is still worth probing
 * for: if it round-trips a putImageData we use it, otherwise we fall back to an
 * <img> fed with an inline PNG, which works everywhere.
 */
(function (root, factory) {
  var dep = root.OKPng;
  if (!dep && typeof require === 'function' && typeof module === 'object') dep = require('./png.js');
  var api = factory(dep);
  root.OKSurface = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (OKPng) {

  var doc = typeof document !== 'undefined' ? document : null;
  var canvasProbe = null;

  function canvasSupported() {
    if (canvasProbe !== null) return canvasProbe;
    canvasProbe = false;
    try {
      var c = doc.createElement('canvas');
      c.width = 2;
      c.height = 2;
      var ctx = c.getContext('2d');
      if (ctx && ctx.createImageData && ctx.putImageData && ctx.getImageData) {
        var id = ctx.createImageData(2, 2);
        id.data[0] = 12; id.data[1] = 34; id.data[2] = 56; id.data[3] = 255;
        ctx.putImageData(id, 0, 0);
        var back = ctx.getImageData(0, 0, 1, 1).data;
        canvasProbe = back[0] === 12 && back[1] === 34 && back[2] === 56 && back[3] === 255;
      }
    } catch (e) {
      canvasProbe = false;
    }
    return canvasProbe;
  }

  function Surface(container) {
    this.kind = canvasSupported() ? 'canvas' : 'img';
    this.el = doc.createElement(this.kind === 'canvas' ? 'canvas' : 'img');
    container.appendChild(this.el);
  }

  Surface.prototype.paint = function (img) {
    if (this.kind === 'canvas') {
      var el = this.el;
      // Assigning width/height wipes the bitmap, so only touch them when the
      // pixel size really changed: otherwise every repaint would flash.
      if (el.width !== img.width || el.height !== img.height) {
        el.width = img.width;
        el.height = img.height;
      }
      var ctx = el.getContext('2d');
      var id = ctx.createImageData(img.width, img.height);
      id.data.set(img.data);
      ctx.putImageData(id, 0, 0);
    } else {
      this.el.setAttribute('src', OKPng.dataUri(img.data, img.width, img.height));
    }
  };

  /**
   * Track a press and drag over `el`, reporting the pointer as fractions of the
   * element's box.  The fractions are deliberately not clamped: a caller that
   * wants to know the pointer has been dragged well clear of the control (to
   * throw something away, say) can see that it has.
   */
  function bindDrag(el, onMove, onEnd) {
    function fractions(e) {
      var r = el.getBoundingClientRect();
      return {
        x: r.width ? (e.clientX - r.left) / r.width : 0,
        y: r.height ? (e.clientY - r.top) / r.height : 0
      };
    }
    var moving = false;

    function move(e) {
      if (!moving) return;
      onMove(fractions(e), false);
    }

    function up(e) {
      if (!moving) return;
      moving = false;
      doc.removeEventListener('mousemove', move, true);
      doc.removeEventListener('mouseup', up, true);
      if (onEnd) onEnd(fractions(e));
    }

    el.addEventListener('mousedown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      moving = true;
      if (e.preventDefault) e.preventDefault();
      onMove(fractions(e), true);
      doc.addEventListener('mousemove', move, true);
      doc.addEventListener('mouseup', up, true);
    });
  }

  function pixelRatio() {
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return dpr > 1 ? Math.min(dpr, 2) : 1;
  }

  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : function (fn) { return setTimeout(fn, 16); };

  /** Height of the box a panel has been given, measured from the panel element
   *  itself so two panels in one document do not have to share a viewport. */
  function boxHeight(el, fallback) {
    var h = 0;
    try { h = el.getBoundingClientRect().height; } catch (e) { h = 0; }
    if (h > 0) return h;
    if (typeof window !== 'undefined' && window.innerHeight > 0) return window.innerHeight;
    return fallback || 420;
  }

  function boxWidth(el, fallback) {
    var w = 0;
    try { w = el.getBoundingClientRect().width; } catch (e) { w = 0; }
    return w > 0 ? w : (fallback || 240);
  }

  return {
    canvasSupported: canvasSupported,
    Surface: Surface,
    bindDrag: bindDrag,
    pixelRatio: pixelRatio,
    raf: raf,
    boxHeight: boxHeight,
    boxWidth: boxWidth
  };
});
