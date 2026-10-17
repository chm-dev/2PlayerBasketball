'use strict';
// Headless prediction/reconciliation test (plan §8). The bot below mirrors the
// client algorithm in game.js: it predicts the ball while it owns it, replays
// unacknowledged inputs against every authoritative snapshot, and must end up
// close to the server's state. A gross protocol/index/replay mistake shows up
// here as metres of divergence.
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const Sim = require('../sim');
const srv = require('../server');

const MAX_INPUTS_PER_TICK = 8;

class Bot {
  constructor(ws) {
    this.ws = ws;
    this.msgs = [];
    this.waiters = [];
    ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } this.msgs.push(m); this.pump(); });
  }
  pump() {
    for (const w of this.waiters.slice()) {
      const m = this.msgs.find(w.pred);
      if (m) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.to); w.res(m); }
    }
  }
  waitFor(pred, timeout = 5000) {
    const w = { pred, res: null, to: null };
    return new Promise((res, rej) => {
      w.res = res;
      w.to = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout')); }, timeout);
      this.waiters.push(w); this.pump();
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

// ---- the client-side algorithm, as in game.js ------------------------------
function makeClient(start) {
  const c = {
    P: Sim.load(start.S), token: start.token, seq: 0, inputs: [], maxErr: 0, snaps: 0,
  };
  c.send = (k, x, z) => {
    c.seq++;
    c.inputs.push({ seq: c.seq, k, x: x || 0, z: z || 0, tick: c.P.tick, used: false });
    c.ws.send({ t: 'i', seq: c.seq, k, x: x || 0, z: z || 0, token: c.token });
  };
  c.tick = () => {
    const t = c.P.tick + 1, batch = [];
    for (let i = 0; i < c.inputs.length && batch.length < MAX_INPUTS_PER_TICK; i++) {
      const e = c.inputs[i];
      if (!e.used && e.tick <= t) { e.used = true; batch.push(e); }
    }
    Sim.step(c.P, batch);
    c.P.events.length = 0;
  };
  c.onSnapshot = m => {
    c.snaps++;
    const A = m.a[0];                       // this bot is always p1
    const Tc = c.P.tick;
    for (let i = c.inputs.length - 1; i >= 0; i--) if (c.inputs[i].seq <= A) c.inputs.splice(i, 1);
    Sim.applySnapshot(c.P, m);
    for (const e of c.inputs) { e.used = false; if (e.tick <= m.tk) e.tick = m.tk + 1; }
    c.inputs.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
    let idx = 0;
    for (let t = m.tk + 1; t <= Tc; t++) {
      const batch = [];
      while (idx < c.inputs.length && c.inputs[idx].tick <= t && batch.length < MAX_INPUTS_PER_TICK) {
        c.inputs[idx].used = true; batch.push(c.inputs[idx]); idx++;
      }
      if (batch.length) Sim.step(c.P, batch);
    }
    c.P.events.length = 0;
    // error between the reconciled prediction and the authority for this snapshot
    const err = Math.hypot(c.P.ball.x - m.b[0], c.P.ball.y - m.b[1], c.P.ball.z - m.b[2]);
    if (err > c.maxErr) c.maxErr = err;
  };
  return c;
}

let port;
test.before(async () => { port = await srv.start(0); });
test.after(async () => { await srv.stop(); });

test('a predicting client tracks the authoritative ball during drag and flight', async () => {
  const a = await connect(port);
  const b = await connect(port);
  a.send({ t: 'join', v: srv.PROTOCOL });
  b.send({ t: 'join', v: srv.PROTOCOL });
  const start = await a.waitFor(m => m.t === 'start');
  const bot = makeClient(start);
  bot.ws = a;
  const seen = [];
  a.ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === 's') { bot.onSnapshot(m); seen.push(m); }
  });

  // drag the ball around its own half, then shoot
  bot.send('g', 0, -5);
  for (let i = 0; i < 30; i++) { bot.send('m', Math.sin(i / 4) * 3, -5 + Math.cos(i / 5) * 3); bot.tick(); await sleep(16); }
  bot.send('r');
  for (let i = 0; i < 120; i++) { bot.tick(); await sleep(16); }

  assert.ok(seen.length > 30, 'expected a stream of snapshots, got ' + seen.length);
  assert.ok(bot.snaps > 30, 'expected snapshots to reach the client');
  assert.ok(bot.inputs.length < 5, 'acknowledged inputs should be pruned, left ' + bot.inputs.length);
  // the reconciled prediction must stay in the same neighbourhood as the server
  assert.ok(bot.maxErr < 2, 'prediction diverged from authority by ' + bot.maxErr.toFixed(2));

  // the shot was released: the authoritative ball left the ground
  const top = Math.max(...seen.map(m => m.b[1]));
  assert.ok(top > 5, 'the ball should fly after release (max y ' + top + ')');

  a.close(); b.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
