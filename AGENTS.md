# AGENTS.md — codebase notes for future agentic edits

Concise handoff doc. Read this before changing `sim.js`, `server.js`, `game.js`,
or anything multiplayer-related.

## Project

Web port of a Unity/JungleFrog basketball mini-game: top-down 3D-simulated ball,
drag-and-release shots, first to 5. Single-page, no build step, no framework.
**Online-only**: there is no local/CPU mode any more.

* `index.html` — overlays (menu/over), `#ping` + `#hud` labels, loads `sim.js`,
  `lib/snapshot-interpolation.js`, then `game.js?v=N`
* `sim.js` — the headless simulation (authority + client prediction + tests)
* `server.js` — Node + `ws`: static serving, lobby pairing, **and the authority**
  (runs `sim.js` on a fixed tick, broadcasts snapshots + events)
* `game.js` — client only: rendering, input, audio, interpolation, prediction,
  reconciliation, net HUD. It never simulates the world.
* `lib/snapshot-interpolation.js` — vendored BSD-3 dependency (jitter buffer /
  interpolation), exposes the `Snap` global. Attribution in the file header.
* `test/` — `node --test` suites (see Testing)
* `package.json` — `npm start` runs `server.js`, `npm test` runs the suites;
  sole dependency is `ws`
* `assets/` — sprites and sounds extracted from the original APK

Run: `npm install && npm start` → `http://localhost:8080` (open two windows).
Dev net simulation: `?lat=120&jit=30` (round-trip ms) — see the net HUD.

## Architecture (server-authoritative)

```
   p1 client ──inputs(seq)──┐                        ┌──snapshots(tick,ack)──► p1 client
                            ▼                        ▼
                    ┌──────────────── server.js ────────────────┐
                    │  per-room: S, input queues, ack counters   │
                    │  step(sim.js) → S + events                 │
                    │  snapshot ~30Hz  •  event relay            │
                    └────────────────────────────────────────────┘
   p2 client ──inputs(seq)──┘                        └──snapshots(tick,ack)──► p2 client
```

* Roles are `p1` (Red, south half, `z<0`) and `p2` (Blue, north half, `z>0`).
  `MY.role` is `1`/`2`; `0` means "nobody" in sim state (`holder`, `possesso`).
* The server owns all state. Clients **predict the ball only while they own it**
  (their drag, the flight of their shot, or a loose ball in their half) and
  **interpolate** everything else from a snapshot jitter buffer.
* `sim.js` is used in three places: server (authority), client (prediction /
  replay), Node tests (deterministic replay). It is pure: explicit state in,
  events out — no DOM, no audio, no `Math.random`, no timing APIs.

## Protocol v2 (JSON, whitelisted by kind in `server.js`)

| Type | Dir | Payload |
|---|---|---|
| `join` | c→s | `{ v }` — wrong `v` gets `{ t:'ver', v }` and is turned away |
| `room` | s→c | `{ role:'p1'\|'p2' }` |
| `start` | s→c | `{ tm, token, S }` — full state from `Sim.dump`, plus match token |
| `i` | c→s | `{ seq, k:'g'\|'m'\|'r', x, z, token }` |
| `s` | s→c | `{ tm, a:[ackP1,ackP2], ...Sim.snapshot(S) }` (~30 Hz) |
| `e` | s→c | `{ tick, evs:[…] }` — authoritative events |
| `ping`/`pong` | both | clock probe; `pong` carries server `time` for offset |
| `again` | c→s | restart the match (either player) |
| `opp_left` | s→c | partner disconnected |

Snapshot field `b` index order (**keep send/apply in sync**, `Sim.snapshot` /
`Sim.applySnapshot`):

```
0 x   1 y   2 z   3 vx  4 vy  5 vz  6 scale  7 rot  8 tx  9 ty  10 tz  11 drag
```

* Velocities are required: prediction/replay cannot fast-forward from position
  alone. `tx/ty/tz/drag` are required for the same reason while dragging.
* The tick lives in `tk`, **not** `t` — `t` is reserved for the message type.
* Server whitelist: it validates `i`/`ping`/`again` itself and never relays
  client→client messages. New kinds must be handled in `server.js` or they are
  silently ignored.
* `Sim.snapshot` rounds to 2 decimals; that small loss is absorbed by error
  smoothing on the client.

## `sim.js` key points

* `S` (see `create()`) holds ball, hoops, phase/scores, possession trio
  (`possesso`/`vincoli`/`lancio`), `lastReleaser`, tick-based scoring timers
  (`scoringTimer` 0→0.5 s shrink-into-net, `respawnTimer` 0.5→1.5 s pause), the
  per-player `hold` pointer positions, and the events array.
* `step(S, inputs)` runs **one fixed tick** (`Sim.FIXED = 0.0166`): applies this
  tick's input batch in order, then the original physics/flow. Returns the
  tick's events.
* Scoring is a tick-based state machine (was a 0.5 s tween + 1 s delay) so the
  server and client replay share one timeline. `scoreFrom`/`scoreTo` live only in
  `dump`/`load`, not in wire snapshots — `step` guards for their absence.
* Events: `grab`, `release`, `bounce{impact}`, `rim{x,z}`, `scored{by}`, `cheer`,
  `respawn{x,z}`, `finished{winner}`. The server relays them; **only the client
  turns them into sound/particles** (prediction must stay effect-free).
* Determinism hygiene: explicit `Math.sqrt`, never `Math.hypot` (not
  bit-identical across engines) — enforced by a test. No `Math.random`.
* `groundTouch` also clears `lastReleaser`, so a ball that has landed counts as
  "loose in my half" for prediction ownership.
