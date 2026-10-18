# 🎵 Playlist Studio

**A Beat Saber playlist tool and builder that searches [BeatLeader](https://beatleader.xyz) and [BeatSaver](https://beatsaver.com).**
Filter the ranked catalog by star rating, mapper, NPS and more - or flip to the BeatSaver catalog and build by **tags** (tech, speed, genres) including unranked maps. Curate the maps you actually want, preview them in-app, see your own scores on every map, and export a ready-to-play `.bplist` - all from a single self-contained HTML file.

![Playlist Studio interface](screenshot.png)

---

## Overview

Playlist Studio turns live map data into curated Beat Saber playlists. Instead of dumping every map that matches your filters, it works like a shopping cart: search, add the good ones to **Your Playlist**, reorder and cover it, then export. A **source switch** at the top of the filters chooses where you're searching - **BeatLeader** (the ranked catalog, with stars, PP and your scores) or **BeatSaver** (the whole catalog, browsable by **tags**, including unranked maps). Already know exactly which maps you want? Paste their **BSR codes** into **Quick Add** and skip searching entirely. It runs entirely in your browser as one HTML file - no install or build step, and no account.

> Scores and PP come from **BeatLeader**. You can also merge your **ScoreSaber** play history so the played and FC filters cover both leaderboards (ScoreSaber pp is shown, never mixed into BeatLeader pp). Tag browsing and Quick Add map lookups use **BeatSaver** (which is CORS-friendly, so those need no relay). Your BeatLeader score badges still show on BeatSaver-sourced maps you've played, since they match by hash.

## Features

### Two catalogs: BeatLeader & BeatSaver
A segmented **source switch** sits at the top of the filter column:

- **BeatLeader** - the ranked/scored catalog. Star ratings, PP, ranked status, and everything tied to your connected profile. Best for building ranked grind sets.
- **BeatSaver** - the entire map catalog, browsable by **tags**. Best for unranked lists, style packs, and anything not on a leaderboard.

Switching sources swaps in the relevant filters (the BeatLeader-only Star Rating / PP / Ranked-status panels give way to the **Tags** panel and BeatSaver sort) and clears the current results, but keeps your playlist. Your choice is remembered between visits. NPS, BPM, mapper, game mode, difficulty, Quick Add, covers, and export all work identically in both modes.

### Browse by tag (BeatSaver)
In BeatSaver mode, the **Tags** panel filters the whole catalog by BeatSaver's own tags - this is where **poodle / tech / midspeed** style lists come from (poodles live under the **Tech** tag). The full official tag set is here: 7 **style** tags (Tech, Speed, Dance Style, Balanced, Challenge, Accuracy, Fitness) and the complete **genre** list, plus a custom-tag box for anything else.

- Each chip is **tri-state**: click once to **require** a tag, again to **exclude** it, again to clear.
- Sort by **Rating** (the default, best-liked first), **Relevance, Curated, or Latest**, with an optional **curated-only** toggle.
- **Hide auto-lighting maps** - a one-click toggle to drop maps whose lighting was auto-generated (credited as *"Auto Lighter by …"* / *"Autolighter"*). The note maps are real; only the lighting is auto-made, so flip it on when those clutter your results.
- **Min rating and Uploaded-within filters** - set a rating floor (BeatSaver's weighted up/down score, in %) to skip poorly-rated maps, and limit to maps uploaded in the past week / month / 3 / 6 months / year to surface fresh stuff.
- Searching a **mapper** name matches the mapper only (not song/artist/description) and ignores auto-lighting credits, so you get that mapper's actual maps. There's also an **Exclude mapper(s)** box to hide any map whose mapper or artist matches.
- Combine tags with the shared **NPS / BPM / duration / mapper** filters to dial in exactly the pack you want (e.g. Tech, unranked, 7+ NPS, sorted by Rating).
- Unranked maps have no stars or PP, so those show as **UR** and the star/PP filters simply don't apply here.

### Search & filter (BeatLeader)
- **Star-rating** range and **ranked status** (ranked / unranked / nominated / qualified / all)
- **Starts at your level** - a fresh search no longer opens on the hardest maps. With your profile connected it searches your comfort-to-stretch band (worked out from your top plays); without it, it starts at 4-7★ with the easiest maps first, plus a one-tap **Start easier (0-4★)** tip for new players. Level chips (**My level**, Learning, Comfortable, Pushing, Top, All) switch the band in one click
- **Mapper** and **keyword** search
- **Game mode** - Standard, One Saber, No Arrows, 90°/360°, Lightshow, Lawless
- **Optional difficulty filter** (Easy → Expert+) - off by default so every difficulty comes through until you want to narrow it
- **NPS, duration and BPM** bounds
- **PP range** - keep only ranked maps worth a target PP at your accuracy and speed (see below)
- **Sort by** - Stars, Tech, Acc, Pass, NPS, Duration, BPM, **PP at your target accuracy** or **AccSaber complexity**, from the **Sort** bar right above the results (your plays open newest-first) or the **Search Scope & Sort** panel. A **Show** filter next to it narrows the list to ranked or unranked maps
- **Adjustable scan depth** - pull anywhere from 300 up to 20,000 maps per search (quick-pick chips: 300 / 1k / 2.5k / 5k / 10k / Max), **default 2.5k**. Bigger scans dig deeper for matches - handy for wide star ranges or "unplayed" hunts - at the cost of a longer search; drop to 300 for a quick pull
- Live client-side filtering: tweak a value and the match count updates instantly, no re-search
- Press **Enter** in any filter to search; the Search button flags when your filters have drifted from your last pull
- **Collapsible filter panels** - collapse the boxes you don't use to keep the sidebar tidy; your layout is remembered between visits

### Quick Add - by BSR code, link, or hash
Already know the maps you want? Skip searching. Paste one or more **BSR codes**, **BeatSaver links** (`beatsaver.com/maps/…`), or 40-character **map hashes** - separated by spaces or commas - and Quick Add looks each up on BeatSaver and drops it straight into **Your Playlist**. Purpose-built for **tournament pools** and shared code lists, where maps arrive as a list of `!bsr` codes rather than something you'd hunt for by filter.

### Build a playlist
- Two-panel builder: **Search Results → Your Playlist** (the playlist is what gets exported)
- Add one at a time, **Add all**, **Add top N**, or **⚄ Random**
- **Reorder** (▲▼), remove, **Shuffle**, **Sort by ★** (warmup → hard)
- **Clear playlist** empties the list and resets its name, cover and sync to a fresh start - with a one-tap **Undo clear** if you didn't mean it
- **Clear results** - a separate button that empties the results and resets your filters to defaults (your playlist is kept)
- **One row per song** - collapse duplicate difficulties to keep one entry per song
- **Hide added** - a toggle above the results that hides maps already in Your Playlist, so you only see what you haven't picked yet (great for working through a big search without re-seeing your choices). Maps drop out the moment you add them and come back if you remove them.
- **Skip maps from a playlist file** - load another `.bplist` and hide its songs from the results too, so you can build a "new stuff only" set that skips everything in a playlist you already have.
- **Fill to N min** - top up Your Playlist with maps from the current results until it reaches a target length (handy for a set of a specific duration). Respects your Hide added and Skip maps from a playlist file choices.
- Build a single playlist from several different searches
- Live totals: song count, runtime, star range + average, and average NPS

### Your scores & history (connect a BeatLeader profile)
Paste your BeatLeader profile URL or ID and Playlist Studio syncs your play history - public data, no login - so you can see and build around what you've actually played:
- **★ Build from my plays** - one button turns *every map you've played* (ranked or unranked) into the results list, with no search or import needed. Then narrow with **Your play status** (e.g. **Played, not FC**), **Near-miss FC**, or **only my accuracy below X%**, and cherry-pick the ones you want into your playlist. Perfect for "make me a set of everything I haven't full-comboed yet." (The first time, it does a quick one-off re-sync to grab the song details.)
- **Score badges on every map** - your accuracy with a green **FC** / blue **passed** / dashed **NEW** marker and your rank
- **"Your plays" filter right above the results** - one-tap chips for **All / Unplayed / Played / FC'd / Not FC / Near-FC**, so "hide everything I've already played" is a single click where you're actually looking. (Not connected yet? The bar shows a one-tap link to connect.)
- **More history filters** in the profile panel - "only my accuracy below X%", Last played, and one-tap smart lists
- **Practice context on every row** - on maps you've played, the row shows how long ago, and for ranked maps how much raw pp you'd gain by reaching your target accuracy (e.g. **+44pp at 95%**)
- **Merge your ScoreSaber plays** - **+ ScoreSaber plays** in the profile card pulls your ScoreSaber history into the same played / FC index, so the filters and Build from my plays cover both leaderboards. Charts that are on BeatLeader keep BeatLeader's data; ScoreSaber-only plays carry an **SS** tag
- **Last played** - narrow to maps you've played within the last month / 3 months / 6 months / year, or ones you *haven't* touched in **over a year** (great for rebuilding a set worth revisiting). Reads off your synced play dates and auto-disables when you're filtering for unplayed maps
- **One-tap smart lists** - Unplayed, Near-miss FC, Sub-90%
- **Sort by you** - my accuracy, my rank, date I played, or improvement potential
- **Your best in the preview** - accuracy, misses (and the would-be FC accuracy), rank, date, and a link to watch the replay
- **Playlist readout** - "you've FC'd 4 of 15 here, 91% avg"
- Scores are cached in your browser; **↻ Sync** does a fast incremental refresh afterward

### For You
Connect your profile and a **For You** card sits at the top of the results column with four one-click starts, all built on your own plays: **Top pp gains** (the PP Optimizer), **Rank-up plan** (opens the planner), **Practice set** (maps you've played but haven't FC'd) and **Revisit** (maps you haven't played in over 6 months). Not connected yet? The card offers a one-tap connect instead.

### Player stats card
**Stats** in the profile card opens your BeatLeader, ScoreSaber and AccSaber ranks side by side, with rank movement, the gap to the next player, recent scores with in-app replays, and a share link (`?stats=<id>`). **+ Add** on any recent score drops that map into Your Playlist, and **Build from top 50 plays** loads that player's best plays as results, which is handy on a friend's shared link.

### Preview before you commit
- ▶ on any row opens an in-app preview - the map rendered in [ArcViewer](https://allpoland.github.io/ArcViewer/) (notes + audio) plus a BeatSaver audio clip, with links out to BeatSaver and the full viewer.

### Maps like this

Open any map's preview and hit **Similar** to pull up ranked maps that play like it. Candidates are scored on mapper, star rating, NPS profile and the tech-vs-speed mix, then listed best match first with a match percentage, ready to add. A fast way to turn one map you love into a whole set.

### PP calculator (ranked maps)
Work out exactly what a score is worth before you grind it.

![PP calculator](pp-calc.png)

- **"What would 95% give me?"** - every ranked result and playlist row shows a raw-PP estimate for a target accuracy you set once (in the **PP Filter** panel). Unranked maps show nothing, because PP doesn't apply to them.
- **Full calculator per map** - open any map and dial in an exact accuracy (type it or tap 90 / 95 / 97 / 99 / 100). You get the raw PP plus the **pass / acc / tech** breakdown so you can see where the points come from.
- **Speed modifiers** - toggle **SS** (Slower), **FS** (Faster) or **SF** (Super Fast). BeatLeader re-rates a map at each speed, so the calculator swaps in that speed's pass/acc/tech ratings: FS/SF push the rating (and the PP) up, SS pulls it down. Modifiers a map isn't rated for are greyed out.
- **Accuracy reference row** - a quick 90 → 100% PP ladder for the selected speed, so you can eyeball how much each extra tenth of a percent is worth.
- **Sort by PP** - set **Sort by** to **PP @ target acc** to rank the whole result set by earning potential.

### Filter by PP

![PP filter](pp-filter.png)

The **PP Filter** panel turns all of that into a real filter - "only show me maps worth grinding."

- Set your **target accuracy** and **speed** once (No modifier / SS / FS / SF), then give a **PP range** - a minimum, a maximum, or both. Only ranked maps whose estimated raw PP lands in that band survive; unranked maps drop out while a bound is set.
- That same accuracy and speed drive the **≈pp badge** on every row (shown once your profile is connected or the PP Filter is open) and the **PP sort**, so what you filter on is exactly what you see - flip to **FS** and the whole list re-evaluates at Faster Song, badges and all.
- A map that isn't rated for the chosen speed is skipped by the range filter (it has no PP at that speed to compare).
- The PP range, accuracy, and speed all save into **filter presets**, so "6★+ tech that pays ≥300pp at 96% FS" is one click away next time.

The math mirrors BeatLeader's server exactly: `passPP = 15.2·e^(passRating^(1/2.62)) − 30`, `accPP = curve(acc)·accRating·34`, `techPP = e^(1.9·acc)·1.08·techRating`, summed and inflated (`650·x^1.3 / 650^1.3`). It reports **raw (unweighted) PP** - the value of the play itself, before your profile's weighting.

### Rank-Up Planner (ranked grinders)

Tell it a goal - a flat PP gain, or a target total PP - and Playlist Studio works out the fewest ranked maps that get you there. It learns your accuracy curve the same way the PP Optimizer does, projects the weighted PP each map would add, and greedily picks the most efficient set until the goal is met. You get a projected new total PP and an estimated new global rank, the exact maps with their individual PP gains, and a one-tap **Add all** into Your Playlist. Needs your BeatLeader profile connected. The rank figure is an estimate; the PP math mirrors BeatLeader's weighting exactly.

### AccSaber pools
The **AccSaber Pools** panel loads every ranked AccSaber chart straight from AccSaber, with its category (True Acc, Standard, Tech) and complexity, easiest first. Pick a category, then use the **Your plays** chips to find the charts you haven't played or FC'd and add them.

### Covers & export
- Auto-generated neon cover art - **25 procedural styles and 13 accent palettes**, picked from a live thumbnail grid - drawn from your title and star range. The styles include a set of **Beat Saber–themed** designs: **Note Cubes**, **Saber Slash**, **Bombs**, **Obstacles**, **Note Highway**, **Cut Spark** and **Saber Trails**, alongside the abstract neon ones (Pulse, Grid, Waveform, Spectrum, Vortex, Aurora, and more).
- **Title + subtitle overlay** with adjustable **text position** (Bottom / Center / Off) and **text color** (White / Black / Gold / Green / Blue / Red). The legibility scrim flips automatically - dark behind light text, light behind dark - so the title stays readable on any art.
- **Shuffle art** reshuffles the pattern for a fresh take on the same style.
- **Custom images** - upload your own cover and your title/subtitle overlays it exactly like the generated ones. Every image you upload is saved to a reusable **icon library** so you can reapply it to other playlists (click to reuse, one tap to remove).
- **Covers travel with playlists** - save a playlist and its cover comes back with it on load, whether it's a procedural design or your own uploaded image.
- Exports a spec-compliant `.bplist`: PascalCase difficulty names, embedded Base64 cover, difficulties merged per song, and your play order preserved.

### Save, reload & import
- **Filter presets** - save filter combos you reuse (e.g. "6★ tech warmup")
- **Playlist Library** - save and reload whole playlists (cover included)
- **Smart playlists** - save the results you built (a search, your plays, top plays, PP gains or an AccSaber pool) as a recipe. **Rebuild** refills Your Playlist from fresh results with the same filters and sort, and if the playlist is hosted it pushes the update so your headset's Sync picks it up
- **Gallery** - **Browse the gallery** loads ready-made playlists in one click: three starter lists for new players (BeatSaver's best-rated maps, each set to an easy, medium or harder difficulty) and the official AccSaber pools, all pulled live so they're never stale. New players also get a link to it from the empty results
- **Library backup** - **Back up library** downloads every saved playlist, preset, smart playlist and saved icon as one file; **Restore backup** merges it back on any computer without overwriting anything
- **Session autosave** - an accidental refresh won't lose your work in progress
- **Import `.bplist`** - open an existing playlist to edit it; covers stored as either a data URI *or* raw base64 both load, for broad compatibility with community playlists
- **BeatLeader enrichment** - `↻ Fill data` fills in stars / NPS / duration / cover for imported songs by hash; `★ Re-check` re-checks every song in the playlist to catch rating recalcs

### Refine an imported (or built) playlist
Import a big list, then prune it down in place - no spreadsheet, no re-adding maps one by one. The **Refine Playlist** panel runs bulk actions on whatever's in **Your Playlist**, using the same play-history definitions as the search filters.

- **Quick actions** - one tap each: **Remove played**, **Remove FC'd**, **Keep unplayed**, **Keep near-FC**. "Import my playlist, drop everything I've already played, re-export" is a single click.
- **Any criterion, two directions** - pick a criterion and either **Remove matching** or **Keep only matching**:
  - *Play history* - played / unplayed / FC'd / played-but-not-FC / near-miss FC / my accuracy ≥ or < a threshold / not played in over a year.
  - *Difficulty* - star rating inside a min–max range (trim a mixed list down to one band).
- **Live preview** before you commit - "Matches 12 of 80 - Remove leaves 68, Keep leaves 12" - so you always see the result first.
- **One-tap Undo** restores the playlist exactly as it was if a prune wasn't what you wanted.
- Play-history tools need your BeatLeader profile connected (the panel says so and disables them until it is); the star-range tool works on any map with a rating - run `↻ Fill data` first if imported maps show no stars.

Typical uses: refresh a grind list by dropping everything you've now FC'd, thin a huge import down to just unplayed maps, keep only your sub-90% plays to practice, prune stale maps you haven't touched in a year, or cut a 10★ playlist down to the 7–8★ band.

### Playlist stats

A collapsible **Playlist Stats** panel gives you a quick read on the shape of whatever is in Your Playlist: song count, total runtime, average stars, average PP and mapper count, plus a star-rating histogram, an NPS spread curve, and a tech-vs-speed balance bar. All computed in your browser from the maps you have added, with no extra calls.

### Session Ramp

**Session Ramp** reorders Your Playlist into a smooth difficulty climb, so a set plays like a real practice session instead of a random pile. Order by stars or NPS, choose warmup-to-peak or peak-to-cooldown, see a live preview of the curve, and apply it in one tap.

### In-game sync (optional)
Keep a playlist you host online, and refresh it inside Beat Saber with [PlaylistManager](https://github.com/rithik-b/PlaylistManager)'s **Sync** button - no re-importing. This writes a `syncURL` into the exported file's `customData`; when the mod sees it, the playlist gets a Sync button that re-downloads the file from your address. **Off by default** - it lives in its own **In-Game Sync** panel and does nothing unless you turn it on.

- **Your own host, or Studio's.** Paste your own address and nothing is uploaded - the app only writes the address you paste. Or hit **Host this playlist** and Studio keeps a copy for you and fills in the address (see *Hosted sync* below).
- **One box** - turn the panel on and paste the URL your `.bplist` will live at (e.g. `https://mysite.com/playlists/mix.bplist`). Whatever you type goes straight into `customData.syncURL`; a live hint confirms it's a valid link.
- **Round-trips on import** - open a `.bplist` that already has a `syncURL` and the box fills itself back in.
- Your URL is remembered in your browser, so re-publishing is just: edit → export → re-upload to the same spot.

> The URL must point at the **raw file** (not a web page) and stay constant. If you move or rename the hosted file later, existing copies stop syncing - keep the same path and just overwrite the file to push an update.

#### Hosted sync
No website? Turn on **In-Game Sync** and hit **Host this playlist**. Studio stores a copy on the Playlist Studio relay and writes its address into the file. Load the file on your headset once, then the in-game **Sync** button pulls every update. **Update hosted copy** pushes changes and **Stop hosting** deletes it. Each hosted playlist has a private edit key kept in your browser (and in library backups). Lists expire 180 days after their last update unless a headset keeps syncing them.

### Share by link

Pack your whole playlist into a single link with **Share Playlist**. The maps, title and author are encoded straight into the URL, so there is no hosting and no account - anyone who opens the link imports the set instantly. Great for tournament pools and sending a playlist to a friend. Paste a shared link into the import box to load it, and opening a share link loads the maps and then tidies the URL.

### Made for mobile too
- A fixed bottom **tab bar** - **Filters / Results / Playlist** with live count badges - switches between the three views so you're not scrolling one endless column. A search jumps you straight to **Results**, the **Search** button floats within easy reach while you filter, touch targets are enlarged, and map previews go full-screen.
- The desktop two-column layout is untouched; the mobile treatment only kicks in on small screens.

### Beat Saber flair
- Subtle ambient neon - note cubes and saber-light drift behind the app, the logo crosses its sabers on load, a saber **slash** sweeps across on every search, and adding a map gives a satisfying count-up and pop. The Search button and logo carry a slow idle glow.
- Everything is smooth with **no flashing or strobing**, there's a **one-tap toggle** in the top bar to turn it all off, and it automatically stays off if your device has *reduce motion* enabled.

### Clear feedback while it works
- Long scans are impossible to miss: the Search Results panel shows a Beat Saber equalizer with a **live "N of M maps" counter** and a progress bar, a slim neon bar sweeps across the top of the page, and the Search icon spins until the pull completes.

## Getting started

**Just open it.** Download **`index.html`** and open it in any modern browser (Chrome, Edge or Firefox). It's fully self-contained - the styles, cover generator, exporter and app logic are all inlined.

**Or host it on GitHub Pages.** Enable Pages for this repo (*Settings → Pages → deploy from `main`*) and open `https://<user>.github.io/<repo>/`. It works the same; the public relay pool handles CORS.

## How the connection works

BeatLeader's API doesn't send cross-origin CORS headers, so a browser can't call it directly from a file or a third-party site - it fails with *"Failed to fetch."* Playlist Studio gets around this by routing read-only public requests through a **pool of public CORS relays**, racing them and using the first that responds. Dead or slow relays are dropped automatically, and there's nothing to configure.

The relay is a small Cloudflare Worker (`relay-worker.js` in this repo). It only proxies BeatLeader, BeatSaver and ScoreSaber, and it also serves hosted playlists once a KV namespace is bound to it; the deploy steps are at the top of the file. AccSaber sends CORS headers, so the AccSaber pools and stats call it directly.

If you run your own CORS relay and would rather use it, point the app at it under **Search Scope & Sort → Advanced: custom relay**. (Map previews use BeatSaver and ArcViewer directly - both are CORS-friendly, so they need no relay.)

**BeatSaver mode needs no relay at all.** BeatSaver *does* send CORS headers, so tag searches (and Quick Add lookups) call it directly from your browser - which is why the whole relay/connection section disappears when you switch to the BeatSaver source.

## Installing a playlist in Beat Saber

1. Export the `.bplist` from Playlist Studio.
2. Drop it into your Beat Saber `Playlists` folder - on PC that's usually `…\Steam\steamapps\common\Beat Saber\Playlists\`.
3. In-game, refresh your song list. The [PlaylistManager](https://github.com/rithik-b/PlaylistManager) mod loads the playlist. The file lists the songs but doesn't contain them, so open the playlist and use PlaylistManager's download button to grab any you don't have.

New to mods? The [BSMG wiki](https://bsmg.wiki/) walks you through installing them on PC and Quest.

### On Quest
Switch the Export panel to **Quest** and hit **Send to Quest**. Plug the headset into your computer with a USB cable and use Chrome or Edge. The first time, put the headset on after you pick it and accept **Allow USB debugging?** (tick **Always allow from this computer**). The browser gets its own approval, separate from SideQuest or adb, so it shows up once even if those already work. Studio finds your PlaylistManager folder, writes the playlist there and lets go of the headset afterwards so SideQuest and adb keep working. If it says the headset hasn't answered, another tab or app that talks to the Quest (HSV Config Generator, MBF, SideQuest, adb) is holding the connection: close it, unplug and replug the cable, and try again. Restart Beat Saber to see a new playlist. Prefer SideQuest? Download the `.bplist` and copy it to `ModData/com.beatgames.beatsaber/Mods/PlaylistManager/Playlists` on the headset.

### Keeping a playlist in sync

Want the playlist to update itself in-game whenever you change it? Turn on the **In-Game Sync** panel before exporting (see *In-game sync* above):

No hosting of your own? Use **Host this playlist** instead of steps 1 and 2.

1. Pick where you'll host the file and let the helper build the `syncURL`, then export.
2. Upload the exported `.bplist` to that address.
3. Import it into the game once (steps above). PlaylistManager now shows a **Sync** button on that playlist.
4. To push a change later: edit it in Playlist Studio, re-export, and overwrite the file at the **same** address. Hit **Sync** in-game to pull it - the playlist (songs, title, cover) updates in place.

## Privacy

- No account and no cookies. Page views are counted with [GoatCounter](https://www.goatcounter.com/), a privacy-friendly counter that stores no personal data.
- Presets, saved playlists, smart playlists, saved cover icons, your working session, and your connected profile + synced scores are all stored in your browser's local storage. Nothing is uploaded unless you choose **Host this playlist**, which stores that one playlist (songs, title, cover) on the Playlist Studio relay until you hit **Stop hosting** or it expires.
- API requests hit BeatLeader, BeatSaver, ScoreSaber and AccSaber (public data), with BeatLeader and ScoreSaber going through the relay. Only anonymous, read-only requests are sent, apart from hosting a playlist when you ask for it.
- **Send to Quest** talks to your headset over USB straight from your browser; the playlist never leaves your computer.

## Built with

Vanilla HTML, CSS and JavaScript - no framework and no build tooling. The single `index.html` inlines the stylesheet, the canvas cover generator, the `.bplist` exporter, and the application logic.

- Map data - [BeatLeader](https://api.beatleader.xyz) (ranked catalog, scores, PP) and [BeatSaver](https://beatsaver.com) (full catalog, tags)
- Map previews - [BeatSaver](https://beatsaver.com) + [ArcViewer](https://github.com/allpoland/ArcViewer)
- Export format - [PlaylistManager](https://github.com/rithik-b/PlaylistManager)
- Extra stats and history - [ScoreSaber](https://scoresaber.com) and [AccSaber](https://accsaber.com)
- Quest transfer - [ya-webadb](https://github.com/yume-chan/ya-webadb) (adb 2.6.4, adb-daemon-webusb 2.3.2, adb-credential-web 2.1.0), built into the page as one matched release

## Adding gallery entries

The gallery reads `gallery/index.json`. Each entry has a `name`, a `description`, an optional `author` and `tags`, and one source: `"type": "url"` with a live `.bplist` link (the host must allow CORS), `"type": "file"` with a `.bplist` saved in the `gallery/` folder, `"type": "share"` with a Playlist Studio share code, or `"type": "beatsaver"` to build a live list from a BeatSaver search: `query` holds the search parameters (for example `{"sortOrder": "Rating", "curated": true}`), `pick` the notes-per-second window used to choose one Standard difficulty per map (`{"minNps": 1.5, "maxNps": 3.5}`), and `count` how many maps to take.

## More tools

Other free, single-file Beat Saber tools by MSploit:

- **[ReeSaber Studio](https://spanky3651.github.io/ReeSaber-Studio/?utm_source=github&utm_campaign=readme-playlist-studio)** - A visual preset editor for the ReeSabers mod, with a live 3D preview and `.json` / `.reesaber` export.
- **[HSV Config Generator](https://spanky3651.github.io/HSV-Config-Generator/?utm_source=github&utm_campaign=readme-playlist-studio)** - A visual editor and live simulator for HitScoreVisualizer configs, with push-to-Quest over USB.

## Credits

Made by **MSploit** - [BeatLeader profile](https://beatleader.com/u/76561199153577883)

Not affiliated with Beat Games, BeatLeader or BeatSaver.

## License

Released under the [MIT License](LICENSE).
