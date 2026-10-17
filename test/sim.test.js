'use strict';
// Golden-replay / determinism tests for sim.js (plan §8).
// These lock the property the whole netcode depends on: same state + same inputs
// => same state, and a serialised state can be resumed (load/dump, snapshot/apply)
// and fast-forwarded deterministically.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Sim = require('../sim');

// p1 grabs the ball at its spawn, drags it toward the middle, then shoots.
function script() {
  const s = {};
  s[1] = [{ p: 1, k: 'g', x: 0, z: -5 }];
  for (let t = 2; t <= 12; t++) s[t] = [{ p: 1, k: 'm', x: (t - 2) * 0.4, z: -5 + (t - 2) * 0.5 }];
  s[13] = [{ p: 1, k: 'r' }];
  return s;
}

function run(ticks, sc) {
  const S = Sim.create();
  const states = [];
  for (let t = 1; t <= ticks; t++) {
    Sim.step(S, (sc && sc[t]) || []);
    states.push(Sim.dump(S));
  }
  return { S, states };
}

test('initial state', () => {
  const S = Sim.create();
  assert.equal(S.phase, 'playing');
  assert.deepEqual(S.scores, [0, 0, 0]);
  assert.equal(S.ball.x, 0);
  assert.equal(S.ball.z, -5);
  assert.equal(S.tick, 0);
});

test('deterministic replay of the same script', () => {
  const a = run(200, script());
  const b = run(200, script());
  for (let i = 0; i < a.states.length; i++) assert.deepEqual(a.states[i], b.states[i], 'tick ' + (i + 1));
});

test('dump/load round-trip resumes identically (reconciliation path)', () => {
  const full = run(240, script());
  const S = Sim.load(full.states[119]);           // state after tick 120
  assert.deepEqual(Sim.dump(S), full.states[119]);
  for (let t = 121; t <= 240; t++) {
    Sim.step(S, script()[t] || []);
    assert.deepEqual(Sim.dump(S), full.states[t - 1], 'tick ' + t);
  }
});

test('wire snapshot round-trip predicts the future (within rounding)', () => {
  const full = run(60, script());
  const wire = Sim.snapshot(full.S);              // rounded for the network
  const C = Sim.create();
  Sim.applySnapshot(C, wire);
  assert.equal(C.tick, full.S.tick);
  for (let i = 0; i < 30; i++) { Sim.step(C, []); Sim.step(full.S, []); }
  const dB = full.S.ball, cB = C.ball;
  const err = Math.hypot(dB.x - cB.x, dB.y - cB.y, dB.z - cB.z);
  assert.ok(err < 0.1, 'divergence from 2-decimal snapshots should stay tiny, got ' + err);
});

test('grab is restricted to the player half and to a 4-unit radius', () => {
  const S = Sim.create();                          // ball spawns at (0,-5), p1's half
  Sim.step(S, [{ p: 2, k: 'g', x: 0, z: -5 }]);    // p2 may not grab south
  assert.equal(S.ball.holder, 0);
  Sim.step(S, [{ p: 1, k: 'g', x: 20, z: -20 }]);  // too far away
  assert.equal(S.ball.holder, 0);
  Sim.step(S, [{ p: 1, k: 'g', x: 0, z: -5 }]);    // valid
  assert.equal(S.ball.holder, 1);
  assert.equal(S.possesso, 1);
});

test('release throws the ball up and hands ownership to the flight', () => {
  const S = Sim.create();
  Sim.step(S, [{ p: 1, k: 'g', x: 0, z: -5 }]);
  Sim.step(S, [{ p: 1, k: 'r' }]);
  assert.equal(S.ball.holder, 0);
  assert.equal(S.lastReleaser, 1);
  assert.ok(S.ball.vy > 70, 'release throws the ball up (THROW_UP minus one tick of gravity/drag)');
});

test('scoring flow: tween into the net, cheer, respawn on the conceding side', () => {
  const S = Sim.create();
  S.ball.x = 0; S.ball.y = 6.06; S.ball.z = 12;    // inside the north hoop trigger
  S.ball.vx = S.ball.vy = S.ball.vz = 0;
  const evs = Sim.step(S, []);
  assert.equal(S.phase, 'scoring');
  assert.deepEqual(S.scores, [0, 1, 0]);           // scoring the north hoop is Red's point
  assert.equal(S.aChi, 2);                         // Blue concedes
  assert.ok(evs.some(e => e.ev === 'scored'));

  let cheer = false, respawn = null;
  for (let i = 0; i < 120; i++) {
    for (const e of Sim.step(S, [])) {
      if (e.ev === 'cheer') cheer = true;
      if (e.ev === 'respawn') respawn = e;
    }
    if (S.phase === 'playing' && respawn) break;
  }
  assert.ok(cheer, 'cheer should fire when the net animation ends');
  assert.ok(respawn, 'a respawn event should fire');
  assert.equal(S.phase, 'playing');
  assert.equal(S.ball.z, 5);                       // ball to Blue's half
  assert.equal(S.possesso, 0);
});

