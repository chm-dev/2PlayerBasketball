# AGENTS.md — codebase notes for future agentic edits

Concise handoff doc describing the project and, mainly, the online-multiplayer
POC. Read this before changing `game.js`, `server.js`, or anything multiplayer-related.

## Project

Web port of a Unity/JungleFrog basketball mini-game: top-down 3D-simulated ball,
drag-and-release shots, first to 5. Single-page game, no build step, no framework.

* `index.html` — overlays (menu/over), `#ping` latency label, loads `game.js?v=N`
* `game.js` — ALL game code: sim, physics, rendering, input, audio, networking
* `server.js` — Node + `ws`: static file serving, lobby pairing, message relay
* `package.json` — `npm start` runs `server.js`; sole dependency is `ws`
* `assets/` — sprites and sounds extracted from the original APK

Run: `npm install && npm start` → `http://localhost:8080`.

## Modes

`G.online` is the mode switch: `null` = local (1P vs CPU, shared-screen 2P),
`'host'` = online player 1 (Red, south half, z<0), `'guest'` = online player 2
(Blue, north half, z>0). Local modes must keep working unchanged — most online
behaviour branches on `G.online` rather than altering shared code paths.

## Multiplayer architecture (host-authoritative relay)

The host client runs the entire existing simulation and owns all state. The
guest client NEVER simulates — it renders snapshots and runs only particles,
trail, and sound playback. The server never sees game state; it relays and pairs.

Message protocol (JSON, whitelisted per role in `server.js`):

| Type | Direction | Meaning |
|---|---|---|
| `join` | client→server | queue for a match |
| `room` | server→client | paired; `role: 'host'|'guest'` |
| `opp_left` | server→client | partner disconnected |
| `g`/`m`/`r` | guest→server→host | guest pointerdown/move/up with world `x`,`z` |
| `s` | host→guest | snapshot `b:[x,y,z,scale,rot]`, `p` possesso, `sc` scores, `ph` phase, `k` kin, `ton` trailOn, `w` winner (~30/s, throttled by `NET.acc`) |
| `e` | host→guest | events: `ev:'snd'` (sound name/vol) and `ev:'burst'` (particles) |
| `ping`/`pong` | both ways | latency probe, 2s interval, shown in `#ping` |

Server whitelist lives in `server.js` (guest: `g,m,r`; host: `s,e`; both: `ping,pong`).
New message kinds must be added there or they are silently dropped.

Key code locations in `game.js`:

* Networking block right after `playAny`: `NET` object, `netSend/netConnect/
  netMessage/netToMenu/startOnline`, guest input handlers (`guestGrab/Move/
  Release`), `sendSnapshot/applySnapshot`
* `play()` emits `snd` events to the guest (guarded by `G.online === 'host'`);
  `netBurst()` is the burst wrapper — call it instead of `burst()` for anything
  the guest should see
* Input section: pointer handlers branch on `G.online` (guest forwards raw
  touches; host maps them to ids `'host'`/`'guest'` in `G.pointers`)
* Frame loop: `frame()` branches — guest runs `guestUpdate(dt)` only, host runs
  `update(dt)` + throttled `sendSnapshot()`

## Orientation (guest view)

The guest's canvas is rendered rotated 180 deg so their half is at the bottom:

* `render()` transform is `(-S, 0, 0, S, W/2, H/2)` when `G.online === 'guest'`
* `toWorld()` inverts the mapping for the guest — touch→world coords must stay
  in sync with that transform or guest input breaks
* Any new text drawn in world coords (like `drawScore`) needs a 180 deg
  counter-rotation on the guest's view to stay upright

## Deliberate values / gotchas

* Height-based ball scale: `ballScale()` multiplies by `1 + 0.35 * y/MAX_Y` —
  0.35 was user-tuned; keep it unless asked otherwise. Ground shadow is
  intentionally constant size (height cue comes from shadow↔ball size gap).
* Snapshots carry `B.y` in `b[1]` (added for the scale effect) — keep the
  index order `[x,y,z,scale,rot]` in sync between `sendSnapshot` and `applySnapshot`.
* `ballScale()` and `guestUpdate()` exist only for visuals; the guest never
  receives physics (its `B.vx/vy/vz` are unused garbage — don't "fix" that).
* Over-screen hide on the guest is snapshot-driven (phase transition to
  `'playing'`), so no explicit restart message exists.
* On `game.js` changes, bump the `?v=` cache-buster in `index.html`.
* POC status: no input prediction (guest shots have ~1 RTT lag), no
  reconnection, plain JSON messages. Server-authoritative simulation is the
  natural next step if stricter fairness is wanted — the input/snapshot split
  already matches that direction.
