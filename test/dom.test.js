'use strict';

const test = require('node:test');
const assert = require('node:assert');

/**
 * A fresh copy of the module for each test.  The panels a plugin has mounted
 * are module state - they have to be, because they are handed over together -
 * so tests that share one instance would hand each other their panels.
 */
function freshDom() {
  delete require.cache[require.resolve('../src/dom.js')];
  return require('../src/dom.js');
}

const D = freshDom();

/**
 * A stand-in for the host bridge that records what it was asked to register.
 * `setup` in UXP may be called exactly once and has to cover every panel the
 * manifest declares, so what matters is the shape of that single call.
 */
function fakeHost(supported) {
  const calls = [];
  return {
    calls,
    panelsSupported: () => supported !== false,
    registerPanels(panels) {
      calls.push(Object.keys(panels).sort());
      return true;
    }
  };
}

function fakeElement() {
  return { parentNode: null, style: {}, nodeType: 1 };
}

/** Enough of a document to watch the panels being handed over on time. */
function fakeDocument(readyState) {
  const listeners = {};
  return {
    readyState,
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      if (listeners[type].indexOf(fn) < 0) listeners[type].push(fn);
    },
    fire(type) {
      (listeners[type] || []).slice().forEach((fn) => fn());
    }
  };
}

function fakeNode() {
  const node = {
    nodeType: 1,
    style: {},
    children: [],
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
    }
  };
  return node;
}

test('every panel in the plugin is registered in one call', () => {
  const D = freshDom();
  const host = fakeHost();
  D.mountPanel(host, 'okpicker.panel', fakeElement(), {});
  D.mountPanel(host, 'okpicker.underpaint', fakeElement(), {});
  assert.deepStrictEqual(host.calls, [], 'nothing goes over until the flush');

  D.flushPanels();
  assert.deepStrictEqual(host.calls, [['okpicker.panel', 'okpicker.underpaint']]);
});

test('a panel that mounts late is sent along with the rest, not on its own', () => {
  // Which is the difference between a retry that works and one that fails the
  // same way: the host wants every panel the manifest declares, every time.
  const D = freshDom();
  const host = fakeHost();
  host.registerPanels = (given) => {
    host.calls.push(Object.keys(given).sort());
    return false; // as if the host refused this one
  };
  D.mountPanel(host, 'first', fakeElement(), {});
  D.flushPanels();
  D.mountPanel(host, 'second', fakeElement(), {});
  D.flushPanels();

  assert.deepStrictEqual(host.calls, [['first'], ['first', 'second']]);
});

test('flushing again does not register a second time', () => {
  const D = freshDom();
  const host = fakeHost();
  D.mountPanel(host, 'okpicker.panel', fakeElement(), {});
  D.flushPanels();
  D.flushPanels();
  assert.strictEqual(host.calls.length, 1);
});

test('the hand-over waits for every script in the document', async () => {
  // There is one hand-over and it has to carry every panel, so the moment it
  // happens at is the whole game.  A microtask is the trap: each script tag is
  // its own turn and microtasks drain at the end of each one, so a microtask
  // armed by the first panel's script fires before the second panel's script
  // has been read - and hands over half a plugin.
  const page = fakeDocument('loading');
  global.document = page;
  try {
    const D = freshDom();
    const host = fakeHost();

    D.mountPanel(host, 'first', fakeElement(), {});     // one script tag...
    await Promise.resolve();
    assert.deepStrictEqual(host.calls, [], 'not on a microtask');

    D.mountPanel(host, 'second', fakeElement(), {});    // ...and the next
    // A panel can also mount in a DOMContentLoaded handler of its own, and this
    // one was registered before theirs, so the hand-over cannot be in one too.
    page.addEventListener('DOMContentLoaded', function () {
      D.mountPanel(host, 'third', fakeElement(), {});
    });

    page.fire('DOMContentLoaded');
    assert.deepStrictEqual(host.calls, [], 'nor in a DOMContentLoaded handler');

    await new Promise(function (done) { setTimeout(done, 0); });
    assert.deepStrictEqual(host.calls, [['first', 'second', 'third']],
      'but in a task after all of them, with all of them');
  } finally {
    delete global.document;
  }
});

test('a panel takes whichever shape of root node it is handed', () => {
  // Manifest v4 wraps the node in an event, v5 passes it straight through, and
  // some hosts take the element the handler returns instead.
  [
    (node) => [node],
    (node) => [{ node }],
    (node) => [null, { node }]
  ].forEach((argsFor, i) => {
    const D = freshDom();
    const host = fakeHost();
    const element = fakeElement();
    D.mountPanel(host, 'panel' + i, element, {});
    const handlers = capture(D, host);

    const node = fakeNode();
    const returned = handlers['panel' + i].show.apply(null, argsFor(node));
    assert.strictEqual(element.parentNode, node, 'shape ' + i + ' attached');
    assert.strictEqual(node.style.height, '100%', 'and fills the panel');
    assert.strictEqual(returned, undefined);
  });
});

test('create hands back the element for hosts that want it that way', () => {
  const D = freshDom();
  const host = fakeHost();
  const element = fakeElement();
  D.mountPanel(host, 'panel', element, {});
  const handlers = capture(D, host);
  assert.strictEqual(handlers.panel.create(), element);
});

test('a panel is only attached once however often it is shown', () => {
  const D = freshDom();
  const host = fakeHost();
  const element = fakeElement();
  const seen = [];
  D.mountPanel(host, 'panel', element, { show: () => seen.push('show') });
  const handlers = capture(D, host);

  const node = fakeNode();
  handlers.panel.show(node);
  handlers.panel.show(node);
  assert.strictEqual(node.children.length, 1);
  assert.deepStrictEqual(seen, ['show', 'show'], 'but the hook still runs');
});

test('the mount reports whether the host takes panels at all', () => {
  const D = freshDom();
  const mounted = D.mountPanel(fakeHost(true), 'panel', fakeElement(), {});
  assert.strictEqual(mounted.registered, true);
  assert.strictEqual(mounted.host(), null, 'until a node arrives');
  D.flushPanels();

  const browser = D.mountPanel(fakeHost(false), 'panel', fakeElement(), {});
  assert.strictEqual(browser.registered, false);
  D.flushPanels();
});

test('the root node a panel was given is the one it should measure', () => {
  const D = freshDom();
  const host = fakeHost();
  const mounted = D.mountPanel(host, 'panel', fakeElement(), {});
  const handlers = capture(D, host);
  const node = fakeNode();
  handlers.panel.show(node);
  assert.strictEqual(mounted.host(), node);
});

test('panelNode ignores anything that is not an element', () => {
  assert.strictEqual(D.panelNode(undefined, undefined), null);
  assert.strictEqual(D.panelNode('nonsense', 7), null);
  assert.strictEqual(D.panelNode({ node: {} }, null), null, 'a node needs a nodeType');
});

/** Flush a mount and give back the handlers the host was sent. */
function capture(D, host) {
  let captured = null;
  const register = host.registerPanels;
  host.registerPanels = (panels) => {
    captured = panels;
    return register.call(host, panels);
  };
  D.flushPanels();
  return captured;
}