test('fifth point finishes the match', () => {
  const S = Sim.create();
  S.scores[1] = 4;
  S.ball.x = 0; S.ball.y = 6.06; S.ball.z = 12;
  S.ball.vx = S.ball.vy = S.ball.vz = 0;
  let finished = null;
  for (let i = 0; i < 120 && !finished; i++) {
    for (const e of Sim.step(S, [])) if (e.ev === 'finished') finished = e;
  }
  assert.equal(S.scores[1], 5);
  assert.equal(S.phase, 'over');
  assert.equal(S.winner, 1);
  assert.equal(finished.winner, 1);
});

test('a ball rolled across the halfway line still resolves possession (no freeze)', () => {
  // Regression: groundTouch used to be gated on a *new* floor contact, so a ball
  // that crossed the centre line while already rolling on the ground kept the
  // shooter's possession with vincoli 0 forever -> nobody could pick it up.
  for (const dir of [1, -1]) {                    // +1: p1's shot rolled north, -1: p2's rolled south
    const S = Sim.create();
    Object.assign(S.ball, { x: 0, y: 1.28, z: -1 * dir, vx: 0, vy: 0, vz: 3 * dir,
      holder: 0, drag: 1, kin: false, xg: false, contacts: new Set(), trailOn: true });
    S.possesso = dir > 0 ? 1 : 2;
    S.lancio = 0; S.vincoli = 1; S.inHand = false;
    for (let i = 0; i < 900; i++) Sim.step(S, []);
    const B = S.ball;
    const speed = Math.sqrt(B.vx * B.vx + B.vy * B.vy + B.vz * B.vz);
    assert.equal(S.phase, 'playing');
    assert.ok(speed < 0.5, 'the ball should have come to rest');
    assert.ok(B.y < 1.33, 'the ball should be on the floor');
    assert.equal(S.possesso, 0, 'possession should have resolved to loose');
    assert.ok(S.vincoli > 0, 'the ball must be grabbable again (vincoli > 0)');
  }
});

test('fuzz: the ball never stays ungrabbable at rest on the floor', () => {
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 8; run++) {
    const S = Sim.create();
    let stuck = 0;
    for (let i = 0; i < 20000; i++) {
      const inputs = [];
      if (rnd() < 0.02) inputs.push({ p: rnd() < 0.5 ? 1 : 2, k: 'g', x: (rnd() - 0.5) * 12, z: (rnd() - 0.5) * 28 });
      if (rnd() < 0.06) inputs.push({ p: rnd() < 0.5 ? 1 : 2, k: 'm', x: (rnd() - 0.5) * 12, z: (rnd() - 0.5) * 28 });
      if (rnd() < 0.02) inputs.push({ p: rnd() < 0.5 ? 1 : 2, k: 'r' });
      Sim.step(S, inputs);
      // periodically seed the shape of the freeze that was fixed: a loose ball
      // rolling on the ground toward the centre line while the shooting side
      // still owns it
      if (i % 700 === 699 && S.phase === 'playing' && S.ball.holder === 0 && !S.ball.kin) {
        const dir = rnd() < 0.5 ? -1 : 1;
        Object.assign(S.ball, { x: (rnd() - 0.5) * 3, y: 1.28, z: -0.6 * dir, vx: 0, vy: 0,
          vz: (1 + rnd() * 6) * dir, kin: false, holder: 0, drag: 1 });
        S.possesso = dir > 0 ? 1 : 2;
        S.lancio = 0; S.vincoli = 1; S.inHand = false; S.lastReleaser = S.possesso;
      }
      const B = S.ball;
      const speed = Math.sqrt(B.vx * B.vx + B.vy * B.vy + B.vz * B.vz);
      const dead = S.phase === 'playing' && B.y <= 1.33 && speed < 0.5 && S.vincoli === 0;
      stuck = dead ? stuck + 1 : 0;
      assert.ok(stuck < 180, 'ball dead on the floor for ' + (stuck / 60).toFixed(1) +
        's (run ' + run + ', tick ' + S.tick + ', possesso ' + S.possesso + ', lancio ' + S.lancio + ')');
    }
  }
});

test('determinism hygiene: no Math.hypot / Math.random in the sim', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sim.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!/Math\.hypot\(/.test(code), 'sim.js must not use Math.hypot');
  assert.ok(!/Math\.random\(/.test(code), 'sim.js must not use Math.random');
});
