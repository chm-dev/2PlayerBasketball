# Netcode plan — server-authoritative online multiplayer

Status: proposed, not yet implemented.
First pass scope: Phases 0–2 (sim extraction + server authority → interpolation → prediction/reconciliation).
Decisions locked in with the user (2026-10-16):

* **Authority model: server-authoritative.** The simulation moves off the client host into `server.js` (via a shared `sim.js`). Neither browser simulates the world.
* **First pass: Phases 0–2.** Robustness/reconnect/lag-comp (Phase 3+) comes later.

---

## 1. Why (current POC problems)

The existing host-authoritative relay (see `AGENTS.md`, `game.js` lines 59–186) is architecturally fine but feels wrong:

1. **Guest input has ~1 RTT of lag.** touch → server → host applies → snapshot → server → guest renders. Dragging at 80–150 ms feels broken.
2. **Guest has no interpolation.** `applySnapshot()` writes straight into `B` whenever packets arrive (~30 Hz + jitter) → stutter/snapping.
3. **No timing metadata.** No tick / seq / ack / timestamps → can't interpolate, reconcile, or detect staleness.
4. **Render loop ≈ sim loop.** `frame()` mixes sim, snapshot send, audio side effects, drawing. Prediction needs runnable-in-isolation physics.
5. **Host advantage** — the host's own input is applied locally with zero latency; the guest pays RTT on everything.
6. **No robustness.** Any disconnect → back to menu. No protocol version, no backpressure handling.

Two properties of this game make the fix tractable:

* The ball sim is **deterministic and side-effect-free** w.r.t. randomness: `physicsStep()` uses only constants + state (randomness is only particles/sound pitch/CPU, and online has no CPU).
* The ball has **exactly one controller at a time** (half-rule via `ballNorth()` + `possesso`, single `holder`) → clean predict-vs-interpolate ownership rule.

Note: strict peer **lockstep is ruled out** — `Math.hypot`/`Math.sin` in `collide()` are not bit-identical across JS engines, so there must be a *single* authority; clients only *predict and correct toward it*.

---

## 2. Target architecture

```
   p1 client ──inputs(seq)──┐                        ┌──snapshots(tick,ack)──► p1 client
                            ▼                        ▼
                    ┌──────────────── server.js ────────────────┐
                    │  per-room: S, input queues, tick loop      │
                    │  step(sim.js) → S + events                 │
                    │  snapshot ~30Hz  •  event relay            │
                    └────────────────────────────────────────────┘
   p2 client ──inputs(seq)──┘                        └──snapshots(tick,ack)──► p2 client
```

