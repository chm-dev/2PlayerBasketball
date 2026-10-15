## Basketball - web port of Android mini-game from [JungleFrog.NPlayers.Basketball](https://play.google.com/store/apps/details?id=com.JindoBlu.TwoPlayerGamesChallenge&hl=en)

Original APK Reverse Engineered using [REA](https://rea.tools) with Sonnet 5.5 and GPT Luna 6 and rebuilt for web with Sonnet.

The original is a real 3D physics scene seen from above, so the port simulates the ball in 3D and only draws it top-down.

* Physics: Gravity is -9.81 plus an extra -100 pull, and the ball bounces at 0.9 off floor and walls.
* Hoop: The hoop is built from tilted cylinder and box colliders. A basket counts when the ball enters a small trigger sphere above the ring. Flat shots bounce off the rim instead.
* Controls: Touching the ball pulls it toward your finger with a spring-like force, and releasing throws it straight up at 75 plus whatever sideways speed it had. Each half is only draggable by its owner.
* CPU: It waits before grabbing, drags the ball to a random spot, then throws at the hoop. Its accuracy depends on difficulty and the current score gap.
* Scoring: The ball shrinks into the net and, after a pause, respawns on the side of the team that conceded. A match is first to 5.
* Assets: Sprites and sounds are extracted from the game: ball, hoop base, net, grab, swish, rim and bounce sounds, and the whistle.

### Remaining guesses and gaps:

* Rim shape: The rim is a plain round cylinder where the original's is slightly oval.
* CPU drag: I assumed it moves linearly over 1 second.
* Visual effects: The sparkle bursts and the trail's exact look are approximations.
* Scoreboard and win screen: They are simple, since the shared in-game UI prefab was never extracted.
* Trigger behaviour: Assumed any ball entering it scores.

<img width="416" height="819" alt="image" src="https://github.com/user-attachments/assets/f5b60e89-c287-41d3-85e7-77c56c48f06c" />
