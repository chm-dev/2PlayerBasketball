'use strict';
// Client boot smoke test: game.js is a browser script (no exports), so the only
// cheap way to catch module-level runtime errors without a browser is to stub
// the DOM just enough to load it and tick one frame. Verifies the boot path,
// the `Snap`/`Sim` globals and the debug handle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => { t[k] = v; return true; },
});
function makeEl() {
  return {
    style: {}, textContent: '', disabled: false, onclick: null, src: '',
    classList: { add() {}, remove() {}, contains: () => false },
    width: 100, height: 100,
    getContext: () => ctxStub,
    addEventListener() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
}

test('game.js boots against a stubbed DOM and exposes its handle', async () => {
  const els = new Map();
  let raf = null;
  global.window = global;
  global.document = {
    getElementById: id => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    createElement: () => makeEl(),
  };
  global.location = { search: '?lat=40&jit=10', protocol: 'http:', host: 'localhost:8080' };
  global.devicePixelRatio = 2;
  global.innerWidth = 800; global.innerHeight = 1200;
  global.addEventListener = () => {};
  global.requestAnimationFrame = cb => { raf = cb; };
  global.Image = class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
  global.Sim = require('../sim');
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'lib', 'snapshot-interpolation.js'), 'utf8'));
  assert.ok(global.Snap && global.Snap.SnapshotInterpolation, 'Snap global should be defined');

  require('../game.js');

  assert.ok(global.__bb, 'game.js should expose window.__bb');
  assert.equal(global.__bb.P, null, 'no prediction state before a match');
  assert.equal(global.__bb.UI.phase, 'menu');

  await new Promise(r => setTimeout(r, 5));   // let the image stubs settle -> rAF queued
  assert.equal(typeof raf, 'function', 'the frame loop should be scheduled');
  raf(16);                                     // render one menu frame
  raf(32);
  assert.equal(global.__bb.UI.phase, 'menu');
});
