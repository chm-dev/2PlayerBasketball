'use strict';
// Top-down port of the Unity "Basket" minigame. Units are Unity world units; screen x = world x, screen up = world +z.
// The original is a real 3D PhysX scene (sphere ball, tilted cylinder/box hoop colliders) seen by an orthographic camera
// at y=35, so the ball is simulated in 3D here and only drawn from above.

const $ = id => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');

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
const DIFF_INTERVAL = { easy: [0.1, 0.4], medium: [0.5, 0.75], hard: [0.75, 1] };
const CPU_WAIT = { easy: [1, 2], medium: [0.4, 1], hard: [0.2, 0.5] };
const COL = {
  bg: '#1D3E62', red: '#DE8F6E', blue: '#3F7DAC', neutral: '#FFFFFF',
  baseBlue: '#336690', innerBlue: '#336690', netBlue: '#407DAB',
  baseRed: '#A66B52', innerRed: '#BF7A5E', netRed: '#DE8F6E',
};

const IMG = {};
const IMG_FILES = { ball: 'PallaBasket_4916.png', base: 'BaseCanestro_4312.png', net: 'ReteCanestro_4336.png', border: 'Bordo_4303.png' };
const SND_FILES = ['grab_a', 'grab_b', 'grab_c', 'net_a', 'net_b', 'cheer', 'rim',
  'bounce_0', 'bounce_1', 'bounce_2', 'bounce_3', 'bounce_4', 'bounce_5', 'bounce_6'];
const SND = {};
let actx = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);

// ---------------------------------------------------------------- audio
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

// ---------------------------------------------------------------- hoops (Canestro prefabs)
function makeHoop(s, player) {
  const hz = 8.5 * s, c = Math.cos(Math.PI / 6), sn = 0.5;   // colliders are tilted 30 deg about X
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

// ---------------------------------------------------------------- game state
const G = {
  phase: 'menu', vsCpu: true, setting: 'medium',
  scores: [0, 0, 0],
  possesso: 0, lancio: 0, inHand: false, vincoli: 1, aChi: 0,
  diffValue: 0.5, diffInv: 0.5,
  hoops: [makeHoop(1, 2), makeHoop(-1, 1)],
  cpu: { timer: 0, wait: 0.7, presa: false, touch: false, x: 0, z: 5 },
  tweens: [], bursts: [], delays: [], pointers: {}, winner: 0, time: 0,
  ball: { x: 0, y: 10, z: -5, vx: 0, vy: 0, vz: 0, kin: false, scale: 1, rot: 0, holder: null, xg: false,
    drag: FREE_DRAG, tx: 0, ty: HOLD_PLANE_Y, tz: 0, contacts: new Set(), trail: [], trailOn: true },
};
const B = G.ball;
const ballNorth = () => B.z > 0;

function setPossesso(p) { G.possesso = p; }

function calcDifficulty() {
  const iv = DIFF_INTERVAL[G.setting];
  const ratio = clamp(G.scores[1] - G.scores[2], -5, 5) / 5;
  G.diffValue = iv[0] + (iv[1] - iv[0]) * (ratio + 1) / 2;
  G.diffInv = 1 - G.diffValue;
}

function tween(dur, fn, done) { G.tweens.push({ t: 0, dur, fn, done }); }
function delay(dur, fn) { G.delays.push({ t: dur, fn }); }

function burst(x, z, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(3, 9);
    G.bursts.push({ x, z, vx: Math.cos(a) * s, vz: Math.sin(a) * s, t: 0, life: rand(0.25, 0.5), color, r: rand(0.12, 0.28) });
  }
}

// ---------------------------------------------------------------- match flow
function newGame(vsCpu, setting) {
  initAudio();
  G.vsCpu = vsCpu; G.setting = setting;
  G.scores = [0, 0, 0]; G.winner = 0;
  G.tweens = []; G.delays = []; G.bursts = []; G.pointers = {};
  G.cpu.wait = rand(...CPU_WAIT[setting]);
  G.aChi = 0;
  calcDifficulty();
  placeBall();
  G.phase = 'playing';
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
}

