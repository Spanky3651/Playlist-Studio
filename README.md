# 🎵 Playlist Studio

**A Beat Saber playlist builder powered by [BeatLeader](https://beatleader.xyz).**
Filter the ranked (and unranked) catalog by star rating, mapper, NPS and more, curate the maps you actually want, preview them in-app, see your own scores on every map, and export a ready-to-play `.bplist` — all from a single self-contained HTML file.

![Playlist Studio interface](screenshot.png)

---

## Overview

Playlist Studio turns BeatLeader's live map data into curated Beat Saber playlists. Instead of dumping every map that matches your filters, it works like a shopping cart: search, add the good ones to **Your Playlist**, reorder and cover it, then export. It runs entirely in your browser as one HTML file — no install or build step, and no account.

## Features

### Search & filter (BeatLeader)
- **Star-rating** range and **ranked status** (ranked / unranked / nominated / qualified / all)
- **Mapper** and **keyword** search
- **Game mode** — Standard, One Saber, No Arrows, 90°/360°, Lightshow, Lawless
- **Optional difficulty filter** (Easy → Expert+) — off by default so every difficulty comes through until you want to narrow it
- **NPS, duration and BPM** bounds
- **PP range** — keep only ranked maps worth a target PP at your accuracy and speed (see below)
- **Rating-focus sort** — Stars, Tech, Acc, Pass, NPS, Duration, BPM, or **PP at your target accuracy**
- Live client-side filtering: tweak a value and the match count updates instantly, no re-fetch
- Press **Enter** in any filter to fetch; the Fetch button flags when your filters have drifted from your last pull

### Build a playlist
- Two-panel builder: **Search Results → Your Playlist** (the playlist is what gets exported)
- Add one at a time, **Add all**, **Add top N**, or **⚄ Random**
- **Reorder** (▲▼), remove, **Shuffle**, **Sort by ★** (warmup → hard), **Clear**
- **Collapse duplicate songs** to keep one entry per song
- Build a single playlist from several different searches
- Live totals: song count, runtime, star range + average, and average NPS

### Your scores & history (connect a BeatLeader profile)
Paste your BeatLeader profile URL or ID and Playlist Studio syncs your play history — public data, no login — so you can see and build around what you've actually played:
- **Score badges on every map** — your accuracy with a green **FC** / blue **passed** / dashed **NEW** marker and your rank
- **Filter by your history** — not played, played, full-combo'd, played-but-not-FC, **near-miss FC**, or "only my accuracy below X%"
- **One-tap smart lists** — Unplayed, Near-miss FC, Sub-90%
- **Sort by you** — my accuracy, my rank, date I played, or improvement potential
- **Your best in the preview** — accuracy, misses (and the would-be FC accuracy), rank, date, and a link to watch the replay
- **Playlist readout** — "you've FC'd 4 of 15 here, 91% avg"
- Scores are cached in your browser; **↻ Sync** does a fast incremental refresh afterward

### Preview before you commit
- ▶ on any row opens an in-app preview — the map rendered in [ArcViewer](https://allpoland.github.io/ArcViewer/) (notes + audio) plus a BeatSaver audio clip, with links out to BeatSaver and the full viewer.

### PP calculator (ranked maps)
Work out exactly what a score is worth before you grind it.

![PP calculator](pp-calc.png)

- **"What would 95% give me?"** — every ranked result and playlist row shows a raw-PP estimate for a target accuracy you set once (in the **PP Filter** panel). Unranked maps show nothing, because PP doesn't apply to them.
- **Full calculator per map** — open any map and dial in an exact accuracy (type it or tap 90 / 95 / 97 / 99 / 100). You get the raw PP plus the **pass / acc / tech** breakdown so you can see where the points come from.
- **Speed modifiers** — toggle **SS** (Slower), **FS** (Faster) or **SF** (Super Fast). BeatLeader re-rates a map at each speed, so the calculator swaps in that speed's pass/acc/tech ratings: FS/SF push the rating (and the PP) up, SS pulls it down. Modifiers a map isn't rated for are greyed out.
- **Accuracy reference row** — a quick 90 → 100% PP ladder for the selected speed, so you can eyeball how much each extra tenth of a percent is worth.
- **Sort by PP** — set the *Rating focus* to **PP @ target acc** to rank the whole result set by earning potential.

### Filter by PP

![PP filter](pp-filter.png)

The **PP Filter** panel turns all of that into a real filter — "only show me maps worth grinding."

- Set your **target accuracy** and **speed** once (No modifier / SS / FS / SF), then give a **PP range** — a minimum, a maximum, or both. Only ranked maps whose estimated raw PP lands in that band survive; unranked maps drop out while a bound is set.
- That same accuracy and speed drive the **≈pp badge** on every row and the **PP sort**, so what you filter on is exactly what you see — flip to **FS** and the whole list re-evaluates at Faster Song, badges and all.
- A map that isn't rated for the chosen speed is skipped by the range filter (it has no PP at that speed to compare).
- The PP range, accuracy, and speed all save into **filter presets**, so "6★+ tech that pays ≥300pp at 96% FS" is one click away next time.

The math mirrors BeatLeader's server exactly: `passPP = 15.2·e^(passRating^(1/2.62)) − 30`, `accPP = curve(acc)·accRating·34`, `techPP = e^(1.9·acc)·1.08·techRating`, summed and inflated (`650·x^1.3 / 650^1.3`). It reports **raw (unweighted) PP** — the value of the play itself, before your profile's weighting.

### Covers & export
- Auto-generated neon cover art — **18 procedural styles and 13 accent palettes**, picked from a live thumbnail grid — drawn from your title and star range, or upload your own image
- Exports a spec-compliant `.bplist`: PascalCase difficulty names, embedded Base64 cover, difficulties merged per song, and your play order preserved

### Save, reload & import
- **Filter presets** — save filter combos you reuse (e.g. "6★ tech warmup")
- **Playlist Library** — save and reload whole playlists
- **Session autosave** — an accidental refresh won't lose your work in progress
- **Import `.bplist`** — open an existing playlist to edit it
- **BeatLeader enrichment** — `↻ Enrich` fills in stars / NPS / duration / cover for imported songs by hash; `★ Refresh` re-checks every song in the playlist to catch rating recalcs

## Getting started

**Just open it.** Download **`index.html`** and open it in any modern browser (Chrome, Edge or Firefox). It's fully self-contained — the styles, cover generator, exporter and app logic are all inlined.

**Or host it on GitHub Pages.** Enable Pages for this repo (*Settings → Pages → deploy from `main`*) and open `https://<user>.github.io/<repo>/`. It works the same; the public relay pool handles CORS.

## How the connection works

BeatLeader's API doesn't send cross-origin CORS headers, so a browser can't call it directly from a file or a third-party site — it fails with *"Failed to fetch."* Playlist Studio gets around this by routing read-only public requests through a **pool of public CORS relays**, racing them and using the first that responds. Dead or slow relays are dropped automatically, and there's nothing to configure.

If you run your own CORS relay and would rather use it, point the app at it under **Data Source → Advanced: custom relay**. (Map previews use BeatSaver and ArcViewer directly — both are CORS-friendly, so they need no relay.)

## Installing a playlist in Beat Saber

1. Export the `.bplist` from Playlist Studio.
2. Drop it into your Beat Saber `Playlists` folder — on PC that's usually `…\Steam\steamapps\common\Beat Saber\Playlists\`.
3. In-game, refresh your song list. The [PlaylistManager](https://github.com/rithik-b/PlaylistManager) mod loads the playlist; any maps you don't have download automatically if you use playlist syncing / BeatSaver downloading.

## Privacy

- No account, no tracking, no analytics.
- Presets, saved playlists, your working session, and your connected profile + synced scores are all stored in your browser's local storage — nothing is uploaded.
- API requests hit BeatLeader and BeatSaver (public data) through a public relay; only anonymous, read-only GETs are ever sent.

## Built with

Vanilla HTML, CSS and JavaScript — no framework and no build tooling. The single `index.html` inlines the stylesheet, the canvas cover generator, the `.bplist` exporter, and the application logic.

- Map data — [BeatLeader](https://api.beatleader.xyz)
- Map previews — [BeatSaver](https://beatsaver.com) + [ArcViewer](https://github.com/allpoland/ArcViewer)
- Export format — [PlaylistManager](https://github.com/rithik-b/PlaylistManager)

## Credits

Made by **MSploit** — [BeatLeader profile](https://beatleader.com/u/76561199153577883)

Not affiliated with Beat Games, BeatLeader or BeatSaver.

## License

Released under the [MIT License](LICENSE).
