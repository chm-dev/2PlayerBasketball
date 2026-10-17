'use strict';
// sim.js — shared headless basketball simulation.
// One file, three users: server.js (authority), game.js (client prediction/replay),
// Node tests (deterministic replay). Pure: explicit state in, events out — no DOM,
// no audio, no Math.random, no timing APIs in the ball path. The physics is a
// faithful port of the original Unity PhysX scene (see AGENTS.md / README.md).
//
// UMD-ish boilerplate: sets window.Sim as a <script> tag, module.exports in Node.
// Wrapped in an IIFE so it never leaks a global lexical binding (a top-level
// `const Sim` here would collide with `const Sim = window.Sim` in game.js).
(function (root) {
  const FIXED = 0.0166;            // TimeManager fixed timestep
  const GRAVITY = -9.81;           // PhysicsManager
  const EXTRA_GRAVITY = -100;      // ApplicaForzaCostante on the ball
  const BALL_R = 1.28;             // ball SphereCollider radius
  const HALF_W = 6.933;            // MuroEst/MuroOvest x (walls follow the camera edge)
  const HALF_L = 15;               // MuroNord/MuroSud z and ortho size
  const BOUNCE_THRESHOLD = 2;
  const SCORE_TO_WIN = 5;
  const THROW_UP = 75;             // potenzaLancioAlto
  const DRAG_POWER = 500, DRAG_MAX_DIST = 4, HELD_DRAG = 20, FREE_DRAG = 1, HOLD_PLANE_Y = 2;
  const MAX_H_SPEED = 100, MAX_Y = 30, GRAVITY_ON_Y = 1.6;
  const TRIGGER_R = 0.75 * 1.7 + BALL_R;
  const SCORING_TIME = 0.5;        // ball shrink-into-net (was a 0.5 s tween)
  const RESPAWN_TIME = 1.0;        // pause before respawn (was a 1 s delay)

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Determinism hygiene: explicit Math.sqrt instead of Math.hypot, which is not
  // bit-identical across JS engines (plan §3).
  const len = a => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  const len2 = (x, z) => Math.sqrt(x * x + z * z);
  const len3d = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  const r2 = v => Math.round(v * 100) / 100;

  // ---------------------------------------------------------------- hoops (Canestro prefabs)
  function makeHoop(s, player) {
    const hz = 8.5 * s, c = Math.cos(Math.PI / 6), sn = 0.5;   // colliders tilted 30 deg about X
    const P = l => [s * l[0], l[1], hz + s * l[2]];
    const D = l => [s * l[0], l[1], s * l[2]];
    return {
      s, hz, player, timer: 0, inTrig: false,
      ex: D([1, 0, 0]), ey: D([0, c, sn]), ez: D([0, -sn, c]),
      base: { B: P([0, 0, 0]), h: 4.95, R: 1.5 },
      rim: { B: P([0, 4.33, 2.5]), h: 2.10375, R: 1.6 },
      board: { C: P([0, 0, 4.5]), half: [2.625, 7.5, 2.025] },
      trig: P([0, 6.06, 3.5]),
    };
  }

  // ---------------------------------------------------------------- state
  // S is the complete shared state (plan §3.1). Players are p1 (Red/south, z<0)
  // and p2 (Blue/north, z>0); ids are 1 and 2, 0 means "no one".
  function create() {
    return {
      tick: 0,
      ball: { x: 0, y: 10, z: -5, vx: 0, vy: 0, vz: 0, scale: 1, rot: 0, kin: false, holder: 0,
        drag: FREE_DRAG, tx: 0, ty: HOLD_PLANE_Y, tz: 0, xg: false, contacts: new Set(), trailOn: true },
      hoops: [makeHoop(1, 2), makeHoop(-1, 1)],
      phase: 'playing', scores: [0, 0, 0], winner: 0,
      possesso: 0, vincoli: 1, lancio: 0, inHand: false, aChi: 0, lastReleaser: 0,
      scoringTimer: 0, respawnTimer: 0, scoreDone: false, scoreFrom: null, scoreTo: null,
      restTicks: 0,                          // dead-ball watchdog counter (see deadBallGuard)
      hold: { 1: null, 2: null },          // last pointer position per player (drag target source)
      stepContacts: new Map(),
      events: [],                           // events emitted by the last step()
    };
  }

  // ---------------------------------------------------------------- input events
  // Inputs are plain { p, k, x, z } with k in { 'g' = grab, 'm' = move, 'r' = release }.
  // The caller feeds the per-tick batch into step(); validation happens here so
  // server, client prediction and replay all run the exact same logic.
  function applyInput(S, inp) {
    if (inp.k === 'g') tryGrab(S, inp.p, inp.x, inp.z);
    else if (inp.k === 'm') S.hold[inp.p] = { x: inp.x, z: inp.z };
    else if (inp.k === 'r') tryRelease(S, inp.p);
  }

  function tryGrab(S, p, x, z) {
    const B = S.ball;
    if (S.phase !== 'playing' || B.kin || B.holder !== 0 || S.vincoli <= 0) return;
    if (p === 1 ? B.z > 0 : B.z < 0) return;     // half rule: p1 south, p2 north
    if (len2(x - B.x, z - B.z) >= DRAG_MAX_DIST) return;
    S.hold[p] = { x, z };
    B.holder = p; B.drag = HELD_DRAG;
    B.tx = B.x; B.ty = HOLD_PLANE_Y; B.tz = B.z;
    S.inHand = true;
    S.possesso = B.z > 0 ? 2 : 1;
    S.lastReleaser = 0;
    S.events.push({ ev: 'grab', p });
  }

  function tryRelease(S, p) {
    const B = S.ball;
    if (B.holder !== p) return;
    B.holder = 0; B.drag = FREE_DRAG;
    S.inHand = false;
    B.vy = THROW_UP;                              // LanciaPalla
    S.lastReleaser = p;
    S.events.push({ ev: 'release', p });
  }

  function planeActive(S, x, z) {   // TriggerRosso covers z<0, TriggerBlu z>0; the opponent's plane is off while a side owns the ball
    if (Math.abs(x) > 25 || Math.abs(z) > 25) return false;
    return z < 0 ? S.possesso !== 2 : z > 0 ? S.possesso !== 1 : true;
  }

  function onKeep(S) {
    const B = S.ball;
    if (B.holder === 0) return;
    const f = S.hold[B.holder];
    if (!f || !planeActive(S, f.x, f.z)) return;
    let dx = f.x - B.x, dz = f.z - B.z;
    const d = len2(dx, dz);
    if (d > DRAG_MAX_DIST) { dx *= DRAG_MAX_DIST / d; dz *= DRAG_MAX_DIST / d; }
    B.tx = B.x + dx; B.tz = B.z + dz; B.ty = HOLD_PLANE_Y;
  }

  // ---------------------------------------------------------------- match flow
  function placeBall(S) {
    const B = S.ball;
    B.x = 0; B.y = 10; B.z = S.aChi === 2 ? 5 : -5;
    B.vx = 0; B.vy = 0; B.vz = 0;
    B.kin = false; B.scale = 1; B.rot = 0; B.holder = 0; B.xg = false;
    B.drag = FREE_DRAG; B.trailOn = true;
    B.contacts.clear();
    S.inHand = false; S.lancio = 0; S.vincoli = 1;
    S.hoops.forEach(h => { h.inTrig = false; });
    S.possesso = 0; S.lastReleaser = 0;
    S.events.push({ ev: 'respawn', x: 0, z: B.z });
  }

  function groundTouch(S) {
    const B = S.ball;
    if (S.lancio === 2) { if (B.z > 0) return; }
    else if (S.lancio === 1) { if (B.z < 0) return; }
    else return;
    S.lancio = 0; S.possesso = 0;
    S.lastReleaser = 0;   // the shot is dead: ownership reverts to the half rule
  }

  function hoopScored(S, h) {
    if (h.timer > 0 || S.phase !== 'playing') return;
    h.timer = 1;
    const B = S.ball;
    B.kin = true; B.vx = B.vy = B.vz = 0;
    if (B.holder !== 0) { B.holder = 0; B.drag = FREE_DRAG; S.inHand = false; }
    S.phase = 'scoring';
    S.scoringTimer = 0; S.scoreDone = false;
    S.scoreFrom = { x: B.x, y: B.y, z: B.z };
    S.scoreTo = { x: 0, y: 0, z: h.hz + h.s * 2 };   // EntrataPalla
    S.aChi = h.player;                               // the conceding side gets the ball
    S.scores[h.player === 1 ? 2 : 1]++;
    S.events.push({ ev: 'scored', by: h.player === 1 ? 2 : 1 });
  }

  function afterNet(S) {
    S.ball.trailOn = false;
    S.events.push({ ev: 'cheer' });
    if (S.scores[2] >= SCORE_TO_WIN) return finish(S, 2);
    if (S.scores[1] >= SCORE_TO_WIN) return finish(S, 1);
    S.respawnTimer = 0;
  }

  function finish(S, winner) {
    S.winner = winner; S.phase = 'over';
    S.events.push({ ev: 'finished', winner });
  }

  // ---------------------------------------------------------------- physics
  function cylContact(c, Bp, ax, h, Rr) {
    const d = [c[0] - Bp[0], c[1] - Bp[1], c[2] - Bp[2]];
    const a = dot(d, ax);
    const rad = [d[0] - a * ax[0], d[1] - a * ax[1], d[2] - a * ax[2]];
    const rho = len(rad);
    const radN = rho > 1e-9 ? [rad[0] / rho, rad[1] / rho, rad[2] / rho] : [0, 1, 0];
    if (a < 0 || a > h || rho > Rr) {
      const a2 = clamp(a, 0, h), r2c = Math.min(rho, Rr);
      const q = [Bp[0] + ax[0] * a2 + radN[0] * r2c, Bp[1] + ax[1] * a2 + radN[1] * r2c, Bp[2] + ax[2] * a2 + radN[2] * r2c];
      const n = [c[0] - q[0], c[1] - q[1], c[2] - q[2]];
      const dist = len(n);
      if (dist >= BALL_R || dist < 1e-9) return null;
      return { n: [n[0] / dist, n[1] / dist, n[2] / dist], pen: BALL_R - dist };
    }
    const dB = a, dT = h - a, dS = Rr - rho, m = Math.min(dB, dT, dS);
    const n = m === dS ? radN : m === dT ? ax : [-ax[0], -ax[1], -ax[2]];
    return { n, pen: BALL_R + m };
  }

  function boxContact(c, C, h) {
    const p = [c[0] - C[0], c[1] - C[1], c[2] - C[2]];
    const ax = [h.ex, h.ey, h.ez], half = h.board.half;
    const u = ax.map(a => dot(p, a));
    const cl = u.map((v, i) => clamp(v, -half[i], half[i]));
    const out = u.some((v, i) => Math.abs(v) > half[i]);
    if (out) {
      const n = [0, 0, 0];
      for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) n[k] += (u[i] - cl[i]) * ax[i][k];
      const dist = len(n);
      if (dist >= BALL_R || dist < 1e-9) return null;
      return { n: [n[0] / dist, n[1] / dist, n[2] / dist], pen: BALL_R - dist };
    }
    let bi = 0, bd = Infinity, bs = 1;
    for (let i = 0; i < 3; i++) {
      const dp = half[i] - u[i], dm = half[i] + u[i];
      if (dp < bd) { bd = dp; bi = i; bs = 1; }
      if (dm < bd) { bd = dm; bi = i; bs = -1; }
    }
    const n = [ax[bi][0] * bs, ax[bi][1] * bs, ax[bi][2] * bs];
    return { n, pen: BALL_R + bd };
  }

  function response(S, key, n, pen, e) {
    const B = S.ball;
    B.x += n[0] * pen; B.y += n[1] * pen; B.z += n[2] * pen;
    const vn = B.vx * n[0] + B.vy * n[1] + B.vz * n[2];
    let impact = 0;
    if (vn < 0) {
      impact = -vn;
      const k = impact > BOUNCE_THRESHOLD ? 1 + e : 1;
      B.vx -= k * vn * n[0]; B.vy -= k * vn * n[1]; B.vz -= k * vn * n[2];
    }
    const prev = S.stepContacts.get(key);
    if (!prev || impact > prev) S.stepContacts.set(key, impact);
  }

  function collide(S) {
    const B = S.ball;
    for (let pass = 0; pass < 2; pass++) {
      if (B.y < BALL_R) response(S, 'floor', [0, 1, 0], BALL_R - B.y, 0.9);
      if (B.x > HALF_W - BALL_R) response(S, 'wallE', [-1, 0, 0], B.x - (HALF_W - BALL_R), 0.9);
      if (B.x < -HALF_W + BALL_R) response(S, 'wallW', [1, 0, 0], -HALF_W + BALL_R - B.x, 0.9);
      if (B.z > HALF_L - BALL_R) response(S, 'wallN', [0, 0, -1], B.z - (HALF_L - BALL_R), 0.9);
      if (B.z < -HALF_L + BALL_R) response(S, 'wallS', [0, 0, 1], -HALF_L + BALL_R - B.z, 0.9);
      S.hoops.forEach((h, i) => {
        let r = cylContact([B.x, B.y, B.z], h.base.B, h.ey, h.base.h, h.base.R);
        if (r) response(S, 'base' + i, r.n, r.pen, 0);
        r = cylContact([B.x, B.y, B.z], h.rim.B, h.ey, h.rim.h, h.rim.R);
        if (r) response(S, 'rim' + i, r.n, r.pen, 0.4);
        r = boxContact([B.x, B.y, B.z], h.board.C, h);
        if (r) response(S, 'board' + i, r.n, r.pen, 0.4);
      });
    }
  }

  function physicsStep(S) {
    const B = S.ball, dt = FIXED;
    if (B.kin) return;
    B.vy += (GRAVITY + (B.xg ? EXTRA_GRAVITY : 0)) * dt;
    if (B.holder !== 0) {
      B.vx += DRAG_POWER * (B.tx - B.x) * dt;
      B.vy += DRAG_POWER * (B.ty - B.y) * dt;
      B.vz += DRAG_POWER * (B.tz - B.z) * dt;
    }
    const f = Math.max(0, 1 - B.drag * dt);
    B.vx *= f; B.vy *= f; B.vz *= f;
    const hs = len2(B.vx, B.vz);
    if (hs > MAX_H_SPEED) { B.vx *= MAX_H_SPEED / hs; B.vz *= MAX_H_SPEED / hs; }
    B.x += B.vx * dt; B.y += B.vy * dt; B.z += B.vz * dt;
    S.stepContacts.clear();
    collide(S);
    S.stepContacts.forEach((impact, key) => {
      // Sounds/particles only fire on a *new* contact, so a resting ball does not
      // replay its bounce and a rim grind does not spam.
      if (!B.contacts.has(key) && impact > 2) {
        if (key.startsWith('rim')) S.events.push({ ev: 'rim', x: r2(B.x), z: r2(B.z) });
        else S.events.push({ ev: 'bounce', impact: r2(impact) });
      }
      // ...but landing must be evaluated every tick the ball is on the floor.
      // Gating groundTouch on a new contact left possession unresolved forever
      // when the ball rolled across the halfway line while it was already
      // touching the ground: vincoli stayed 0 and neither player could grab it.
      if (key === 'floor') groundTouch(S);
    });
    B.contacts = new Set(S.stepContacts.keys());
    // hoop triggers (above the ring) — 3D distance to the trigger sphere
    S.hoops.forEach(h => {
      const inside = len3d(B.x - h.trig[0], B.y - h.trig[1], B.z - h.trig[2]) < TRIGGER_R;
      if (inside && !h.inTrig) hoopScored(S, h);
      h.inTrig = inside;
    });
  }

  // Safety net (see AGENTS.md): possession is only unresolved while a shot is in
  // flight, and a live shot is never stationary. If the ball somehow ends up
  // motionless with vincoli 0 — a dead ball, whatever the cause or resting place
  // — fall back to the half-rule so a match can never stall permanently.
  const DEAD_BALL_TICKS = 120;   // ~2 s
  function deadBallGuard(S) {
    const B = S.ball;
    const stuck = S.phase === 'playing' && S.vincoli === 0 && B.holder === 0 && !B.kin &&
      (B.vx * B.vx + B.vy * B.vy + B.vz * B.vz) < 0.25;
    S.restTicks = stuck ? S.restTicks + 1 : 0;
    if (S.restTicks >= DEAD_BALL_TICKS) {
      S.possesso = 0; S.lancio = 0; S.vincoli = 1; S.lastReleaser = 0; S.inHand = false;
      S.restTicks = 0;
      S.events.push({ ev: 'unstick' });   // diagnostic only; clients ignore it
    }
  }

  // ---------------------------------------------------------------- one fixed tick
  // inputs: this tick's input events, applied in order before the physics step.
  function step(S, inputs) {
    S.tick++;
    S.events.length = 0;
    if (inputs) for (let i = 0; i < inputs.length; i++) applyInput(S, inputs[i]);
    const B = S.ball;
    // hoop hit cooldowns freeze during 'over' (as in the original update())
    if (S.phase === 'playing' || S.phase === 'scoring') {
      for (let i = 0; i < S.hoops.length; i++) {
        const h = S.hoops[i];
        if (h.timer > 0) h.timer -= FIXED;
      }
    }
    if (S.phase === 'scoring') {
      if (!S.scoreDone) {
        S.scoringTimer += FIXED;
        if (S.scoreFrom && S.scoreTo) {
          const t = Math.min(1, S.scoringTimer / SCORING_TIME);
          B.x = S.scoreFrom.x + (S.scoreTo.x - S.scoreFrom.x) * t;
          B.y = S.scoreFrom.y + (S.scoreTo.y - S.scoreFrom.y) * t;
          B.z = S.scoreFrom.z + (S.scoreTo.z - S.scoreFrom.z) * t;
          B.scale = 1 - t;
        }
        if (S.scoringTimer >= SCORING_TIME) {
          if (S.scoreTo) { B.x = S.scoreTo.x; B.y = S.scoreTo.y; B.z = S.scoreTo.z; B.scale = 0; }
          S.scoreDone = true;
          afterNet(S);
        }
      } else {
        S.respawnTimer += FIXED;
        if (S.respawnTimer >= RESPAWN_TIME) {
          placeBall(S);
          S.phase = 'playing';
          S.scoringTimer = 0; S.respawnTimer = 0; S.scoreDone = false;
          S.scoreFrom = null; S.scoreTo = null;
        }
      }
      return S.events;
    }
    if (S.phase !== 'playing') return S.events;
    const sp = len3d(B.vx, B.vy, B.vz);
    B.rot += (B.vx > 0 ? 1 : -1) * FIXED * sp * 10;
    if (S.inHand) B.xg = false;
    else {
      B.xg = B.y > GRAVITY_ON_Y;
      const north = B.z > 0;
      if (S.possesso === 0) { S.lancio = 0; S.vincoli = 1; }
      else if (S.possesso === 2) { if (north) S.vincoli = 1; else { S.lancio = 2; S.vincoli = 0; } }
      else if (!north) S.vincoli = 1; else { S.lancio = 1; S.vincoli = 0; }
    }
    onKeep(S);
    if (B.y > MAX_Y) B.y = MAX_Y;
    physicsStep(S);
    if (B.y > MAX_Y) B.y = MAX_Y;
    deadBallGuard(S);
    return S.events;
  }

  // ---------------------------------------------------------------- wire formats
  // Compact per-tick snapshot (protocol v2). b keeps the POC index order prefix
  // [x,y,z,…,scale,rot] with velocities inserted after position, plus the drag
  // target + damping so prediction/replay can fast-forward deterministically.
  // Indices: x=0 y=1 z=2 vx=3 vy=4 vz=5 scale=6 rot=7 tx=8 ty=9 tz=10 drag=11.
  function snapshot(S) {
    const B = S.ball;
    return {
      tk: S.tick,
      b: [r2(B.x), r2(B.y), r2(B.z), r2(B.vx), r2(B.vy), r2(B.vz), r2(B.scale), r2(B.rot),
          r2(B.tx), r2(B.ty), r2(B.tz), B.drag],
      h: B.holder, k: B.kin ? 1 : 0, ton: B.trailOn ? 1 : 0,
      p: S.possesso, vc: S.vincoli, lc: S.lancio, ih: S.inHand ? 1 : 0,
      sc: [S.scores[1], S.scores[2]], ph: S.phase, w: S.winner, ac: S.aChi, lr: S.lastReleaser,
      st: r2(S.scoringTimer), rt: r2(S.respawnTimer), rs: S.restTicks,
    };
  }

  // Reset S to an authoritative snapshot (client reconcile / replay start).
  function applySnapshot(S, s) {
    const B = S.ball, b = s.b;
    S.tick = s.tk;
    B.x = b[0]; B.y = b[1]; B.z = b[2];
    B.vx = b[3]; B.vy = b[4]; B.vz = b[5];
    B.scale = b[6]; B.rot = b[7];
    B.tx = b[8]; B.ty = b[9]; B.tz = b[10]; B.drag = b[11];
    B.kin = !!s.k; B.trailOn = !!s.ton; B.holder = s.h;
    B.contacts.clear();
    S.possesso = s.p; S.vincoli = s.vc; S.lancio = s.lc; S.inHand = !!s.ih;
    S.scores[1] = s.sc[0]; S.scores[2] = s.sc[1];
    S.phase = s.ph; S.winner = s.w; S.aChi = s.ac; S.lastReleaser = s.lr;
    S.scoringTimer = s.st; S.respawnTimer = s.rt;
    S.scoreDone = s.st >= SCORING_TIME;
    S.restTicks = s.rs || 0;
    // hold targets are rebuilt: the holder's effective drag target is tx/tz
    // (unclamped pointer positions return via replayed move inputs)
    S.hold[1] = S.hold[2] = null;
    if (B.holder) S.hold[B.holder] = { x: B.tx, z: B.tz };
    S.events.length = 0;
    return S;
  }

  // Full-state serialisation for the `start` message and Node tests.
  function dump(S) {
    const B = S.ball;
    return {
      tick: S.tick, ph: S.phase, sc: S.scores.slice(), w: S.winner,
      p: S.possesso, vc: S.vincoli, lc: S.lancio, ih: S.inHand ? 1 : 0,
      ac: S.aChi, lr: S.lastReleaser, st: S.scoringTimer, rt: S.respawnTimer, sd: S.scoreDone ? 1 : 0,
      rts: S.restTicks,
      sf: S.scoreFrom ? { x: S.scoreFrom.x, y: S.scoreFrom.y, z: S.scoreFrom.z } : null,
      sto: S.scoreTo ? { x: S.scoreTo.x, y: S.scoreTo.y, z: S.scoreTo.z } : null,
      b: [B.x, B.y, B.z, B.vx, B.vy, B.vz, B.scale, B.rot, B.kin ? 1 : 0, B.holder, B.drag,
          B.tx, B.ty, B.tz, B.xg ? 1 : 0, B.trailOn ? 1 : 0, [...B.contacts]],
      hp: S.hoops.map(h => [h.timer, h.inTrig ? 1 : 0]),
      hd: [S.hold[1] ? [S.hold[1].x, S.hold[1].z] : 0, S.hold[2] ? [S.hold[2].x, S.hold[2].z] : 0],
    };
  }

  function load(o) {
    const S = create();
    S.tick = o.tick; S.phase = o.ph; S.scores = o.sc.slice(); S.winner = o.w;
    S.possesso = o.p; S.vincoli = o.vc; S.lancio = o.lc; S.inHand = !!o.ih;
    S.aChi = o.ac; S.lastReleaser = o.lr;
    S.scoringTimer = o.st; S.respawnTimer = o.rt; S.scoreDone = !!o.sd;
    S.restTicks = o.rts || 0;
    S.scoreFrom = o.sf ? { x: o.sf.x, y: o.sf.y, z: o.sf.z } : null;
    S.scoreTo = o.sto ? { x: o.sto.x, y: o.sto.y, z: o.sto.z } : null;
    const B = S.ball, b = o.b;
    B.x = b[0]; B.y = b[1]; B.z = b[2]; B.vx = b[3]; B.vy = b[4]; B.vz = b[5];
    B.scale = b[6]; B.rot = b[7]; B.kin = !!b[8]; B.holder = b[9]; B.drag = b[10];
    B.tx = b[11]; B.ty = b[12]; B.tz = b[13]; B.xg = !!b[14]; B.trailOn = !!b[15];
    B.contacts = new Set(b[16]);
    o.hp.forEach((h, i) => { S.hoops[i].timer = h[0]; S.hoops[i].inTrig = !!h[1]; });
    if (o.hd[0]) S.hold[1] = { x: o.hd[0][0], z: o.hd[0][1] };
    if (o.hd[1]) S.hold[2] = { x: o.hd[1][0], z: o.hd[1][1] };
    return S;
  }

  const Sim = {
    FIXED, SCORE_TO_WIN, DRAG_MAX_DIST, MAX_Y, HOLD_PLANE_Y, SCORING_TIME, RESPAWN_TIME,
    create, step, snapshot, applySnapshot, dump, load, makeHoop,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