function placeBall() {
  const z = G.aChi === 2 ? 5 : -5;
  Object.assign(B, { x: 0, y: 10, z, vx: 0, vy: 0, vz: 0, kin: false, scale: 1, rot: 0, holder: null, xg: false,
    drag: FREE_DRAG, trail: [], trailOn: true });
  B.contacts.clear();
  G.inHand = false; G.lancio = 0; G.vincoli = 1;
  Object.assign(G.cpu, { timer: 0, presa: false, touch: false });
  G.hoops.forEach(h => { h.inTrig = false; });
  setPossesso(0);
  burst(B.x, B.z, 10, '#ffffff');
}

function pallaPresa() {
  setPossesso(B.z > 0 ? 2 : 1);
  G.inHand = true;
  playAny(['grab_a', 'grab_b', 'grab_c'], 1);
}

function grab(id) {
  B.holder = id; B.drag = HELD_DRAG;
  B.tx = B.x; B.ty = HOLD_PLANE_Y; B.tz = B.z;
  pallaPresa();
}

function releaseBall() {
  B.holder = null; B.drag = FREE_DRAG;
  G.inHand = false;
  B.vy = THROW_UP;   // LanciaPalla
}

function groundTouch() {
  if (G.lancio === 2) { if (ballNorth()) return; }
  else if (G.lancio === 1) { if (!ballNorth()) return; }
  else return;
  G.lancio = 0; setPossesso(0);
}

function hoopScored(h) {
  if (h.timer > 0 || G.phase !== 'playing') return;
  h.timer = 1;
  B.kin = true; B.vx = B.vy = B.vz = 0;
  if (B.holder !== null) { B.holder = null; B.drag = FREE_DRAG; G.inHand = false; }
  G.phase = 'scoring';
  playAny(['net_a', 'net_b'], 1);
  const from = { x: B.x, y: B.y, z: B.z };
  const to = { x: 0, y: 0, z: h.hz + h.s * 2 };   // EntrataPalla
  tween(0.5, t => {
    B.x = from.x + (to.x - from.x) * t; B.y = from.y + (to.y - from.y) * t;
    B.z = from.z + (to.z - from.z) * t; B.scale = 1 - t;
  }, afterNet);
  G.aChi = h.player;                               // the conceding side gets the ball
  G.scores[h.player === 1 ? 2 : 1]++;
}

function afterNet() {
  calcDifficulty();
  play('cheer', 1, 0);
  B.trail = []; B.trailOn = false;
  if (G.scores[2] >= SCORE_TO_WIN) return finish(2);
  if (G.scores[1] >= SCORE_TO_WIN) return finish(1);
  delay(1.0, () => { placeBall(); G.phase = 'playing'; });
}

function finish(winner) {
  G.winner = winner; G.phase = 'over';
  $('overTitle').textContent = G.vsCpu ? (winner === 1 ? 'You win!' : 'You lose!') : (winner === 1 ? 'Red wins!' : 'Blue wins!');
  setTimeout(() => $('over').classList.remove('hidden'), 600);
}