* **Dead-ball watchdog** (`deadBallGuard`, `S.restTicks`): possession is only
  unresolved while a shot is in flight, and a live shot is never stationary — so
  a ball that is motionless with `vincoli 0` for `DEAD_BALL_TICKS` (~2 s) is
  always a bug. The guard clears `possesso`/`lancio`/`inHand` and sets
  `vincoli 1`, emitting `{ev:'unstick'}` (clients ignore it; the server logs it).
  `restTicks` travels in the `rs` snapshot field so prediction agrees. It is a
  safety net, **not** the fix for a specific case — reachable states are resolved
  by `groundTouch` on the very next floor tick.

## `game.js` key points

* Prediction ownership (`shouldPredict`): predict iff `phase==='playing'` and
  (holder is me) or (no holder and `lastReleaser` is me) or (no holder, no
  releaser, ball in my half). Otherwise interpolate.
* Input stream: `sendInput` appends `{seq,k,x,z,tick}` to `inputs` (the log) and
  sends `i`. `simTick` consumes ≤ `MAX_INPUTS_PER_TICK` (8) due entries per tick —
  **the same cap as the server**.
* Reconciliation (`reconcile`, on every snapshot): drop inputs with `seq <= ack`,
  `Sim.applySnapshot(P, m)`, clamp/replay unacknowledged inputs over the elapsed
  ticks, then fold the pre/post difference into `smooth`.
* `smooth` is a decaying visual offset applied on top of either the predicted or
  the interpolated target; jumps > `SNAP_DIST` snap instead (`NET.corrections`).
* Render ball is `RB`, never `P.ball` or the vault directly. Interpolation uses
  `SNAP.calcInterpolation('x y z scale rot(deg)')`; the vendored lib also does the
  clock-offset correction for us.
* Dev latency queues (`outQ`/`inQ`) delay both directions monotonically.
* `#hud` shows rtt / snap rate / jitter / correction count.
* **Grab input is server-arbitrated.** `pointerdown` only checks that the touch is
  near the ball, then sends `i` and lets the server apply the rules — a stale or
  blind predicted state must never silently swallow a grab. `grabBlockReason()`
  reports what the client *believes* for the overlay only. The server's verdict
  (`NET.grant`) is read off the ack in `reconcile`.
* **Debug overlay**: `?debug=1` (or press **D**) shows net health (snapshot rate,
  age since the last snapshot, `STALE!`, vault size, PREDICT/INTERP/NODATA),
  the full server state from `P` (`possesso`/`vincoli`/`lancio`/`kin`/`inHand`/
  `restTicks`), the rendered ball, the held pointer, the grab verdict, and a
  `*** DEAD BALL ***` flag. Use it first when a stall is reported — it separates
  "the server stopped sending" from "the server's state is stuck".

## Orientation (p2 view)

p2's canvas is rendered rotated 180° so their half is at the bottom:

* `render()` transform is `(-S, 0, 0, S, W/2, H/2)` when `MY.role === 2`
* `toWorld()` inverts that mapping — keep it in sync or p2 input breaks
* text drawn in world coords (`drawScore`) needs a 180° counter-rotation

## Deliberate values / gotchas

* Height-based ball scale: `ballScale()` multiplies by `1 + 0.35 * y/MAX_Y` —
  0.35 is user-tuned; keep it unless asked. The ground shadow stays constant size.
* `possesso`/`lancio`/`vincoli` are the original Unity possession rules; the
  half-rule for grabbing is `p1: z<0`, `p2: z>0`, and the grab radius is 4.
* **Landing must be evaluated every floor tick.** `groundTouch` (which resolves
  possession) is called for the `floor` contact on *every* tick — the
  "new contact only" dedup applies to bounce/rim **sounds** only. Gating it on
  `B.contacts` froze the game: a ball that rolled across the halfway line while
  already on the ground kept the shooter's `possesso` with `vincoli` stuck at 0,
  so neither player could grab it. `test/sim.test.js` has a deterministic repro
  and a fuzz that seeds exactly this state.
* `vincoli === 0` means "the ball is in the opponent's half of its owner and has
  not landed yet" — during that window *nobody* can grab it by design, so any
  path that leaves `vincoli` 0 without a reachable floor contact is a dead ball.
  A watchdog (`deadBallGuard`, ~2 s) guarantees this can never stall a match, and
  the server prints `dead-ball guard fired ...` when it fires — that log line is
  the evidence to ask a user for if a stall is ever reported again.
* The token is regenerated on every `start` so pre-restart inputs in flight are
  rejected. `ack` resets with it.
* Backpressure: the server skips a snapshot when `bufferedAmount` is high but
  always sends events.
* On `game.js`/`sim.js` changes, bump the `?v=` cache-buster in `index.html`.
* Phase 3+ (not implemented): tick-stamped inputs / server lag comp, reconnect
  + `resume`/`opp_back`, binary/delta encoding. Known limits: while dragging, the
  server sees the pointer slightly later than local prediction, and a shot's
  release state can differ for a frame — both are corrected continuously by
  snapshots (no input prediction for the opponent's grab yet).

## Testing

`npm test` (`node --test`) runs:

* `test/sim.test.js` — golden replay/determinism, `dump`/`load` round-trip, wire
  snapshot round-trip, half/grab rules, scoring + respawn + win flow, the
  possession-freeze regression + fuzz, the dead-ball watchdog (fires on a stuck
  state, stays silent for a live shot), and hygiene.
* `test/server.test.js` — headless bots: pairing, start state, input→sim→
  snapshot→ack, event relay, input validation, version rejection, disconnect,
  restart.
* `test/prediction.test.js` — a bot mirroring the `game.js` client loop stays
  within ~1 unit of the authority through a drag + shot.

Keep these green when touching the sim, the wire format, or the client loop.
