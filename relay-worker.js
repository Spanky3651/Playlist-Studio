/*
 * Playlist Studio - CORS relay + hosted playlists (Cloudflare Worker)
 * --------------------------------------------------------------------
 * 1) RELAY  (/?url=...)
 *    BeatLeader's API sends no CORS headers, so a browser can't call it directly.
 *    This Worker fetches the API server-side and adds the CORS header the browser
 *    needs. It only proxies the hosts this app needs (BeatLeader, BeatSaver,
 *    ScoreSaber), so it can't be abused as an open proxy.
 *
 * 2) HOSTED PLAYLISTS  (/pub, /p/<id>.bplist)
 *    "Host this playlist" in Studio stores a copy here and writes its address into
 *    the .bplist as customData.syncURL, so PlaylistManager's in-game Sync button can
 *    pull updates without the player hosting anything. Needs a KV namespace bound
 *    as PLAYLISTS. Without that binding the relay keeps working and Studio simply
 *    hides the hosted option.
 *
 *    POST   /pub          create   -> { id, key, url }   (key is the private edit key)
 *    PUT    /pub/<id>     update   (header X-Edit-Key)
 *    DELETE /pub/<id>     delete   (header X-Edit-Key)
 *    GET    /p/<id>.bplist           the playlist file PlaylistManager syncs from
 *    GET    /pub/health              { ok: true } when hosting is set up
 *
 *    Guard rails: writes only from Studio's site, 2 MB max per playlist, songs are
 *    re-built from known fields only (nothing arbitrary is stored), edit keys are
 *    stored as SHA-256 hashes, a per-IP write limit, and lists expire 180 days after
 *    their last update unless a headset keeps syncing them.
 *
 * DEPLOY (dashboard, no command line):
 *   1. Workers & Pages -> KV -> Create a namespace, e.g. "playlist-studio-hosted".
 *   2. Open this Worker -> Settings -> Bindings -> Add -> KV namespace.
 *      Variable name: PLAYLISTS   Namespace: the one from step 1. Save.
 *   3. Edit code -> paste THIS whole file -> Deploy.
 *   4. Check https://<your-worker>.workers.dev/pub/health shows {"ok":true}.
 *   Optional: a Workers Rate Limiting binding named WRITE_LIMITER (set up with
 *   wrangler) replaces the built-in best-effort limit with a global one.
 */
const RELAY_HOSTS = ["api.beatleader.xyz", "api.beatsaver.com", "scoresaber.com"];
const WRITE_ORIGINS = ["https://spanky3651.github.io"];
const MAX_BYTES = 2000000;
const MAX_SONGS = 3000;
const TTL = 60 * 60 * 24 * 180;            // seconds a list lives after its last update
const REFRESH_AFTER = 60 * 60 * 24 * 90;   // a list still being synced gets its clock reset after this
const WRITE_LIMIT = 30, WRITE_WINDOW = 600; // writes per IP per 10 minutes (per Worker instance)
const writes = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/pub" || url.pathname.startsWith("/pub/") || url.pathname.startsWith("/p/")) {
      try { return await hosted(request, env, ctx, url); }
      catch (e) { return json({ error: "Server error" }, 500, writeCors(request)); }
    }
    return relay(request, url);
  },
};

// ---------------------------------------------------------------- relay
async function relay(request, url) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  const target = url.searchParams.get("url");
  if (!target) return new Response("Missing ?url=", { status: 400, headers: cors });

  let t;
  try { t = new URL(target); } catch (e) { return new Response("Bad url", { status: 400, headers: cors }); }

  // Allowlist so this can never be used as a general-purpose open proxy.
  if (!RELAY_HOSTS.includes(t.hostname)) {
    return new Response("Host not allowed: " + t.hostname, { status: 403, headers: cors });
  }

  let upstream;
  try {
    upstream = await fetch(t.toString(), { headers: { "User-Agent": "PlaylistStudioRelay" } });
  } catch (e) {
    return new Response("Upstream fetch failed: " + e, { status: 502, headers: cors });
  }

  const headers = new Headers(cors);
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
  headers.set("Cache-Control", "public, max-age=60");
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------- hosted playlists
function originOk(request) {
  const o = request.headers.get("Origin") || "";
  return WRITE_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
function writeCors(request) {
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Edit-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (originOk(request)) h["Access-Control-Allow-Origin"] = request.headers.get("Origin");
  return h;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) });
}
function nowSec() { return Math.floor(Date.now() / 1000); }

