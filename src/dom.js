'use strict';
/*
 * The two pieces of browser plumbing both panels need, and the one piece of
 * UXP plumbing that only appears once a plugin has more than one panel.
 *
 * A plugin's panels all share a single HTML document.  With one panel the
 * document's body *is* the panel and there is nothing to arrange; with two, the
 * host hands each entry point its own root node and expects the plugin to put
 * something in it.  `mountPanel` moves a subtree of the document into whichever
 * node arrives - and if none ever does, leaves everything where it is, which is
 * what happens when the file is opened in a plain browser to work on the UI.
 */
(function (root, factory) {
  var api = factory();
  root.OKDom = api;
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var doc = typeof document !== 'undefined' ? document : null;

  // ------------------------------------------------------------- surfaces
  // UXP's canvas implementation has improved a lot but is still worth probing
  // for: if it round-trips a putImageData we use it, otherwise we fall back to
  // an <img> fed with an inline PNG, which works everywhere.

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
      this.el.setAttribute('src', globalThis.OKPng.dataUri(img.data, img.width, img.height));
    }
  };

  // ----------------------------------------------------------- interaction

  /**
   * Press-and-drag on an element, reported as fractions of it.  The move and up
   * handlers go on the document so a drag that leaves the element keeps
   * tracking, which is what makes a slider usable at the edge of its travel.
   */
  function bindDrag(el, onMove, onEnd, against) {
    function fractions(e) {
      var r = (against || el).getBoundingClientRect();
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

    function up() {
      if (!moving) return;
      moving = false;
      doc.removeEventListener('mousemove', move, true);
      doc.removeEventListener('mouseup', up, true);
      if (onEnd) onEnd();
    }

    el.addEventListener('mousedown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      moving = true;
      if (e.preventDefault) e.preventDefault();
      // A handle sitting on top of a bigger draggable owns the press.
      if (e.stopPropagation) e.stopPropagation();
      onMove(fractions(e), true);
      doc.addEventListener('mousemove', move, true);
      doc.addEventListener('mouseup', up, true);
    });
  }

  // ------------------------------------------------------------- mounting

  /** The root node a panel lifecycle handler was given, whichever shape it came in. */
  function panelNode(a, b) {
    var candidates = [a, b, a && a.node, b && b.node];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && candidates[i].nodeType === 1) return candidates[i];
    }
    return null;
  }

  // Every panel in the plugin has to be handed over in one call, so they are
  // collected here and passed on together.  See `registerPanels` in ps.js for
  // what happens to a plugin that registers them one at a time.  They are kept
  // rather than consumed: a panel that mounts late arms another hand-over, and
  // that one carries all of them again rather than only the latecomer.
  var panels = {};
  var panelHost = null;
  var unsent = false;
  var scheduled = false;

  /**
   * Hand `element` to the panel entry point `id`.
   *
   * Appending moves the element, so the first time the host offers a root node
   * the markup leaves the body of its own accord and nothing has to be hidden
   * or torn down.  A host that never offers one - a browser, where there is no
   * UXP at all - simply leaves the document as it was written.
   *
   * Registration does not happen here: it is queued until every panel has
   * mounted, and `flushPanels` sends them.  Mount before building a panel's
   * contents rather than after, so that a controller that falls over on the way
   * up does not take the other panel's entry point down with it.
   *
   * @returns {{registered: boolean, host: function}} `host` is the node the
   *          panel was given, or null while the document is standing on its
   *          own.  A panel that sizes itself should measure that node rather
   *          than the window: with several panels in one document the window
   *          is not any one of them.
   */
  function mountPanel(PS, id, element, hooks) {
    hooks = hooks || {};
    var host = null;

    function attach(node) {
      if (!node || node === host) return;
      host = node;
      // The host node is the panel; fill it rather than sitting in a corner.
      try { node.style.height = '100%'; } catch (e) { /* not all hosts allow it */ }
      if (element.parentNode !== node) node.appendChild(element);
    }

    panelHost = PS;
    unsent = true;
    scheduleFlush();
    panels[id] = {
      create: function (a, b) {
        attach(panelNode(a, b));
        if (hooks.create) hooks.create();
        // Some hosts take the returned element as the panel's content instead.
        return element;
      },
      show: function (a, b) {
        attach(panelNode(a, b));
        if (hooks.show) hooks.show();
      },
      hide: function () {
        if (hooks.hide) hooks.hide();
      },
      destroy: function () {
        if (hooks.destroy) hooks.destroy();
      }
    };

    return {
      registered: PS.panelsSupported(),
      host: function () { return host; }
    };
  }

  /**
   * Wait until every panel in the document has had its chance to mount, then
   * hand them all over at once.
   *
   * The waiting is the whole point, because there is only ever one hand-over: a
   * plugin gets a single `setup` call and it has to carry every panel the
   * manifest declares.  So the moment has to be one that nothing can precede.
   *
   *   - Not a microtask.  Each script tag is its own turn and microtasks drain
   *     at the end of each one, so a microtask armed by the first panel's
   *     script runs before the second panel's script has even been read - and
   *     hands over half a plugin.
   *   - DOMContentLoaded is after every classic script has run, but panels can
   *     also mount *in* a DOMContentLoaded handler, and this one was registered
   *     before theirs.
   *   - A task queued from there is after all of those handlers, which is late
   *     enough for everything and no later.
   */
  function scheduleFlush() {
    if (scheduled || !doc) return;
    scheduled = true;
    function soon() { setTimeout(flushPanels, 0); }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', soon);
    else soon();
  }

  /** Send every panel mounted so far to the host.  Safe to call more than once. */
  function flushPanels() {
    scheduled = false;
    if (!unsent || !panelHost) return false;
    unsent = false;
    return panelHost.registerPanels(panels);
  }

  /**
   * Outside Photoshop every panel in the document is on screen at once, which
   * is no way to work on either of them.  A bar across the top picks one - the
   * whole of the development harness the README promises.
   */
  function devSwitcher(panels) {
    var bar = doc.createElement('div');
    bar.className = 'devbar';
    var buttons = [];

    function choose(index) {
      panels.forEach(function (panel, i) {
        panel.el.style.display = i === index ? '' : 'none';
        buttons[i].className = i === index ? 'devbutton on' : 'devbutton';
      });
      if (panels[index].onShow) panels[index].onShow();
    }

    panels.forEach(function (panel, i) {
      var button = doc.createElement('button');
      button.className = 'devbutton';
      button.textContent = panel.label;
      button.addEventListener('click', function () { choose(i); });
      buttons.push(button);
      bar.appendChild(button);
    });

    doc.body.insertBefore(bar, doc.body.firstChild);
    doc.body.className = doc.body.className ? doc.body.className + ' dev' : 'dev';
    choose(0);
  }

  return {
    canvasSupported: canvasSupported,
    Surface: Surface,
    bindDrag: bindDrag,
    panelNode: panelNode,
    mountPanel: mountPanel,
    flushPanels: flushPanels,
    devSwitcher: devSwitcher
  };
});