// ---------------------------------------------------------------- input (Touchable + Draggable)
function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width - 0.5) * HALF_W * 2, (0.5 - (e.clientY - r.top) / r.height) * HALF_L * 2];
}
function canPress() {
  return G.phase === 'playing' && !B.kin && B.holder === null && G.vincoli > 0 && !(G.vsCpu && ballNorth());
}
canvas.addEventListener('pointerdown', e => {
  initAudio();
  const [x, z] = toWorld(e);
  G.pointers[e.pointerId] = { x, z };
  if (canPress() && Math.hypot(x - B.x, z - B.z) < 4) {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    grab(e.pointerId);
  }
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  const p = G.pointers[e.pointerId];
  if (p) { const [x, z] = toWorld(e); p.x = x; p.z = z; }
});
function pointerEnd(e) {
  delete G.pointers[e.pointerId];
  if (B.holder === e.pointerId) releaseBall();
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

function planeActive(x, z) {   // TriggerRosso covers z<0, TriggerBlu z>0; the opponent's plane is off while a side owns the ball
  if (Math.abs(x) > 25 || Math.abs(z) > 25) return false;
  return z < 0 ? G.possesso !== 2 : z > 0 ? G.possesso !== 1 : true;
}
function onKeep() {
  if (B.holder === null) return;
  const f = B.holder === 'cpu' ? G.cpu : G.pointers[B.holder];
  if (!f || !planeActive(f.x, f.z)) return;
  let dx = f.x - B.x, dz = f.z - B.z;
  const d = Math.hypot(dx, dz);
  if (d > DRAG_MAX_DIST) { dx *= DRAG_MAX_DIST / d; dz *= DRAG_MAX_DIST / d; }
  B.tx = B.x + dx; B.tz = B.z + dz; B.ty = HOLD_PLANE_Y;
}

// ---------------------------------------------------------------- CPU_Basket
function cpuUpdate(dt) {
  const c = G.cpu;
  if (!G.vsCpu || c.touch) return;
  if (!B.kin && ballNorth() && (G.possesso === 0 || (G.possesso === 2 && !c.presa))) {
    if (c.timer < c.wait) { c.timer += dt; return; }
    c.x = B.x; c.z = B.z; c.presa = true; c.timer = 0; c.touch = true;
    if (B.holder === null && G.vincoli > 0) grab('cpu');
    const sx = c.x, sz = c.z, ex = rand(-5, 5), ez = 5;
    tween(1.0, t => { c.x = sx + (ex - sx) * t; c.z = sz + (ez - sz) * t; }, cpuThrow);
    return;
  }
  c.timer = 0;
}
function cpuThrow() {
  const c = G.cpu;
  c.touch = false;
  if (B.holder === 'cpu') releaseBall();
  c.presa = false;
  const inv = G.diffInv;
  const tx = rand(-6, 6) * inv, tz = -8.5;
  let dx = tx - c.x, dz = tz - c.z;
  const l = Math.hypot(dx, dz) || 1;
  const s = rand(-8, 8) * inv + 27;
  B.vx = dx / l * s; B.vz = dz / l * s; B.vy = THROW_UP;
}

// ---------------------------------------------------------------- physics
function cylContact(c, Bp, ax, h, Rr) {
  const d = [c[0] - Bp[0], c[1] - Bp[1], c[2] - Bp[2]];
  const a = dot(d, ax);
  const rad = [d[0] - a * ax[0], d[1] - a * ax[1], d[2] - a * ax[2]];
  const rho = len(rad);
  const radN = rho > 1e-9 ? [rad[0] / rho, rad[1] / rho, rad[2] / rho] : [0, 1, 0];
  if (a < 0 || a > h || rho > Rr) {
    const a2 = clamp(a, 0, h), r2 = Math.min(rho, Rr);
    const q = [Bp[0] + ax[0] * a2 + radN[0] * r2, Bp[1] + ax[1] * a2 + radN[1] * r2, Bp[2] + ax[2] * a2 + radN[2] * r2];
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
  return { n: ax[bi].map(v => v * bs), pen: BALL_R + bd };
}

let stepContacts = null;
function response(key, n, pen, e) {
  B.x += n[0] * pen; B.y += n[1] * pen; B.z += n[2] * pen;
  const vn = B.vx * n[0] + B.vy * n[1] + B.vz * n[2];
  let impact = 0;
  if (vn < 0) {
    impact = -vn;
    const k = impact > BOUNCE_THRESHOLD ? 1 + e : 1;
    B.vx -= k * vn * n[0]; B.vy -= k * vn * n[1]; B.vz -= k * vn * n[2];
  }
  const prev = stepContacts.get(key);
  if (!prev || impact > prev) stepContacts.set(key, impact);
}

function collide() {
  for (let pass = 0; pass < 2; pass++) {
    if (B.y < BALL_R) response('floor', [0, 1, 0], BALL_R - B.y, 0.9);
    if (B.x > HALF_W - BALL_R) response('wallE', [-1, 0, 0], B.x - (HALF_W - BALL_R), 0.9);
    if (B.x < -HALF_W + BALL_R) response('wallW', [1, 0, 0], -HALF_W + BALL_R - B.x, 0.9);
    if (B.z > HALF_L - BALL_R) response('wallN', [0, 0, -1], B.z - (HALF_L - BALL_R), 0.9);
    if (B.z < -HALF_L + BALL_R) response('wallS', [0, 0, 1], -HALF_L + BALL_R - B.z, 0.9);
    const c = [B.x, B.y, B.z];
    G.hoops.forEach((h, i) => {
      let r = cylContact(c, h.base.B, h.ey, h.base.h, h.base.R);
      if (r) response('base' + i, r.n, r.pen, 0);
      r = cylContact([B.x, B.y, B.z], h.rim.B, h.ey, h.rim.h, h.rim.R);
      if (r) response('rim' + i, r.n, r.pen, 0.4);
      r = boxContact([B.x, B.y, B.z], h.board.C, h);
      if (r) response('board' + i, r.n, r.pen, 0.4);
    });
  }
}

function physicsStep(dt) {
  if (B.kin) return;
  B.vy += (GRAVITY + (B.xg ? EXTRA_GRAVITY : 0)) * dt;
  if (B.holder !== null) {
    B.vx += DRAG_POWER * (B.tx - B.x) * dt;
    B.vy += DRAG_POWER * (B.ty - B.y) * dt;
    B.vz += DRAG_POWER * (B.tz - B.z) * dt;
  }
  const f = Math.max(0, 1 - B.drag * dt);
  B.vx *= f; B.vy *= f; B.vz *= f;
  const hs = Math.hypot(B.vx, B.vz);
  if (hs > MAX_H_SPEED) { B.vx *= MAX_H_SPEED / hs; B.vz *= MAX_H_SPEED / hs; }
  B.x += B.vx * dt; B.y += B.vy * dt; B.z += B.vz * dt;
  stepContacts = new Map();
  collide();
  stepContacts.forEach((impact, key) => {
    if (B.contacts.has(key)) return;
    if (impact > 2) {
      if (key.startsWith('rim')) { play('rim', 1, 0.1); burst(B.x, B.z, 6, '#ffffff'); }
      else playAny(['bounce_0', 'bounce_1', 'bounce_2', 'bounce_3', 'bounce_4', 'bounce_5', 'bounce_6'], clamp(0.5 + impact / 80, 0.5, 1));
    }
    if (key === 'floor') groundTouch();
  });
  B.contacts = new Set(stepContacts.keys());
  G.hoops.forEach(h => {
    const inside = Math.hypot(B.x - h.trig[0], B.y - h.trig[1], B.z - h.trig[2]) < TRIGGER_R;
    if (inside && !h.inTrig) hoopScored(h);
    h.inTrig = inside;
  });
}

// ---------------------------------------------------------------- per-frame update (ControllerBasket.Update)
function update(dt) {
  G.time += dt;
  for (let i = G.delays.length - 1; i >= 0; i--) {
    const d = G.delays[i]; d.t -= dt;
    if (d.t <= 0) { G.delays.splice(i, 1); d.fn(); }
  }
  for (let i = G.tweens.length - 1; i >= 0; i--) {
    const t = G.tweens[i]; t.t += dt;
    const k = Math.min(1, t.t / t.dur); t.fn(k);
    if (k >= 1) { G.tweens.splice(i, 1); if (t.done) t.done(); }
  }
  G.bursts = G.bursts.filter(p => { p.t += dt; p.x += p.vx * dt; p.z += p.vz * dt; return p.t < p.life; });
  if (G.phase !== 'playing' && G.phase !== 'scoring') return;
  G.hoops.forEach(h => { if (h.timer > 0) h.timer -= dt; });
  if (G.phase !== 'playing') return;

  const sp = Math.hypot(B.vx, B.vy, B.vz);
  B.rot += (B.vx > 0 ? 1 : -1) * dt * sp * 10;
  if (G.inHand) B.xg = false;
  else {
    B.xg = B.y > GRAVITY_ON_Y;
    const north = ballNorth();
    if (G.possesso === 0) { G.lancio = 0; G.vincoli = 1; }
    else if (G.possesso === 2) { if (north) G.vincoli = 1; else { G.lancio = 2; G.vincoli = 0; } }
    else if (!north) G.vincoli = 1; else { G.lancio = 1; G.vincoli = 0; }
  }
  cpuUpdate(dt);
  onKeep();
  if (B.y > MAX_Y) B.y = MAX_Y;
  acc += dt;
  while (acc >= FIXED && G.phase === 'playing') { physicsStep(FIXED); acc -= FIXED; }
  if (B.y > MAX_Y) B.y = MAX_Y;

  if (B.trailOn && !B.kin) {
    B.trail.push({ x: B.x, z: B.z, t: G.time });
  }
  while (B.trail.length && G.time - B.trail[0].t > 0.15) B.trail.shift();
}
let acc = 0;

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
  ctx.setTransform(S, 0, 0, -S, W / 2, H / 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(-24, -0.32, 48, 0.64);
  circle(0, 0, 0.768, '#fff');
  ctx.fillRect(-24, 14.7 - 0.32, 48, 0.64); ctx.fillRect(-24, -14.7 - 0.32, 48, 0.64);
  ctx.fillRect(-6.703 - 0.32, -24, 0.64, 48); ctx.fillRect(6.703 - 0.32, -24, 0.64, 48);

  // PosizionaOmbra: shadow is pushed 0.5 units toward the field centre, fading in over the last 2 units
  let sx = B.x, sz = B.z;
  const dc = Math.hypot(B.x, B.z);
  if (dc > 1e-5) { const k = 0.5 * Math.min(dc / 2, 1) / dc; sx -= B.x * k; sz -= B.z * k; }
  circle(sx, sz, 1.536, '#000', 0.31);

  G.hoops.forEach(drawHoop);

  const pc = G.possesso === 1 ? COL.red : G.possesso === 2 ? COL.blue : COL.neutral;
  const tw = G.possesso === 0 ? 2.35 : 3;
  const tr = B.trail;
  if (tr.length > 1) {
    ctx.fillStyle = pc;
    for (let i = 1; i < tr.length; i++) {
      const age = (G.time - tr[i].t) / 0.15, w = tw * (1 - clamp(age, 0, 1)) * 0.5;
      if (w <= 0.01) continue;
      ctx.beginPath(); ctx.arc(tr[i].x, tr[i].z, w, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (G.possesso !== 0 && B.scale > 0.01) circle(B.x, B.z, 1.536 * B.scale, pc);
  if (B.scale > 0.01) sprite(IMG.ball, B.x, B.z, 2.56 * B.scale, 2.56 * B.scale, 0.5, 0.5, null, -B.rot * Math.PI / 180);

  G.bursts.forEach(p => circle(p.x, p.z, p.r, p.color, 1 - p.t / p.life));

  drawScore(G.scores[2], COL.blue, 1.3); drawScore(G.scores[1], COL.red, -1.3);
}
function drawScore(v, color, z) {
  ctx.save(); ctx.translate(-HALF_W + 0.9, z); ctx.scale(1, -1);
  ctx.font = 'bold 1.6px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 0.18; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(v, 0, 0);
  ctx.fillStyle = color; ctx.fillText(v, 0, 0);
  ctx.restore();
}

let last = 0;
function frame(ts) {
  const dt = Math.min((ts - last) / 1000 || 0, 0.05); last = ts;
  update(dt); render();
  requestAnimationFrame(frame);
}

$('b1e').onclick = () => newGame(true, 'easy');
$('b1m').onclick = () => newGame(true, 'medium');
$('b1h').onclick = () => newGame(true, 'hard');
$('b2').onclick = () => newGame(false, 'medium');
$('again').onclick = () => newGame(G.vsCpu, G.setting);
$('toMenu').onclick = () => { G.phase = 'menu'; $('over').classList.add('hidden'); $('menu').classList.remove('hidden'); };
addEventListener('resize', resize);
resize();
Promise.all(Object.entries(IMG_FILES).map(([k, f]) => new Promise(res => {
  const im = new Image(); im.onload = () => { IMG[k] = im; res(); }; im.onerror = res; im.src = 'assets/' + f;
}))).then(() => requestAnimationFrame(frame));

window.__bb = { G, B, update, physicsStep, placeBall, newGame, grab, releaseBall };