* The server runs the authoritative sim at a fixed tick; snapshots decouple at ~30 Hz.
* Each client **predicts the ball only while it is the controller** (its own drag, or the flight of the shot it launched); otherwise it **interpolates** from the snapshot buffer.
* `sim.js` is one file used in three places: server (authority), each client (prediction/replay), and Node tests (deterministic replay).
* Roles become `p1` (Red/south, `z<0`) and `p2` (Blue/north, `z>0`). Old host/guest naming maps mechanically: host↔p1, guest↔p2 (guest's 180° view rotation is view-only and stays).

---

## 3. `sim.js` — shared headless core (the linchpin)

Move out of `game.js`: `physicsStep`, `collide`, `response`, `cylContact`, `boxContact`, plus grab/release/keep/ground logic (`grab`, `releaseBall`, `onKeep`, `planeActive`, `groundTouch`, `pallaPresa` state effects) and the scoring flow (`hoopScored`, `afterNet`).

* **Pure:** operates on an explicit state object `S` (ball, hoops, `phase`, `scores`, `possesso`, `holder`, `vincoli`, `lancio`, tick counter). No DOM, no `G`, no audio, no `netSend`, no `Math.random()` in the ball path.
* **Emits events** instead of causing effects: `{ev:'bounce',key,impact}`, `{ev:'rim',x,z}`, `{ev:'scored',player}`, `{ev:'respawn',side}`, `{ev:'finished',winner}`. Server forwards them; clients render them (audio/bursts).
* Scoring-flow `tween`/`delay` (ball shrink into net at 0.5 s, respawn pause 1.0 s) become **tick-based sim timers** so server state and client prediction/replay share one timeline.
* Determinism hygiene: prefer explicit `Math.sqrt(a²+b²+c²)` over `Math.hypot` where it feeds physics (engine-dependent edge cases); avoid transcendental drift.
* Node + browser compatible (plain module: attach to `window` or `module.exports`).

`game.js` keeps: rendering, input, audio (driven by events), CPU controller for local modes, score display, resize/camera.

---

## 4. Protocol v2 (JSON, keep whitelisting in `server.js`)

`join` carries `v`. Server whitelist must be updated for every new kind or messages are silently dropped (per `AGENTS.md`).

| Type | Dir | Payload |
|---|---|---|
| `join` | c→s | `{ v }` |
| `room` | s→c | `{ role:'p1'\|'p2', match }` |
| `start` | s→c | `{ tick, time, S }` full initial state |
| `i` | c→s | `{ seq, kind:'g'\|'m'\|'r', x, z }` (replaces `g`/`m`/`r`) |
| `s` | s→c | `{ tick, time, ack:[p1seq,p2seq], b:[x,y,z,vx,vy,vz,scale,rot], h:holder, p:possesso, sc, ph, k, ton, w }` |
| `e` | s→c | `{ tick, ev, ... }` (authoritative events) |
| `ping`/`pong` | both | extended with server `time` for clock offset |
| `resume`/`opp_left`/`opp_back` | — | Phase 4 (grace-period aware) |

* Snapshot `b` keeps the POC index order prefix `[x,y,z,…,scale,rot]` but v2 **inserts velocities** `[x,y,z,vx,vy,vz,scale,rot]` — reconciliation/replay needs them (position-only state cannot be deterministically fast-forwarded; nengi.js docs lesson). Keep index order in sync between send and apply.
* `b[5]` (vz) matters for prediction: the ball's flight is drag-power + throw-up + gravity, all velocity-driven.
* Sizes: snapshot ~120 B → ~3.5 KB/s at 30 Hz — negligible; plain JSON stays for now.

---

## 5. Server (`server.js`)

* One monotonic loop steps every room with a fixed accumulator (`FIXED = 0.0166`) using `process.hrtime.bigint()`; snapshots decoupled at ~30 Hz.
* Per room: `S`, per-player input queue, `ack` counters, match token. Inputs applied in order on arrival (simple + robust; timestamping is a later refinement).
* Server emits `s` snapshots and relays `e` events; it never plays audio or particles.
* Sanity-limit input rate; reject non-finite / out-of-range coordinates.
* Backpressure: skip a snapshot if socket `bufferedAmount` is high; always send events.

---

## 6. Clients (`game.js`)

**Phase 1 — interpolation**
* Snapshot jitter buffer (last ~5). Render remote/neutral ball at `newestTick - 2` (adaptive to measured jitter), lerping `x,y,z,scale,rot`.
* Clock offset from extended `ping`/`pong` so the render timeline lives in server time.

**Phase 2 — prediction + reconciliation**
* On local input, apply to a sandboxed `S` and run `sim.step`; render from it (zero-lag drag for your own ball).
* Keep an `inputLog`; on snapshot with `ack[me] = A`: reset `S` to authoritative state, replay inputs with `seq > A`; snap on large error, blend over a few frames on small error (spring-follow timing differences while dragging are the common small-error case).
* Switch to interpolation when a snapshot's `holder`/half says the opponent controls the ball.
* Prediction never emits audio/particles — server `e` events own those, so nothing double-plays (this is why `sim.js` must be effect-free).

Known Phase-2 limits (fixed later by input timestamping / lag comp): while dragging, the server sees your target slightly later than local prediction → small transient reconciled error; shot release state can differ slightly → corrected continuously by snapshots.

---

## 7. Phased rollout

| Phase | Deliverable | Result |
|---|---|---|
| **0** | `sim.js` extraction; server runs sim + relays; protocol v2 with tick/seq/ack; `start` message; clients render snapshots directly; net HUD (RTT, snap rate, jitter, correction count) + artificial latency/jitter dev toggle; local modes verified unchanged | Server-authoritative POC (feel ≈ current, correct model) |
| **1** | Clock sync + jitter buffer + interpolation for remote/neutral ball | No stutter/snapping |
| **2** | Own-ball prediction + reconciliation | No input lag (headline win) |
| 3+ | Tick-stamped inputs, server-side lag comp (validate guest grab radius against ~RTT/2-old ball state), reconnect/resume (`resume`, `opp_back`), protocol versioning/validation, optional binary/delta encoding | Robustness & fairness polish |

* Local modes (`G.online === null`) keep the existing path; `newGame`/`update` semantics preserved, just delegating ball math to `sim.js`.
* On `game.js` changes bump the `?v=` cache-buster in `index.html` (currently `?v=5`).
* Update `AGENTS.md` and `README.md` after implementation — they still describe the host-authoritative relay.

## 8. Testing

* Node golden-replay tests over `sim.js` (record input sequences + expected states) to lock determinism.
* Two headless bot clients against the server to exercise the loop without a browser.
* Artificial latency/jitter toggle + net HUD to tune interpolation delay and reconciliation thresholds.

## 9. Risks

* **Cross-engine prediction drift** (V8/SpiderMonkey/JSC): bounded and self-healing via reconciliation + error smoothing; keep physics math simple.
* **Server tick jitter**: fixed accumulator loop; steady-state correct.
* **Bigger first step than the peer upgrade**: Phase 0 is real work but mechanical, guarded by replay tests, and unlocks reconnect + fairness.

## 10. Non-goals (now)

WebRTC/unreliable transport (TCP payloads are tiny), binary/delta encoding, matchmaking/ELO, spectating.

## 11. Libraries (assessed 2026-10-17)

**Adopt (one): `@geckos.io/snapshot-interpolation`** — BSD-3-Clause, zero runtime deps, ships a no-build browser bundle (`Snap` global). Vault + `calcInterpolation()` implements Phase 1 (jitter buffer, default 3 server frames, timestamp handling) and its vault doubles as the past-state store for Phase 3 lag compensation. **Vendor the bundle into the repo** (e.g. `lib/snapshot-interpolation.js`) instead of a CDN script to keep offline/file:// behaviour. Alternative: hand-roll the ~50–60 line algorithm; the lib's value is battle-tested NaN/jitter edge cases.

**Study, don't adopt:**
* `nengi.js` — full server-authoritative engine (prediction/reconciliation API, historian for lag comp); nengi 2 API explicitly unstable; adopting = rebuilding around its entity/command model. Its docs are the reference for Phases 2–3; key lesson already folded into §4 (snapshots must carry velocities for deterministic replay).
* `Colyseus` — rooms + schema state sync + reconnection; would replace the whole protocol/lobby and conflicts with tick/snapshot design.
* `socket.io` — buys Phase-4 reconnect/acks but replaces the hand-rolled `ws` relay; resume-token approach is narrow enough to hand-roll.

**Not needed:** geckos.io-full/simple-peer (WebRTC — non-goal), uWebSockets.js (perf-only), timesync (hand-roll clock sync ~20 lines), toxiproxy/clumsy (in-code latency toggle is simpler), `node:test` (built-in, zero dev-deps, for §8 golden-replay tests).

**Avoid:** planck.js/matter.js/cannon-es physics engines — `sim.js` is a faithful port of the original Unity PhysX scene; swapping engines changes gameplay fidelity and the determinism story.
