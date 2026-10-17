'use strict';
// Top-down port of the Unity "Basket" minigame — online-only client.
// The authoritative simulation lives in sim.js and runs on the server; this file
// never simulates the world. It renders interpolated snapshots, predicts the ball
// while this client owns it (plan §6), reconciles against server snapshots with
// input replay, and turns server events into sound/particles.
//
// Units are Unity world units; screen x = world x, screen up = world +z. The
// original is a real 3D PhysX scene (sphere ball, tilted cylinder/box hoop
// colliders) seen by an orthographic camera at y=35, so ball state is 3D and only
// drawn from above.

const Sim = window.Sim;
const $ = id => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');

const HALF_W = 6.933;            // MuroEst/MuroOvest x (walls follow the camera edge)
const HALF_L = 15;               // MuroNord/MuroSud z and ortho size
const MAX_INPUTS_PER_TICK = 8;   // must match server.js
const SMOOTH_RATE = 10;          // error-smoothing decay (1/s) — offset halves in ~70 ms
const SNAP_DIST = 2.5;           // corrections above this snap instead of smoothing
const COL = {
  bg: '#1D3E62', red: '#DE8F6E', blue: '#3F7DAC', neutral: '#FFFFFF',
  innerBlue: '#336690', netBlue: '#407DAB', innerRed: '#BF7A5E', netRed: '#DE8F6E',
};
const BOUNCE_NAMES = ['bounce_0', 'bounce_1', 'bounce_2', 'bounce_3', 'bounce_4', 'bounce_5', 'bounce_6'];

// Development latency simulation: ?lat=120&jit=30 (round-trip ms), applied to both
// directions on a monotonic queue so ordering is preserved.
const QS = new URLSearchParams(location.search);
const DEV_LAT = Math.max(0, +QS.get('lat') || 0);
const DEV_JIT = Math.max(0, +QS.get('jit') || 0);

const IMG = {};
const IMG_FILES = { ball: 'PallaBasket_4916.png', base: 'BaseCanestro_4312.png', net: 'ReteCanestro_4336.png', border: 'Bordo_4303.png' };
const SND_FILES = ['grab_a', 'grab_b', 'grab_c', 'net_a', 'net_b', 'cheer', 'rim',
  'bounce_0', 'bounce_1', 'bounce_2', 'bounce_3', 'bounce_4', 'bounce_5', 'bounce_6'];
const SND = {};
let actx = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const r2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- audio
// Sounds are driven purely by server events (see onEvents) so prediction and
// interpolation never double-play anything.
function initAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  SND_FILES.forEach(name => fetch('assets/' + name + '.wav').then(r => r.arrayBuffer())
    .then(buf => actx.decodeAudioData(buf)).then(b => { SND[name] = b; }).catch(() => {}));
}
function play(name, vol = 1, pitchVar = 0.1) {
  if (!actx || !SND[name]) return;
  const src = actx.createBufferSource(), g = actx.createGain();
  src.buffer = SND[name];
  src.playbackRate.value = 1 + rand(-pitchVar, pitchVar);
  g.gain.value = vol;
  src.connect(g); g.connect(actx.destination); src.start();
}
const playAny = (names, vol) => play(names[Math.floor(Math.random() * names.length)], vol);

// ---------------------------------------------------------------- state
// MY = this client's identity/input stream, P = predicted sim state (a Sim state
// object, never the render source of truth), RB = the ball actually drawn.
const NET = { ws: null, connecting: false, pingTimer: null, rtt: 0, offset: null,
  snapLast: 0, jitter: 0, snapCount: 0, snapRate: 0, corrections: 0,
  grabs: 0, grabFar: 0, grabWhy: '', grabSeq: 0, grabSentAt: 0, grant: null };
const MY = { role: 0, seq: 0, token: null };   // role: 1 = p1 (Red/south), 2 = p2 (Blue/north)
let P = null;
const inputs = [];                             // { seq, k, x, z, tick, used } pending input log
let holdPointer = null;                        // pointerId currently dragging the ball
const SNAP = new Snap.SnapshotInterpolation(30);
const smooth = { x: 0, y: 0, z: 0 };           // decaying visual offset (error smoothing)
let wasPredicting = false;
const RB = { x: 0, y: 10, z: -5, scale: 1, rot: 0 };
const UI = { phase: 'menu', scores: [0, 0], possesso: 0, winner: 0, kin: false, trailOn: true };
const G = { hoops: [Sim.makeHoop(1, 2), Sim.makeHoop(-1, 1)], bursts: [], trail: [], time: 0 };

