'use strict';
// Headless bot clients against the real server (plan §8): exercises pairing,
// protocol v2, input→sim→snapshot→ack, event relay and disconnect handling
// without a browser.
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const srv = require('../server');

class Bot {
  constructor(ws) {
    this.ws = ws;
    this.msgs = [];
    this.waiters = [];
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      this.msgs.push(m);
      this.pump();
    });
  }
  pump() {
    for (const w of this.waiters.slice()) {
      const m = this.msgs.find(w.pred);
      if (m) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.to); w.res(m); }
    }
  }
  waitFor(pred, timeout = 3000) {
    const w = { pred, res: null, to: null };
    return new Promise((res, rej) => {
      w.res = res;
      w.to = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error('timeout waiting for a message'));
      }, timeout);
      this.waiters.push(w);
      this.pump();
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    ws.on('open', () => resolve(new Bot(ws)));
    ws.on('error', reject);
  });
}

let port;
test.before(async () => { port = await srv.start(0); });
test.after(async () => { await srv.stop(); });

test('two clients pair, receive a start state, and the sim reacts to input', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });

  const roomA = await a.waitFor(m => m.t === 'room');
  const roomB = await b.waitFor(m => m.t === 'room');
  assert.equal(roomA.role, 'p1');
  assert.equal(roomB.role, 'p2');

  const start = await a.waitFor(m => m.t === 'start');
  assert.ok(start.token, 'start carries a match token');
  assert.ok(start.S && Array.isArray(start.S.b), 'start carries the full sim state');
  assert.equal(start.S.ph, 'playing');

  // p1 grabs the ball at its spawn in the south half
  a.send({ t: 'i', seq: 1, k: 'g', x: 0, z: -5, token: start.token });
  const held = await a.waitFor(m => m.t === 's' && m.h === 1);
  assert.ok(held.a[0] >= 1, 'ack advances with the consumed input');
  assert.ok(held.tk > 0, 'snapshots carry a tick');

  // the grab is relayed as an authoritative event
  const grabEv = await a.waitFor(m => m.t === 'e' && m.evs.some(e => e.ev === 'grab'));
  assert.ok(grabEv.evs.some(e => e.ev === 'grab' && e.p === 1));

  // release -> the ball is thrown up (vy carries the throw)
  a.send({ t: 'i', seq: 2, k: 'r', token: start.token });
  const flying = await a.waitFor(m => m.t === 's' && m.h === 0 && m.b[4] > 10);
  assert.ok(flying.b[4] > 10, 'release gives the ball upward velocity');

  // ticks keep increasing
  const later = await a.waitFor(m => m.t === 's' && m.tk > flying.tk);
  assert.ok(later.tk > flying.tk);

  a.close(); b.close();
});

test('out-of-range and duplicate inputs are rejected', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  const start = await a.waitFor(m => m.t === 'start');

  a.send({ t: 'i', seq: 1, k: 'g', x: 999, z: 999, token: start.token });   // out of range
  a.send({ t: 'i', seq: 2, k: 'g', x: 0, z: -5, token: 'bogus' });          // wrong token
  const snap = await a.waitFor(m => m.t === 's' && m.tk >= 4);
  assert.equal(snap.h, 0, 'invalid inputs must not grab the ball');
  assert.equal(snap.a[0], 0, 'invalid inputs are never acknowledged');

  a.close(); b.close();
});

test('a client on the wrong protocol version is turned away', async () => {
  const c = await connect(port);
  c.send({ t: 'join', v: srv.PROTOCOL - 1 });
  const ver = await c.waitFor(m => m.t === 'ver');
  assert.equal(ver.v, srv.PROTOCOL);
  c.close();
});

test('disconnect notifies the partner', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  await a.waitFor(m => m.t === 'start');
  b.close();
  const left = await a.waitFor(m => m.t === 'opp_left');
  assert.equal(left.t, 'opp_left');
  a.close();
});

test('either player can restart the match', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  const first = await a.waitFor(m => m.t === 'start');
  a.send({ t: 'again' });
  const second = await a.waitFor(m => m.t === 'start' && m.token !== first.token);
  assert.notEqual(second.token, first.token);
  assert.equal(second.S.tick, 0);
  a.close(); b.close();
});