async function hosted(request, env, ctx, url) {
  const path = url.pathname;

  // Public read: what PlaylistManager downloads.
  if (path.startsWith("/p/")) {
    const read = { "Access-Control-Allow-Origin": "*" };
    if (request.method === "OPTIONS") return new Response(null, { headers: read });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, read);
    if (!env.PLAYLISTS) return json({ error: "Hosting is not set up" }, 503, read);
    const id = path.slice(3).replace(/\.bplist$/i, "");
    if (!/^[A-Za-z0-9]{6,16}$/.test(id)) return json({ error: "Not found" }, 404, read);
    const rec = await env.PLAYLISTS.get("pl:" + id, "json");
    if (!rec || !rec.body) return json({ error: "Not found" }, 404, read);
    // A list a headset still syncs should not expire: reset its clock now and then (one write per ~90 days).
    if (nowSec() - (rec.seen || rec.updated || 0) > REFRESH_AFTER) {
      rec.seen = nowSec();
      const put = env.PLAYLISTS.put("pl:" + id, JSON.stringify(rec), { expirationTtl: TTL });
      if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    }
    return new Response(rec.body, { headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }, read) });
  }

  const cors = writeCors(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (path === "/pub/health" && request.method === "GET") {
    return json({ ok: !!env.PLAYLISTS }, 200, Object.assign({}, cors, { "Access-Control-Allow-Origin": "*" }));
  }
  if (!env.PLAYLISTS) return json({ error: "Hosting is not set up" }, 503, cors);
  if (!originOk(request)) return json({ error: "Writes are only accepted from Playlist Studio" }, 403, cors);
  if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);

  if (path === "/pub" && request.method === "POST") {
    const pl = await readPlaylist(request);
    if (pl.error) return json({ error: pl.error }, 400, cors);
    const id = randomId(10), key = randomHex(24);
    const out = finalize(pl.value, url.origin, id);
    await env.PLAYLISTS.put("pl:" + id, JSON.stringify({ hk: await sha256(key), body: out, updated: nowSec() }), { expirationTtl: TTL });
    return json({ id, key, url: url.origin + "/p/" + id + ".bplist" }, 201, cors);
  }

  const m = path.match(/^\/pub\/([A-Za-z0-9]{6,16})$/);
  if (!m) return json({ error: "Not found" }, 404, cors);
  const id = m[1];
  const rec = await env.PLAYLISTS.get("pl:" + id, "json");
  if (!rec) return json({ error: "Not found" }, 404, cors);
  const key = request.headers.get("X-Edit-Key") || "";
  if (!key || !safeEqual(await sha256(key), rec.hk)) return json({ error: "Wrong edit key" }, 403, cors);

  if (request.method === "PUT") {
    const pl = await readPlaylist(request);
    if (pl.error) return json({ error: pl.error }, 400, cors);
    const out = finalize(pl.value, url.origin, id);
    await env.PLAYLISTS.put("pl:" + id, JSON.stringify({ hk: rec.hk, body: out, updated: nowSec() }), { expirationTtl: TTL });
    return json({ id, url: url.origin + "/p/" + id + ".bplist" }, 200, cors);
  }
  if (request.method === "DELETE") {
    await env.PLAYLISTS.delete("pl:" + id);
    return new Response(null, { status: 204, headers: cors });
  }
  return json({ error: "Method not allowed" }, 405, cors);
}

async function allowWrite(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.WRITE_LIMITER && env.WRITE_LIMITER.limit) {
    try { const r = await env.WRITE_LIMITER.limit({ key: ip }); return !!r.success; } catch (e) { /* fall through */ }
  }
  const t = nowSec(), list = (writes.get(ip) || []).filter((x) => t - x < WRITE_WINDOW);
  if (list.length >= WRITE_LIMIT) { writes.set(ip, list); return false; }
  list.push(t); writes.set(ip, list);
  if (writes.size > 5000) writes.clear();
  return true;
}

// Parse and re-build the playlist from known fields only.
async function readPlaylist(request) {
  const len = +(request.headers.get("Content-Length") || 0);
  if (len > MAX_BYTES) return { error: "Playlist is too large (2 MB max - try a smaller cover image)" };
  const text = await request.text();
  if (text.length > MAX_BYTES) return { error: "Playlist is too large (2 MB max - try a smaller cover image)" };
  let p;
  try { p = JSON.parse(text); } catch (e) { return { error: "Not valid JSON" }; }
  if (!p || typeof p !== "object" || !Array.isArray(p.songs)) return { error: "Not a playlist" };
  if (!p.songs.length || p.songs.length > MAX_SONGS) return { error: "A playlist needs 1 to " + MAX_SONGS + " songs" };
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const songs = [];
  for (const s of p.songs) {
    if (!s || typeof s !== "object" || !/^[0-9a-fA-F]{40}$/.test(String(s.hash || ""))) return { error: "Every song needs a 40-character map hash" };
    const song = { hash: String(s.hash), songName: str(s.songName, 300), levelAuthorName: str(s.levelAuthorName, 200) };
    if (s.key) song.key = str(String(s.key), 16);
    if (Array.isArray(s.difficulties)) {
      song.difficulties = s.difficulties.slice(0, 10)
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ characteristic: str(x.characteristic, 40), name: str(x.name, 20) }));
    }
    songs.push(song);
  }
  const image = typeof p.image === "string" && /^(data:image\/(png|jpe?g|webp|gif);base64,)?[A-Za-z0-9+/=\s]*$/.test(p.image) ? p.image : "";
  return { value: {
    playlistTitle: str(p.playlistTitle, 200) || "Playlist Studio Mix",
    playlistAuthor: str(p.playlistAuthor, 100),
    playlistDescription: str(p.playlistDescription, 4000),
    image,
    songs,
  } };
}
function finalize(pl, origin, id) {
  pl.customData = { generator: "Playlist Studio", hosted: true, songCount: pl.songs.length, syncURL: origin + "/p/" + id + ".bplist" };
  return JSON.stringify(pl);
}

function randomId(n) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = ""; for (const x of b) s += abc[x % abc.length]; return s;
}
function randomHex(n) { return Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, "0")).join(""); }
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