// ---------------------------------------------------------------- networking
const outQ = [], inQ = [];      // dev latency queues
let outAt = 0, inAt = 0;
function rawSend(m) { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(m)); }
function netSend(m) {
  if (!DEV_LAT && !DEV_JIT) return rawSend(m);
  const now = performance.now();
  outAt = Math.max(outAt + 0.5, now + Math.max(0, DEV_LAT + (DEV_JIT ? rand(-DEV_JIT, DEV_JIT) : 0)));
  outQ.push({ at: outAt, m });
}
function netConnect() {
  NET.connecting = true;
  let url;
  if (location.protocol.startsWith('http'))
    url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  else url = 'ws://localhost:8080';   // opened via file:// against a local server
  try { NET.ws = new WebSocket(url); } catch (e) { netFail('Connection failed'); return; }
  NET.ws.onopen = () => { rawSend({ t: 'join', v: 2 }); $('netStatus').textContent = 'Waiting for opponent…'; };
  NET.ws.onmessage = e => {
    if (DEV_LAT || DEV_JIT) {
      const now = performance.now();
      inAt = Math.max(inAt + 0.5, now + Math.max(0, DEV_LAT + (DEV_JIT ? rand(-DEV_JIT, DEV_JIT) : 0)));
      inQ.push({ at: inAt, s: e.data });
    } else {
      try { netMessage(JSON.parse(e.data)); } catch (err) { /* ignore */ }
    }
  };
  NET.ws.onclose = netClosed;
  NET.ws.onerror = () => { /* onclose follows */ };
}
function netFail(msg) {
  NET.connecting = false; menuButtons(false);
  $('netStatus').textContent = msg;
}
function netClosed() {
  NET.ws = null;
  if (MY.role) return netToMenu('Connection lost');
  if (NET.connecting) netFail('Connection failed');
}
function netToMenu(msg) {
  MY.role = 0; MY.token = null; MY.seq = 0;
  P = null; inputs.length = 0; holdPointer = null; hudLast = 0;
  clearInterval(NET.pingTimer); NET.pingTimer = null;
  outQ.length = 0; inQ.length = 0;
  if (NET.ws) { const ws = NET.ws; NET.ws = null; try { ws.close(); } catch (e) { /* ignore */ } }
  UI.phase = 'menu';
  G.trail = []; G.bursts = [];
  $('hud').style.display = 'none'; $('ping').style.display = 'none';
  $('over').classList.add('hidden'); $('menu').classList.remove('hidden');
  $('again').style.display = '';
  menuButtons(false);
  $('netStatus').textContent = msg;
}
function menuButtons(disabled) {
  ['b2o'].forEach(id => { $(id).disabled = disabled; });
}
function netMessage(m) {
  switch (m.t) {
    case 'room': NET.connecting = false; MY.role = m.role === 'p1' ? 1 : 2; break;
    case 'start': startMatch(m); break;
    case 's': if (P) onSnapshot(m); break;
    case 'e': if (P) onEvents(m); break;
    case 'ping': rawSend({ t: 'pong', ts: m.ts, time: Date.now() }); break;
    case 'pong': {
      NET.rtt = Math.max(0, Math.round(performance.now() - m.ts));
      if (typeof m.time === 'number') {   // client-vs-server clock skew (epoch ms)
        const off = m.time + NET.rtt / 2 - Date.now();
        NET.offset = NET.offset === null ? off : NET.offset + (off - NET.offset) * 0.1;
      }
      const el = $('ping');
      el.style.display = 'block'; el.textContent = NET.rtt + ' ms';
      break;
    }
    case 'opp_left': netToMenu('Opponent left'); break;
    case 'ver': netFail('Please refresh — the server was updated'); break;
  }
}
function pingServer() { netSend({ t: 'ping', ts: performance.now() }); }

