## Basketball - web port of Android mini-game from [JungleFrog.NPlayers.Basketball](https://play.google.com/store/apps/details?id=com.JindoBlu.TwoPlayerGamesChallenge&hl=en)

Original APK Reverse Engineered using [REA](https://rea.tools) + Ghidra with Sonnet 5.5 and GPT Luna 6 and rebuilt for web with Sonnet.

The original is a real 3D physics scene seen from above, so the port simulates the ball in 3D and only draws it top-down.

* Physics: Gravity is -9.81 plus an extra -100 pull, and the ball bounces at 0.9 off floor and walls.
* Hoop: The hoop is built from tilted cylinder and box colliders. A basket counts when the ball enters a small trigger sphere above the ring. Flat shots bounce off the rim instead.
* Controls: Touching the ball pulls it toward your finger with a spring-like force, and releasing throws it straight up at 75 plus whatever sideways speed it had. Each half is only draggable by its owner.
* Scoring: The ball shrinks into the net and, after a pause, respawns on the side of the team that conceded. A match is first to 5.
* Assets: Sprites and sounds are extracted from the game: ball, hoop base, net, grab, swish, rim and bounce sounds, and the whistle.

### Online multiplayer (server-authoritative)

* Run `npm install` then `npm start` (or `node server.js`) and open `http://localhost:8080` in two windows/devices on the network.
* The menu has a "2 Players - Online" button; the server pairs every two waiting clients into a room. The game is online-only — there is no local or CPU mode.
* Architecture: **server-authoritative**. The simulation lives in `sim.js`, a pure headless module shared by the Node server (authority) and the browsers (prediction/replay). The server runs it on a fixed 60 Hz tick, consumes each player's input events in order, and broadcasts snapshots (~30 Hz) plus authoritative sound/particle events. Neither browser simulates the world.
* Each client **predicts** the ball while it owns it — its own drag, the flight of the shot it launched, or a loose ball in its half — so dragging is zero-lag, and **interpolates** everything else from a snapshot jitter buffer (vendored `@geckos.io/snapshot-interpolation`). Prediction is reconciled against every snapshot by replaying inputs the server has not acknowledged yet; small differences are smoothed away, large ones snap.
* Each online player is restricted to their own half: Red (p1) grabs the ball only when it is south of centre, Blue (p2) only when it is north.
* Player-relative view: p2's canvas is rendered rotated 180 deg so their own half (and hoop) sits at the bottom, with the scoreboard counter-rotated to stay upright.
* Latency display: each client pings the server every 2s and shows the round-trip in the top-left corner; a small HUD (top-right) shows snapshot rate, jitter and correction count. Add `?lat=120&jit=30` to the URL to simulate round-trip latency and jitter locally.
* The ball sprite and possession circle scale up with ball height (up to +35% at the apex) as a subtle perspective cue; the ground shadow stays constant.
* Known limitations: no reconnection (a disconnect ends the match), inputs are not tick-stamped (no server-side lag compensation yet), and the opponent's grab is not predicted. Everything is plain JSON. `npm test` runs the sim/determinism and headless-bot suites.

### Remaining guesses and gaps:

* Rim shape: The rim is a plain round cylinder where the original's is slightly oval.
* CPU drag: I assumed it moves linearly over 1 second.
* Visual effects: The sparkle bursts and the trail's exact look are approximations.
* Scoreboard and win screen: They are simple, since the shared in-game UI prefab was never extracted.
* Trigger behaviour: Assumed any ball entering it scores.

<img width="416" height="819" alt="image" src="https://github.com/user-attachments/assets/f5b60e89-c287-41d3-85e7-77c56c48f06c" />
