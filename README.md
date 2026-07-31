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
- **Rating-focus sort** — Stars, Tech, Acc, Pass, NPS, Duration or BPM
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

**Or host it on GitHub Pages.** Enable Pages for this repo (*Settings → Pages → deploy from `main`*) and open `https://<user>.github.io/<repo>/`. It works the same; the relay below handles CORS.

## How the connection works

BeatLeader's API doesn't send cross-origin CORS headers, so a browser can't call it directly from a file or a third-party site — it fails with *"Failed to fetch."* Playlist Studio gets around this by routing read-only public requests through a **pool of public CORS relays**, racing them and using the first that responds. Dead or slow relays are dropped automatically, and there's nothing to configure.

If every public relay is briefly down, or you'd rather keep everything on your own machine, run the optional **local relay** included in the repo:

```bash
node relay.js        # or:  python relay.py
```

On Windows you can just double-click **`Start-Relay.bat`**. Then in the app open **Data Source → Advanced → custom relay** and paste:

```
http://localhost:8787/?url=
```

The local relay only forwards anonymous GET requests to `api.beatleader.xyz`. (Map previews use BeatSaver and ArcViewer directly — both are CORS-friendly, so they need no relay.)

## Installing a playlist in Beat Saber

1. Export the `.bplist` from Playlist Studio.
2. Drop it into your Beat Saber `Playlists` folder — on PC that's usually `…\Steam\steamapps\common\Beat Saber\Playlists\`.
3. In-game, refresh your song list. The [PlaylistManager](https://github.com/rithik-b/PlaylistManager) mod loads the playlist; any maps you don't have download automatically if you use playlist syncing / BeatSaver downloading.

## Privacy

- No account, no tracking, no analytics.
- Presets, saved playlists, your working session, and your connected profile + synced scores are all stored in your browser's local storage — nothing is uploaded.
- API requests hit BeatLeader and BeatSaver (public data) through a relay; the optional local relay keeps even those on your own machine.

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