// ---------------------------------------------------------------- match start
function startMatch(m) {
  MY.token = m.token;
  P = Sim.load(m.S);
  inputs.length = 0; MY.seq = 0; holdPointer = null;
  SNAP.vault.clear();
  smooth.x = smooth.y = smooth.z = 0;
  wasPredicting = false; NET.corrections = 0; hudLast = 0;
  Object.assign(RB, { x: P.ball.x, y: P.ball.y, z: P.ball.z, scale: P.ball.scale, rot: P.ball.rot });
  UI.phase = P.phase; UI.possesso = P.possesso; UI.winner = P.winner;
  UI.kin = P.ball.kin; UI.trailOn = P.ball.trailOn;
  UI.scores[0] = P.scores[1]; UI.scores[1] = P.scores[2];
  G.trail = []; G.bursts = []; G.time = 0; acc = 0;
  $('menu').classList.add('hidden'); $('over').classList.add('hidden');
  $('again').style.display = '';
  $('netStatus').textContent = '';
  $('hud').style.display = 'block';
  clearInterval(NET.pingTimer);
  NET.pingTimer = setInterval(pingServer, 2000);
  pingServer();
}

// ---------------------------------------------------------------- input stream
function sendInput(k, x, z) {
  MY.seq++;
  const e = { seq: MY.seq, k, x: x === undefined ? 0 : r2(x), z: z === undefined ? 0 : r2(z), tick: P.tick, used: false };
  inputs.push(e);
  if (inputs.length > 240) inputs.splice(0, inputs.length - 240);
  if (k === 'g') { NET.grabSeq = e.seq; NET.grabSentAt = performance.now(); }
  netSend({ t: 'i', seq: e.seq, k, x: e.x, z: e.z, token: MY.token });
}

// ---------------------------------------------------------------- prediction
// Predict iff this client owns the ball: my drag, my shot still in flight, or a
// loose ball in my half (plan §6). Otherwise interpolate from snapshots.
function shouldPredict() {
  if (!P || P.phase !== 'playing') return false;
  const B = P.ball;
  if (B.holder === MY.role) return true;
  if (B.holder === 0 && P.lastReleaser === MY.role) return true;
  if (B.holder === 0 && P.lastReleaser === 0 && (MY.role === 1 ? B.z < 0 : B.z > 0)) return true;
  return false;
}

function simTick() {
  const t = P.tick + 1;
  const batch = [];
  for (let i = 0; i < inputs.length && batch.length < MAX_INPUTS_PER_TICK; i++) {
    const e = inputs[i];
    if (!e.used && e.tick <= t) { e.used = true; batch.push(e); }
  }
  Sim.step(P, batch);
  P.events.length = 0;   // prediction is effect-free — server events own audio/particles
}

function onSnapshot(m) {
  const now = performance.now();
  if (NET.snapLast) {
    const d = Math.abs((now - NET.snapLast) - 33.33);   // deviation from 30 Hz
    NET.jitter += (d - NET.jitter) * 0.1;
  }
  NET.snapLast = now; NET.snapCount++;
  SNAP.snapshot.add({ id: 'ball', time: m.tm,
    state: [{ id: 'ball', x: m.b[0], y: m.b[1], z: m.b[2], scale: m.b[6], rot: m.b[7] }] });
  applyUIState(m);
  reconcile(m);
}

function applyUIState(m) {
  const prev = UI.phase;
  UI.possesso = m.p; UI.kin = !!m.k; UI.trailOn = !!m.ton;
  UI.scores[0] = m.sc[0]; UI.scores[1] = m.sc[1];
  UI.winner = m.w; UI.phase = m.ph;
  if (m.ph === 'over' && prev !== 'over') {
    $('overTitle').textContent = m.w === 1 ? 'Red wins!' : 'Blue wins!';
    setTimeout(() => { if (UI.phase === 'over') $('over').classList.remove('hidden'); }, 600);
  } else if (m.ph === 'playing' && prev !== 'playing') {
    $('over').classList.add('hidden');   // covers an opponent restart too
  }
}

