# Games collection — rules for every chat

This repo is a collection of small browser games, published by Vercel from the `main` branch.

Live site: [LIVE LINK]  ← replace with the real Vercel URL (e.g. https://my-games.vercel.app)

## Layout
- `index.html` (top level) — the home page. It lists every game as a big tappable card.
- `<folder>/index.html` — one game per folder, e.g. `block-dodge/index.html`.

## Rules
1. **One folder per game, one file per game.** Every new game goes in its own folder
   (lowercase-with-dashes name) as a single self-contained `index.html` — inline CSS and JS,
   no build step, no extra files.
2. **Made for phones.** Mobile-first layout with a proper viewport meta tag, **touch controls**
   (keyboard can be an extra), big tap targets, no page scrolling/zooming while playing, and
   a "← Games" link back to `../`.
3. **Add every new game to the home page.** Add an entry to the `GAMES` array in the
   top-level `index.html` (folder, title, emoji, blurb, color).
4. **Test it.** Before shipping, load the game in headless Chromium (Playwright is
   pre-installed) at a phone size, check there are no console errors, that touch input
   works, and that the home page card links to it.
5. **Get it onto `main`.** The owner has given permission to push directly to `main` in this
   repo, because Vercel only publishes `main`. Commit on the working branch, then merge it
   into `main` and push `main` (as well as the working branch).
6. **Always finish with the play link:** `[LIVE LINK]/<folder>/`
