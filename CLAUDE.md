# Games collection — rules for every chat

This repo is a collection of small browser games, published by Vercel from the `main` branch.

Live site: https://games-smoky-mu.vercel.app

## Layout
- `index.html` (top level) — the home page. It lists every game as a big tappable card.
- `<folder>/index.html` — one game per folder, e.g. `block-dodge/index.html`.
- `api/chess.js` — the online server for Chess (accounts, friends, leaderboard, live games). Runs as a
  Vercel serverless function and needs an Upstash Redis database connected to the Vercel project
  (env vars `KV_REST_API_URL` / `KV_REST_API_TOKEN`). Its chess rules are a copy of `engineFactory()`
  in `chess/index.html`, so keep them in sync.

## Rules
1. **One folder per game, one file per game.** Every new game goes in its own folder
   (lowercase-with-dashes name) as a single self-contained `index.html` — inline CSS and JS,
   no build step, no extra files.
2. **Made for phones.** Mobile-first layout with a proper viewport meta tag, **touch controls**
   (keyboard can be an extra), big tap targets, no page scrolling/zooming while playing, and
   a "← Games" link back to `../`.
3. **Xbox controller support too.** Every game must also be fully playable with a Bluetooth
   game controller (Xbox-style) using the browser Gamepad API (`navigator.getGamepads()`),
   polled every frame. Touch stays as well, so both work in every game. Standard mapping:
   - Left stick **and** D-pad to move/aim (use a dead zone of ~0.25 on the stick).
   - **A** (button 0) = main action, and also Start / Play again on menus and game-over screens.
   - **B** (button 1) = secondary action if needed; **Start/Menu** (button 9) = start/pause.
   - Menus and game-over screens must be usable with only the controller (no touch needed).
   - Show a short hint on the start screen, e.g. "🎮 Controller: stick to move, A to start".
   - Controllers only appear after a button is pressed — handle `gamepadconnected` and
     keep working if one connects mid-game.
4. **Add every new game to the home page.** Add an entry to the `GAMES` array in the
   top-level `index.html` (folder, title, emoji, blurb, color).
5. **Test it.** Before shipping, load the game in headless Chromium (Playwright is
   pre-installed) at a phone size, check there are no console errors, that touch input
   works, that controller input works (fake a gamepad by overriding `navigator.getGamepads`
   in the test), and that the home page card links to it.
6. **Get it onto `main`.** The owner has given permission to push directly to `main` in this
   repo, because Vercel only publishes `main`. Commit on the working branch, then merge it
   into `main` and push `main` (as well as the working branch).
7. **Always finish with the play link:** `https://games-smoky-mu.vercel.app/<folder>/`