// Reconciliation (plan §6): drop acknowledged inputs, reset P to authority,
// replay what the server has not seen yet, then fold any error into `smooth`.
function reconcile(m) {
  const A = (m.a && m.a[MY.role - 1]) || 0;
  const pre = { x: P.ball.x, y: P.ball.y, z: P.ball.z };
  const Tc = P.tick;
  for (let i = inputs.length - 1; i >= 0; i--) if (inputs[i].seq <= A) inputs.splice(i, 1);
  Sim.applySnapshot(P, m);
  for (const e of inputs) { e.used = false; if (e.tick <= m.tk) e.tick = m.tk + 1; }
  inputs.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  let idx = 0;
  for (let t = m.tk + 1; t <= Tc; t++) {
    const batch = [];
    while (idx < inputs.length && inputs[idx].tick <= t && batch.length < MAX_INPUTS_PER_TICK) {
      inputs[idx].used = true; batch.push(inputs[idx]); idx++;
    }
    if (batch.length) Sim.step(P, batch);
  }
  P.events.length = 0;
  if (shouldPredict()) {
    smooth.x += pre.x - P.ball.x; smooth.y += pre.y - P.ball.y; smooth.z += pre.z - P.ball.z;
    if (Math.sqrt(smooth.x * smooth.x + smooth.y * smooth.y + smooth.z * smooth.z) > SNAP_DIST) {
      smooth.x = smooth.y = smooth.z = 0; NET.corrections++;
    }
  }
  // the ack tells us the server's verdict on the last grab we sent
  if (NET.grabSeq && A >= NET.grabSeq) { NET.grant = P.ball.holder === MY.role; NET.grabSeq = 0; }
  // server did not grant (or already dropped) my grab — stop streaming moves
  if (holdPointer !== null && P.ball.holder !== MY.role) holdPointer = null;
}

// ---------------------------------------------------------------- server events
function onEvents(m) {
  for (let i = 0; i < m.evs.length; i++) {
    const ev = m.evs[i];
    switch (ev.ev) {
      case 'grab': playAny(['grab_a', 'grab_b', 'grab_c'], 1); break;
      case 'rim': play('rim', 1, 0.1); burst(ev.x, ev.z, 6, '#ffffff'); break;
      case 'bounce': playAny(BOUNCE_NAMES, clamp(0.5 + ev.impact / 80, 0.5, 1)); break;
      case 'scored': playAny(['net_a', 'net_b'], 1); break;
      case 'cheer': play('cheer', 1, 0); break;
      case 'respawn': burst(ev.x, ev.z, 10, '#ffffff'); break;
    }
  }
}
function burst(x, z, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(3, 9);
    G.bursts.push({ x, z, vx: Math.cos(a) * s, vz: Math.sin(a) * s, t: 0, life: rand(0.25, 0.5), color, r: rand(0.12, 0.28) });
  }
}

// ---------------------------------------------------------------- input (Touchable + Draggable)
function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
  const flip = MY.role === 2;   // invert the rotated view for p2
  return [(flip ? 0.5 - nx : nx - 0.5) * HALF_W * 2, (flip ? ny - 0.5 : 0.5 - ny) * HALF_L * 2];
}
// Client-side pre-check. The server is the authority: this only decides whether
// the touch is *near the ball* — the full rule set is deliberately NOT applied
// here, so a stale/blind predicted state can never silently swallow a grab that
// the server would have accepted. grabBlockReason() just reports what the client
// believes, for the debug overlay.
function grabBlockReason(x, z) {
  if (!P) return 'no-state';
  if (P.phase !== 'playing') return 'phase=' + P.phase;
  const B = P.ball;
  if (B.kin) return 'kin';
  if (B.holder !== 0) return 'holder=' + B.holder;
  if (P.vincoli <= 0) return 'vincoli=0';
  if (MY.role === 1 ? B.z > 0 : B.z < 0) return 'wrong-half';
  return Math.hypot(x - B.x, z - B.z) < Sim.DRAG_MAX_DIST ? null : 'far';
}
canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (!P) return;
  const [x, z] = toWorld(e);
  const near = Math.hypot(x - P.ball.x, z - P.ball.z) < Sim.DRAG_MAX_DIST;
  if (near) {
    NET.grabs++;
    NET.grabWhy = grabBlockReason(x, z) || 'ok';
    holdPointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    sendInput('g', x, z);            // let the server decide
  } else {
    NET.grabFar++;
    NET.grabWhy = 'far=' + Math.hypot(x - P.ball.x, z - P.ball.z).toFixed(1);
  }
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  if (holdPointer !== e.pointerId) return;
  const [x, z] = toWorld(e);
  sendInput('m', x, z);
});
function pointerEnd(e) {
  if (holdPointer !== e.pointerId) return;
  holdPointer = null;
  sendInput('r');
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

// ---------------------------------------------------------------- per-frame update
// The sim runs at a fixed tick; prediction ticks while the render runs free.
function updateRenderBall(dt) {
  const predicting = shouldPredict();
  let tx, ty, tz, sc, ro;
  if (predicting) {
    tx = P.ball.x; ty = P.ball.y; tz = P.ball.z; sc = P.ball.scale; ro = P.ball.rot;
  } else {
    const it = SNAP.calcInterpolation('x y z scale rot(deg)');
    if (it) { tx = it.state[0].x; ty = it.state[0].y; tz = it.state[0].z; sc = it.state[0].scale; ro = it.state[0].rot; }
    else { tx = RB.x; ty = RB.y; tz = RB.z; sc = RB.scale; ro = RB.rot; }
  }
  // ease the jump when prediction and interpolation hand over (and on corrections)
  if (predicting !== wasPredicting) {
    smooth.x += RB.x - tx; smooth.y += RB.y - ty; smooth.z += RB.z - tz;
    if (Math.sqrt(smooth.x * smooth.x + smooth.y * smooth.y + smooth.z * smooth.z) > SNAP_DIST)
      smooth.x = smooth.y = smooth.z = 0;
  }
  wasPredicting = predicting;
  const dec = Math.exp(-dt * SMOOTH_RATE);
  smooth.x *= dec; smooth.y *= dec; smooth.z *= dec;
  RB.x = tx + smooth.x; RB.y = ty + smooth.y; RB.z = tz + smooth.z;
  RB.scale = sc; RB.rot = ro;
}
function updateTrail() {
  if (UI.phase === 'playing' && UI.trailOn && !UI.kin) G.trail.push({ x: RB.x, z: RB.z, t: G.time });
  while (G.trail.length && G.time - G.trail[0].t > 0.15) G.trail.shift();
}
let hudLast = 0;
// Snapshot rate must be measured against wall-clock time, not the frame dt:
// a backgrounded/throttled tab caps dt but snapshots keep arriving, which would
// report a nonsense rate when it resumes.
function updateHud() {
  const now = performance.now();
  if (!hudLast) { hudLast = now; return; }
  const span = (now - hudLast) / 1000;
  if (span < 0.25) return;
  NET.snapRate = Math.round(NET.snapCount / span);
  NET.snapCount = 0; hudLast = now;
  $('hud').textContent = 'rtt ' + NET.rtt + 'ms · snap ' + NET.snapRate + '/s · jit ' +
    Math.round(NET.jitter) + 'ms · corr ' + NET.corrections + (DEV_LAT || DEV_JIT ? ' · LAT SIM' : '');
}

// ---------------------------------------------------------------- debug overlay
// ?debug=1 (or press D) shows the whole net + state picture, so a stall can be
// diagnosed from the screen rather than reproduced in code.
let dbgOn = false;
function setDbg(on) {
  dbgOn = on;
  const el = $('dbg');
  el.style.display = on ? 'block' : 'none';
  if (!on) el.textContent = '';
}
addEventListener('keydown', e => { if (e.key === 'd' || e.key === 'D') setDbg(!dbgOn); });
let dbgAcc = 0;
function updateDebug(dt) {
  if (!dbgOn) return;
  const el = $('dbg');
  dbgAcc += dt;
  if (dbgAcc < 0.1) return;
  dbgAcc = 0;
  const now = performance.now();
  const age = NET.snapLast ? Math.round(now - NET.snapLast) : -1;
  const B = P && P.ball;
  const mode = !P ? 'no-state' : (shouldPredict() ? 'PREDICT' : (SNAP.vault.size ? 'INTERP' : 'NODATA'));
  const speed = B ? Math.sqrt(B.vx * B.vx + B.vy * B.vy + B.vz * B.vz) : 0;
  // the dead-ball signature: nobody may touch it and it is not moving
  const dead = !!B && P.phase === 'playing' && P.vincoli <= 0 && B.holder === 0 && !B.kin && speed < 0.5;
  const L = [];
  L.push(`p${MY.role || '-'} ph ${UI.phase}${P && P.phase !== UI.phase ? ' (S:' + P.phase + ')' : ''}  ` +
    `ws ${NET.ws ? (NET.ws.readyState === 1 ? 'open' : 'state' + NET.ws.readyState) : 'none'}  ` +
    `snap ${NET.snapRate}/s  last ${age < 0 ? '-' : age + 'ms'}${age > 250 ? '  STALE!' : ''}  ` +
    `vault ${SNAP.vault.size}  ${mode}`);
  L.push(`rtt ${NET.rtt}ms  jit ${Math.round(NET.jitter)}ms  corr ${NET.corrections}  ` +
    `clkoff ${NET.offset === null ? '-' : Math.round(NET.offset)}ms`);  if (B) {
    L.push(`S ball ${B.x.toFixed(2)},${B.y.toFixed(2)},${B.z.toFixed(2)}  ` +
      `v ${B.vx.toFixed(2)},${B.vy.toFixed(2)},${B.vz.toFixed(2)} |${speed.toFixed(2)}|`);
    L.push(`  h${B.holder} poss${P.possesso} vinc${P.vincoli} lanc${P.lancio} kin${B.kin ? 1 : 0} ` +
      `ih${P.inHand ? 1 : 0} lr${P.lastReleaser} xg${B.xg ? 1 : 0} rest${P.restTicks} tick${P.tick}`);
  }
  L.push(`RB ${RB.x.toFixed(2)},${RB.y.toFixed(2)},${RB.z.toFixed(2)}  ptr ${holdPointer === null ? '-' : 'held'}  ` +
    `grabs ${NET.grabs} far ${NET.grabFar} why ${NET.grabWhy || '-'}` +
    (NET.grabSeq ? `  GRAB IN FLIGHT ${Math.round(now - NET.grabSentAt)}ms`
      : (NET.grant === null ? '' : `  last grab ${NET.grant ? 'GRANTED' : 'REJECTED'}`)));
  if (dead) L.push('*** DEAD BALL: vincoli 0, at rest, nobody may grab ***');
  el.textContent = L.join('\n');
}
function flushDevQueues() {
  if (!DEV_LAT && !DEV_JIT) return;
  const now = performance.now();
  while (outQ.length && outQ[0].at <= now) rawSend(outQ.shift().m);
  while (inQ.length && inQ[0].at <= now) {
    const p = inQ.shift();
    try { netMessage(JSON.parse(p.s)); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- rendering
let W = 1, H = 1, S = 1;
function resize() {
  const aspect = (HALF_W * 2) / (HALF_L * 2);
  let cw = innerWidth, ch = Math.round(cw / aspect);
  if (ch > innerHeight) { ch = innerHeight; cw = Math.round(ch * aspect); }
  const dpr = Math.min(devicePixelRatio || 1, 2);
  $('stage').style.width = cw + 'px'; $('stage').style.height = ch + 'px';
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  W = canvas.width; H = canvas.height; S = H / (HALF_L * 2);
}

// Subtle top-down perspective: the ball grows as it rises toward the camera (up to +35% at MAX_Y)
const ballScale = () => RB.scale * (1 + 0.35 * clamp(RB.y / Sim.MAX_Y, 0, 1));
const tintCache = new Map();
function tinted(img, color) {
  const key = img.src + color;
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(img, 0, 0);
  tintCache.set(key, c);
  return c;
}
// Sprite drawn with image-up = +z, pivot given from the bottom-left like Unity.
function sprite(img, x, z, w, h, px, py, color, rot = 0, alpha = 1) {
  if (!img) return;
  ctx.save(); ctx.translate(x, z); if (rot) ctx.rotate(rot); ctx.scale(1, -1);
  ctx.globalAlpha = alpha;
  ctx.drawImage(color ? tinted(img, color) : img, -px * w, -(1 - py) * h, w, h);
  ctx.restore();
}
function circle(x, z, r, color, alpha = 1) {
  ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, z, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
}
function slice9(img, x, z, w, h, corner, color) {
  if (!img) return;
  const src = tinted(img, color), n = img.width, b = 50, s = n - 2 * b;
  const xs = [-w / 2, -w / 2 + corner, w / 2 - corner, w / 2], zs = [-h / 2, -h / 2 + corner, h / 2 - corner, h / 2];
  const sx = [0, b, b + s, n];
  ctx.save(); ctx.translate(x, z); ctx.scale(1, -1);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    ctx.drawImage(src, sx[i], sx[j], sx[i + 1] - sx[i], sx[j + 1] - sx[j], xs[i], -zs[j + 1], xs[i + 1] - xs[i], zs[j + 1] - zs[j]);
  ctx.restore();
}

function drawHoop(h) {
  const blue = h.player === 2;
  ctx.save(); ctx.translate(0, h.hz); if (h.s < 0) ctx.rotate(Math.PI);
  slice9(IMG.border, 0, 4.5, 5.04, 3.2, 0.63, '#000000');
  ctx.fillStyle = '#fff'; ctx.fillRect(-2.016, 4.5 - 1.008, 4.032, 2.016);
  sprite(IMG.net, 0, 2.964, 3.536, 2.652, 0.5, 1, blue ? COL.netBlue : COL.netRed);
  circle(0, 3, 1.77, '#000'); circle(0, 3, 1.18, blue ? COL.innerBlue : COL.innerRed);
  ctx.restore();
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
  // p2's view is rotated 180 deg so their half sits at the bottom
  const flip = MY.role === 2;
  ctx.setTransform(flip ? -S : S, 0, 0, flip ? S : -S, W / 2, H / 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(-24, -0.32, 48, 0.64);
  circle(0, 0, 0.768, '#fff');
  ctx.fillRect(-24, 14.7 - 0.32, 48, 0.64); ctx.fillRect(-24, -14.7 - 0.32, 48, 0.64);
  ctx.fillRect(-6.703 - 0.32, -24, 0.64, 48); ctx.fillRect(6.703 - 0.32, -24, 0.64, 48);

  // PosizionaOmbra: shadow is pushed 0.5 units toward the field centre, fading in over the last 2 units
  let sx = RB.x, sz = RB.z;
  const dc = Math.hypot(RB.x, RB.z);
  if (dc > 1e-5) { const k = 0.5 * Math.min(dc / 2, 1) / dc; sx -= RB.x * k; sz -= RB.z * k; }
  circle(sx, sz, 1.536, '#000', 0.31);

  G.hoops.forEach(drawHoop);

  const pc = UI.possesso === 1 ? COL.red : UI.possesso === 2 ? COL.blue : COL.neutral;
  const tw = UI.possesso === 0 ? 2.35 : 3;
  const tr = G.trail;
  if (tr.length > 1) {
    ctx.fillStyle = pc;
    for (let i = 1; i < tr.length; i++) {
      const age = (G.time - tr[i].t) / 0.15, w = tw * (1 - clamp(age, 0, 1)) * 0.5;
      if (w <= 0.01) continue;
      ctx.beginPath(); ctx.arc(tr[i].x, tr[i].z, w, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (UI.possesso !== 0 && RB.scale > 0.01) circle(RB.x, RB.z, 1.536 * ballScale(), pc);
  if (RB.scale > 0.01) sprite(IMG.ball, RB.x, RB.z, 2.56 * ballScale(), 2.56 * ballScale(), 0.5, 0.5, null, -RB.rot * Math.PI / 180);

  G.bursts.forEach(p => circle(p.x, p.z, p.r, p.color, 1 - p.t / p.life));

  drawScore(UI.scores[1], COL.blue, 1.3); drawScore(UI.scores[0], COL.red, -1.3);
}
function drawScore(v, color, z) {
  const flip = MY.role === 2;
  // mirrored position + 180 deg rotation keeps the numbers upright on p2's rotated view
  ctx.save(); ctx.translate(flip ? HALF_W - 0.9 : -HALF_W + 0.9, z); if (flip) ctx.rotate(Math.PI); ctx.scale(1, -1);
  ctx.font = 'bold 1.6px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.18; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(v, 0, 0);
  ctx.fillStyle = color; ctx.fillText(v, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------- frame loop
let last = 0, acc = 0;
function frame(ts) {
  const dt = Math.min((ts - last) / 1000 || 0, 0.05); last = ts;
  G.time += dt;
  flushDevQueues();
  if (P) {
    acc = Math.min(acc + dt, 0.2);
    while (acc >= Sim.FIXED) { acc -= Sim.FIXED; simTick(); }
    updateRenderBall(dt);
    updateTrail();
    updateHud();
  }
  updateDebug(dt);
  G.bursts = G.bursts.filter(p => { p.t += dt; p.x += p.vx * dt; p.z += p.vz * dt; return p.t < p.life; });
  render();
  requestAnimationFrame(frame);
}

$('b2o').onclick = () => { initAudio(); menuButtons(true); $('netStatus').textContent = 'Connecting…'; netConnect(); };
$('again').onclick = () => netSend({ t: 'again' });
$('toMenu').onclick = () => netToMenu('');
if (QS.get('debug') === '1') setDbg(true);
addEventListener('resize', resize);
resize();
Promise.all(Object.entries(IMG_FILES).map(([k, f]) => new Promise(res => {
  const im = new Image(); im.onload = () => { IMG[k] = im; res(); }; im.onerror = res; im.src = 'assets/' + f;
}))).then(() => requestAnimationFrame(frame));

window.__bb = { NET, MY, UI, G, RB, get P() { return P; }, Sim };
