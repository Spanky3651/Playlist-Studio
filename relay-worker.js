const RELAY_HOSTS = ["api.beatleader.xyz", "api.beatsaver.com", "scoresaber.com"];
const WRITE_ORIGINS = ["https://spanky3651.github.io"];
const MAX_BYTES = 2000000;
const MAX_SONGS = 3000;
const TTL = 60 * 60 * 24 * 180;            // seconds a list lives after its last update
const REFRESH_AFTER = 60 * 60 * 24 * 90;   // a list still being synced gets its clock reset after this
const WRITE_LIMIT = 30, WRITE_WINDOW = 600; // writes per IP per 10 minutes (per Worker instance)
// Requests made with a library key (Studio Sync): editing a headset playlist autosaves after every change,
// so these get more room than anonymous hosting.
const LIB_WRITE_LIMIT = 150;
const writes = new Map();
const LIB_TTL = 60 * 60 * 24 * 365;          // a library or device nobody touches for a year goes away
const CODE_TTL = 600;                        // pairing codes live 10 minutes
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_LIB_ITEMS = 60, MAX_DEVICES = 8;
const MAX_INVENTORY = 400, MAX_HEADSET_BYTES = 2500000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/lib" || url.pathname.startsWith("/lib/") || url.pathname.startsWith("/link/")) {
      try { return await linked(request, env, ctx, url); }
      catch (e) { return json({ error: "Server error" }, 500, libCors(request)); }
    }
    if (url.pathname === "/pub" || url.pathname.startsWith("/pub/") || url.pathname.startsWith("/p/")) {
      try { return await hosted(request, env, ctx, url); }
      catch (e) { return json({ error: "Server error" }, 500, writeCors(request)); }
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      try { return await admin(request, env, url); }
      catch (e) { return json({ error: "Server error" }, 500, { "Cache-Control": "no-store" }); }
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

async function allowWrite(request, env, bucket, limit) {
  const ip = (bucket ? bucket + ":" : "") + (request.headers.get("CF-Connecting-IP") || "unknown");
  if (env.WRITE_LIMITER && env.WRITE_LIMITER.limit) {
    try { const r = await env.WRITE_LIMITER.limit({ key: ip }); if (!r.success) return false; if (!bucket) return true; } catch (e) { /* fall through */ }
  }
  const t = nowSec(), list = (writes.get(ip) || []).filter((x) => t - x < WRITE_WINDOW);
  if (list.length >= (limit || WRITE_LIMIT)) { writes.set(ip, list); return false; }
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

// ---------------------------------------------------------------- linked headsets
function libCors(request) {
  const h = writeCors(request);
  h["Access-Control-Allow-Headers"] = "Content-Type, X-Lib-Key, Authorization, X-Studio-Player";
  h["Access-Control-Expose-Headers"] = "X-Studio-Version";
  return h;
}
function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/);
  return m ? m[1] : "";
}
async function readJson(request, max) {
  const text = await request.text();
  if (text.length > (max || 20000)) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch (e) { return null; }
}
function randomCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  let s = ""; for (const x of b) s += CODE_ABC[x % CODE_ABC.length]; return s;
}
function cleanName(v) { return (typeof v === "string" ? v : "").replace(/[^\w .'()-]/g, "").trim().slice(0, 40) || "Quest"; }
function putLib(env, id, lib) { return env.PLAYLISTS.put("lib:" + id, JSON.stringify(lib), { expirationTtl: LIB_TTL }); }
async function fileKey(file) { return (await sha256("f:" + file)).slice(0, 16); }
function validFile(f) { return typeof f === "string" && f.length > 0 && f.length <= 200 && !/[\\/\u0000]/.test(f) && f !== "." && f !== ".." && /\.(bplist|json)$/i.test(f); }
function invKey(lib, dev) { return "inv:" + lib + ":" + dev; }
function outKey(lib, dev) { return "out:" + lib + ":" + dev; }
// A headset's "done" for one pending write lives under its own key. KV has no transactions, so if acks
// rewrote the shared list, two at once (or an ack and a send from Studio) could undo each other.
function ackKey(lib, dev, id) { return "outa:" + lib + ":" + dev + ":" + id; }
// When a headset last checked in, kept apart from the library so it can be fresher than the hourly copy there.
// The player's own order for a headset's playlists (playlist keys, top first), set from Studio's "My order".
function ordKey(lib, dev) { return "ord:" + lib + ":" + dev; }
function seenKey(lib, dev) { return "seen:" + lib + ":" + dev; }
// Headset storage the mod reports (0.8.0 and later): song counts and sizes, free space, versions.
function statKey(lib, dev) { return "stat:" + lib + ":" + dev; }
// A song clean up asked for in Studio and waiting for the headset, and what the last one did.
function clnKey(lib, dev) { return "cln:" + lib + ":" + dev; }
function clnrKey(lib, dev) { return "clnr:" + lib + ":" + dev; }
// Get missing songs asked for in Studio (0.9.0 and later) and what the last one did, like clean up.
function gmKey(lib, dev) { return "gm:" + lib + ":" + dev; }
function gmrKey(lib, dev) { return "gmr:" + lib + ":" + dev; }
// Per-playlist auto-download switches changed in Studio and waiting for the headset: { t, set: { key: on } }.
function adlKey(lib, dev) { return "adl:" + lib + ":" + dev; }
// When Studio last queued anything for a headset (ms). The mod checks it every minute in the menu (/link/ping,
// one read) and only runs a full sync when it moved, so changes show up without going back to the main menu.
function chgKey(lib, dev) { return "chg:" + lib + ":" + dev; }
function touch(env, lib, dev) { return putTtl(env, chgKey(lib, dev), String(Date.now())); }
const FEATURES = ["restore", "delete", "delete-songs", "storage", "cleanup", "order", "missing", "autodl"];
function bytesField(v) { return Number.isSafeInteger(v) && v >= 0 ? Math.min(v, 1e15) : -1; }
function countField(v) { return Number.isInteger(v) && v >= 0 ? Math.min(v, 1e7) : 0; }
function cleanStats(b) {
  return { songs: countField(b.songs), songBytes: bytesField(b.songBytes), loose: countField(b.loose), looseBytes: bytesField(b.looseBytes),
    looseFav: countField(b.looseFav), looseFavBytes: bytesField(b.looseFavBytes), wip: countField(b.wip), wipBytes: bytesField(b.wipBytes),
    total: bytesField(b.total), free: bytesField(b.free),
    mod: String(b.mod || "").replace(/[^\w.-]/g, "").slice(0, 20), game: String(b.game || "").replace(/[^\w.-]/g, "").slice(0, 30), at: nowSec(),
    ...(Number.isInteger(b.missing) ? { missing: countField(b.missing), missingBy: (Array.isArray(b.missingBy) ? b.missingBy : []).slice(0, 300)
      .filter((e) => Array.isArray(e) && validFile(e[0]) && Number.isInteger(e[1]) && e[1] > 0).map((e) => [e[0], Math.min(e[1], 100000)]) } : {}) };
}
async function withSeen(env, lib, devices) {
  const seen = await Promise.all(devices.map((d) => env.PLAYLISTS.get(seenKey(lib, d.id))));
  return devices.map((d, i) => Object.assign({}, d, { seen: Math.max(d.seen || 0, +seen[i] || 0) }));
}
async function liveOut(env, lib, dev, items) {
  const done = await Promise.all(items.map((w) => env.PLAYLISTS.get(ackKey(lib, dev, w.id))));
  return items.filter((w, i) => done[i] === null);
}
function putTtl(env, k, v) { return env.PLAYLISTS.put(k, typeof v === "string" ? v : JSON.stringify(v), { expirationTtl: LIB_TTL }); }
function looksLikePlaylist(text) {
  try { const p = JSON.parse(text); return !!(p && typeof p === "object" && Array.isArray(p.songs)); } catch (e) { return false; }
}
const MAX_MOVED = 30, MAX_DELETED = 30;
// Maps (each difficulty counts) when the mod reports them (0.6.2 and later), next to the song count.
function mapsField(v) { return Number.isInteger(v) && v >= 0 ? { maps: Math.min(1000000, v) } : {}; }
// Songs only this playlist uses on the headset (downloaded, not favorites), when the mod reports it (0.7.0 and later).
function soloField(v) { return Number.isInteger(v) && v >= 0 ? { solo: Math.min(100000, v) } : {}; }
// Backups the headset reports for one playlist: [{ t: unix seconds, count: songs or -1, maps? }], newest first.
function cleanBackups(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((b) => b && Number.isSafeInteger(b.t) && b.t > 0 && b.t < 1e11).slice(0, 5).map((b) => Object.assign({ t: b.t, count: Number.isInteger(b.count) ? Math.max(-1, Math.min(100000, b.count)) : -1 }, mapsField(b.maps)));
}
// A playlist's version: its maps (song + characteristic + difficulty, in any order), the same thing Studio compares.
// Studio and upload.ps1 send the version they started from (?base=); a send made from an older one gets 409, so
// an edit can't silently replace one made meanwhile somewhere else. The headset's copy after it applies a send has
// the same version as the send, so applying never looks like a change.
async function plVersion(pl) {
  if (typeof pl === "string") { try { pl = JSON.parse(pl); } catch (e) { return ""; } }
  if (!pl || !Array.isArray(pl.songs)) return "";
  const o = new Set();
  for (const sg of pl.songs) {
    if (!sg || !sg.hash) continue;
    const h = String(sg.hash).toLowerCase(), ds = Array.isArray(sg.difficulties) ? sg.difficulties : [];
    if (!ds.length) o.add(h + "|*");
    for (const d of ds) if (d) o.add(h + "|" + String(d.characteristic || "Standard").toLowerCase() + "|" + String(d.name || "").toLowerCase());
  }
  return (await sha256("v1:" + [...o].sort().join(","))).slice(0, 16);
}
function publicDevices(lib) { return (lib.devices || []).map((d) => ({ id: d.id, name: d.name, added: d.added, seen: d.seen || 0 })); }

async function linked(request, env, ctx, url) {
  const path = url.pathname, cors = libCors(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!env.PLAYLISTS) return json({ error: "Hosting is not set up" }, 503, cors);

  // ---- headset side (no Origin; authenticated by its own token) ----
  if (path.startsWith("/link/")) {
    const token = bearer(request);
    if (!token) return json({ error: "Missing device token" }, 401, cors);
    const th = await sha256(token);

    if (path === "/link/start" && request.method === "POST") {
      if (!(await allowWrite(request, env, "start", 10))) return json({ error: "Too many link attempts - wait a few minutes" }, 429, cors);
      const body = (await readJson(request, 2000)) || {};
      let code = "";
      for (let i = 0; i < 5 && !code; i++) { const c = randomCode(); if (!(await env.PLAYLISTS.get("code:" + c))) code = c; }
      if (!code) return json({ error: "Try again" }, 503, cors);
      await env.PLAYLISTS.put("code:" + code, JSON.stringify({ th, name: cleanName(body.name), at: nowSec() }), { expirationTtl: CODE_TTL });
      return json({ code, expiresIn: CODE_TTL, interval: 5 }, 200, cors);
    }

    if (path === "/link/status" && request.method === "GET") {
      const dev = await env.PLAYLISTS.get("dev:" + th, "json");
      if (dev) return json({ status: "linked" }, 200, cors);
      const code = (url.searchParams.get("code") || "").toUpperCase();
      const rec = /^[A-Z0-9]{6}$/.test(code) ? await env.PLAYLISTS.get("code:" + code, "json") : null;
      return json({ status: rec && rec.th === th ? "waiting" : "expired" }, 200, cors);
    }

    const dev = await env.PLAYLISTS.get("dev:" + th, "json");
    // The mod's once-a-minute check while in the menu: two reads, no writes.
    if (path === "/link/ping" && request.method === "GET") {
      if (!dev) return json({ error: "unlinked" }, 401, cors);
      const chg = +(await env.PLAYLISTS.get(chgKey(dev.lib, dev.id))) || 0;
      return json({ chg }, 200, Object.assign({ "Cache-Control": "no-store" }, cors));
    }
    const lib = dev ? await env.PLAYLISTS.get("lib:" + dev.lib, "json") : null;
    const me = lib && (lib.devices || []).find((d) => d.th === th);
    if (!dev || !lib || !me) {
      if (dev) await env.PLAYLISTS.delete("dev:" + th);
      return json({ error: "unlinked" }, 401, cors);
    }

    if (path === "/link/manifest" && request.method === "GET") {
      const recs = await Promise.all((lib.items || []).map((it) => env.PLAYLISTS.get("pl:" + it.id, "json")));
      const playlists = [];
      (lib.items || []).forEach((it, i) => {
        const r = recs[i];
        if (r && r.body) playlists.push({ id: it.id, title: it.title, updated: r.updated || 0, url: url.origin + "/p/" + it.id + ".bplist" });
      });
      // Remember when this headset last checked in (at most one write an hour) and keep the library alive.
      if (nowSec() - (me.seen || 0) > 3600) {
        me.seen = nowSec();
        const w = Promise.all([putLib(env, dev.lib, lib), env.PLAYLISTS.put("dev:" + th, JSON.stringify(dev), { expirationTtl: LIB_TTL })]);
        if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w;
      }
      const sk = seenKey(dev.lib, me.id), lastSeen = +(await env.PLAYLISTS.get(sk)) || 0;
      if (nowSec() - lastSeen > 600) {
        const sw = putTtl(env, sk, String(nowSec()));
        if (ctx && ctx.waitUntil) ctx.waitUntil(sw); else await sw;
      }
      const out = (await env.PLAYLISTS.get(outKey(dev.lib, me.id), "json")) || { items: [] };
      out.items = await liveOut(env, dev.lib, me.id, out.items);
      const writes = out.items.map((w) => Object.assign({ id: w.id, file: w.file, create: !!w.create, url: url.origin + "/link/outbox/" + w.id }, w.restore ? { restore: w.restore } : {}, w.remove ? { remove: true } : {}, w.remove && w.songs ? { songs: true } : {}));
      const extra = {};
      const inv = (await env.PLAYLISTS.get(invKey(dev.lib, me.id), "json")) || { items: [] }, feats = inv.features || [];
      // "My order" from Studio, as file names, until the headset says it put it in game.
      if (feats.includes("order")) {
        const ord = (await env.PLAYLISTS.get(ordKey(dev.lib, me.id), "json")) || {};
        if (Array.isArray(ord.ks) && ord.t > (inv.ordApplied || 0)) {
          const byK = new Map(inv.items.map((it) => [it.k, it.file]));
          extra.order = { t: ord.t, files: ord.ks.map((k) => byK.get(k)).filter(Boolean) };
        }
      }
      if (feats.includes("cleanup")) {
        const cln = await env.PLAYLISTS.get(clnKey(dev.lib, me.id), "json");
        if (cln && cln.id) extra.cleanup = { id: cln.id };
      }
      const fileOf = new Map(inv.items.map((it) => [it.k, it.file]));
      // Auto-download switches set in Studio, as file names, until the headset says it took them.
      if (feats.includes("autodl")) {
        const adl = await env.PLAYLISTS.get(adlKey(dev.lib, me.id), "json");
        if (adl && adl.t > (inv.adlApplied || 0) && adl.set)
          extra.autodl = { t: adl.t, set: Object.keys(adl.set).filter((k) => fileOf.has(k)).map((k) => ({ file: fileOf.get(k), on: !!adl.set[k] })) };
      }
      if (feats.includes("missing")) {
        const gm = await env.PLAYLISTS.get(gmKey(dev.lib, me.id), "json");
        if (gm && gm.id) extra.getMissing = gm.all ? { id: gm.id, all: true } : { id: gm.id, files: (gm.ks || []).map((k) => fileOf.get(k)).filter(Boolean) };
      }
      // Where the change counter stood at this sync; the mod's minute check compares against it.
      extra.chg = +(await env.PLAYLISTS.get(chgKey(dev.lib, me.id))) || 0;
      return json(Object.assign({ library: dev.lib, device: me.name, playlists, writes }, extra), 200, Object.assign({ "Cache-Control": "no-store" }, cors));
    }

    if (path === "/link/inventory" && request.method === "POST") {
      const body = await readJson(request, 200000);
      if (!body || !Array.isArray(body.items)) return json({ error: "Expected { items: [] }" }, 400, cors);
      const old = (await env.PLAYLISTS.get(invKey(dev.lib, me.id), "json")) || { items: [] };
      const byFile = new Map(old.items.map((it) => [it.file, it]));
      const items = [], need = [];
      for (const it of body.items.slice(0, MAX_INVENTORY)) {
        if (!it || !validFile(it.file) || typeof it.sha !== "string" || it.sha.length > 64) continue;
        const prev = byFile.get(it.file);
        const have = !!(prev && prev.sha === it.sha && prev.have);
        if (!have) need.push(it.file);
        items.push({ k: await fileKey(it.file), file: it.file, title: String(it.title || "").slice(0, 200), count: Math.max(0, Math.min(100000, it.count | 0)), ...mapsField(it.maps), ...soloField(it.solo), ...(typeof it.auto === "boolean" ? { auto: it.auto } : {}), sha: it.sha, have, at: have ? prev.at : nowSec(), ...(have && prev.v ? { v: prev.v } : {}), backups: cleanBackups(it.backups) });
      }
      // Drop stored copies of playlists that are gone from the headset.
      const keep = new Set(items.map((it) => it.file));
      const gone = old.items.filter((it) => !keep.has(it.file));
      const backupsChanged = items.some((it) => { const p = byFile.get(it.file); return JSON.stringify(it.backups) !== JSON.stringify((p && p.backups) || []) || (p && p.maps) !== it.maps || (p && p.solo) !== it.solo || (p && p.auto) !== it.auto; });
      // Playlists deleted on the headset that it can still bring back, and what this mod version can do.
      const deleted = [];
      for (const d of (Array.isArray(body.deleted) ? body.deleted : []).slice(0, MAX_DELETED)) {
        if (!d || !validFile(d.file)) continue;
        const backups = cleanBackups(d.backups);
        if (backups.length) deleted.push({ k: await fileKey(d.file), file: d.file, title: String(d.title || "").slice(0, 200), backups });
      }
      const features = (Array.isArray(body.features) ? body.features : []).filter((f) => FEATURES.includes(f));
      // The "My order" (the time Studio saved it) the headset last put in game.
      const ordApplied = Number.isSafeInteger(body.order) && body.order > 0 ? Math.min(body.order, nowSec() + 60) : (old.ordApplied || 0);
      // The Studio auto-download change (its time) the headset last took.
      const adlApplied = Number.isSafeInteger(body.autodl) && body.autodl > 0 ? Math.min(body.autodl, nowSec() + 60) : (old.adlApplied || 0);
      const changed = gone.length || need.length || items.length !== old.items.length || backupsChanged || ordApplied !== (old.ordApplied || 0) || adlApplied !== (old.adlApplied || 0) ||
        JSON.stringify(deleted) !== JSON.stringify(old.deleted || []) || JSON.stringify(features) !== JSON.stringify(old.features || []);
      if (changed) {
        await Promise.all(gone.map((it) => env.PLAYLISTS.delete("invb:" + dev.lib + ":" + me.id + ":" + it.k)));
        await putTtl(env, invKey(dev.lib, me.id), Object.assign({ items, deleted, features, updated: nowSec() }, ordApplied ? { ordApplied } : {}, adlApplied ? { adlApplied } : {}));
      }
      return json({ need }, 200, cors);
    }

    if (path === "/link/inventory/body" && request.method === "POST") {
      const file = url.searchParams.get("file") || "";
      if (!validFile(file)) return json({ error: "Bad file name" }, 400, cors);
      const text = await request.text();
      if (text.length > MAX_HEADSET_BYTES || !looksLikePlaylist(text)) return json({ error: "Not a playlist or too large" }, 400, cors);
      const inv = (await env.PLAYLISTS.get(invKey(dev.lib, me.id), "json")) || { items: [] };
      const it = inv.items.find((x) => x.file === file);
      if (!it) return json({ error: "Not in the inventory" }, 404, cors);
      await putTtl(env, "invb:" + dev.lib + ":" + me.id + ":" + it.k, text);
      it.have = true; it.at = nowSec(); it.v = await plVersion(text);
      await putTtl(env, invKey(dev.lib, me.id), inv);
      return json({ ok: true }, 200, cors);
    }

    if (path === "/link/stats" && request.method === "POST") {
      const body = await readJson(request, 8000);
      if (!body) return json({ error: "Expected stats" }, 400, cors);
      await putTtl(env, statKey(dev.lib, me.id), cleanStats(body));
      return json({ ok: true }, 200, cors);
    }

    const cm = path.match(/^\/link\/cleanup\/([A-Za-z0-9]{6,16})\/ack$/);
    if (cm && request.method === "POST") {
      const body = (await readJson(request, 2000)) || {};
      const cln = await env.PLAYLISTS.get(clnKey(dev.lib, me.id), "json");
      const prev = await env.PLAYLISTS.get(clnrKey(dev.lib, me.id), "json");
      if ((!cln || cln.id !== cm[1]) && !(prev && prev.id === cm[1])) return json({ error: "Not found" }, 404, cors);
      if (!(prev && prev.id === cm[1]))
        await putTtl(env, clnrKey(dev.lib, me.id), { id: cm[1], at: nowSec(), asked: (cln && cln.at) || 0, deleted: countField(body.deleted), bytes: Math.max(0, bytesField(body.bytes)), kept: countField(body.kept) });
      if (cln && cln.id === cm[1]) await env.PLAYLISTS.delete(clnKey(dev.lib, me.id));
      return json({ ok: true }, 200, cors);
    }

    const gma = path.match(/^\/link\/getmissing\/([A-Za-z0-9]{6,16})\/ack$/);
    if (gma && request.method === "POST") {
      const body = (await readJson(request, 2000)) || {};
      const gm = await env.PLAYLISTS.get(gmKey(dev.lib, me.id), "json");
      const prev = await env.PLAYLISTS.get(gmrKey(dev.lib, me.id), "json");
      if ((!gm || gm.id !== gma[1]) && !(prev && prev.id === gma[1])) return json({ error: "Not found" }, 404, cors);
      if (!(prev && prev.id === gma[1]))
        await putTtl(env, gmrKey(dev.lib, me.id), { id: gma[1], at: nowSec(), asked: (gm && gm.at) || 0, downloaded: countField(body.downloaded), notFound: countField(body.notFound) });
      if (gm && gm.id === gma[1]) await env.PLAYLISTS.delete(gmKey(dev.lib, me.id));
      return json({ ok: true }, 200, cors);
    }

    const ob = path.match(/^\/link\/outbox\/([A-Za-z0-9]{6,16})(\/ack)?$/);
    if (ob) {
      const out = (await env.PLAYLISTS.get(outKey(dev.lib, me.id), "json")) || { items: [] };
      const w = out.items.find((x) => x.id === ob[1]);
      if (!w) return json({ error: "Not found" }, 404, cors);
      const bk = "outb:" + dev.lib + ":" + me.id + ":" + w.id;
      if (!ob[2] && request.method === "GET") {
        const text = await env.PLAYLISTS.get(bk);
        if (!text) {
          // A send whose ack was lost under the old list rewrite: its body is gone, so it's done.
          if (!w.remove && !w.restore && nowSec() - (w.at || 0) > 300) await putTtl(env, ackKey(dev.lib, me.id, w.id), "1");
          return json({ error: "Not found" }, 404, cors);
        }
        return new Response(text, { headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors) });
      }
      if (ob[2] && request.method === "POST") {
        // A new playlist whose name was taken on the headset is saved under another one; remember the move
        // so Studio (and sends still on their way) follow it to the new file.
        const body = (await readJson(request, 2000)) || {};
        await putTtl(env, ackKey(dev.lib, me.id, w.id), "1");
        if (validFile(body.file) && body.file !== w.file) {
          // Rare (a new playlist saved under another name), so this one still rewrites the list.
          out.moved = (out.moved || []).filter((x) => x.k !== w.k).concat({ k: w.k, nk: await fileKey(body.file), file: body.file, at: nowSec() }).slice(-MAX_MOVED);
          out.items = (await liveOut(env, dev.lib, me.id, out.items)).filter((x) => x.id !== w.id);
          await putTtl(env, outKey(dev.lib, me.id), out);
        }
        await env.PLAYLISTS.delete(bk);
        return json({ ok: true }, 200, cors);
      }
      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (path === "/link/unlink" && request.method === "POST") {
      lib.devices = (lib.devices || []).filter((d) => d.th !== th);
      await putLib(env, dev.lib, lib);
      await env.PLAYLISTS.delete("dev:" + th);
      return new Response(null, { status: 204, headers: cors });
    }
    return json({ error: "Not found" }, 404, cors);
  }

  // ---- Studio side ----
  // A script on the owner's own computer (no browser, so no Origin header) may manage an existing library with its key.
  // Browsers always send Origin on these cross-site calls, so another web page still can't. New libraries stay Studio-only.
  const scripted = !request.headers.get("Origin") && path !== "/lib";
  if (!originOk(request) && !scripted) return json({ error: "Only Playlist Studio can manage libraries" }, 403, cors);

  if (path === "/lib" && request.method === "POST") {
    if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const id = randomId(10), key = randomHex(24);
    await putLib(env, id, { hk: await sha256(key), items: [], devices: [], created: nowSec() });
    return json({ id, key }, 201, cors);
  }

  // PUT /lib/<id>/devices/<dev>/order { ks: [playlist keys, top first] }
  const om = path.match(/^\/lib\/([A-Za-z0-9]{6,16})\/devices\/([A-Za-z0-9]{6,16})\/order$/);
  if (om) {
    const olib = await env.PLAYLISTS.get("lib:" + om[1], "json");
    if (!olib) return json({ error: "Not found" }, 404, cors);
    const okey = request.headers.get("X-Lib-Key") || "";
    if (!okey || !safeEqual(await sha256(okey), olib.hk)) return json({ error: "Wrong library key" }, 403, cors);
    if (!(olib.devices || []).some((x) => x.id === om[2])) return json({ error: "Not found" }, 404, cors);
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, cors);
    if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const body = (await readJson(request, 20000)) || {};
    if (!Array.isArray(body.ks)) return json({ error: "Expected { ks: [] }" }, 400, cors);
    const ks = [...new Set(body.ks.filter((x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x)))].slice(0, MAX_INVENTORY);
    // Always later than the last one, so a headset that applied an order in the same second still gets this one.
    const prevOrd = (await env.PLAYLISTS.get(ordKey(om[1], om[2]), "json")) || {};
    const t = Math.max(nowSec(), (prevOrd.t || 0) + 1);
    await putTtl(env, ordKey(om[1], om[2]), { ks, t });
    await touch(env, om[1], om[2]);
    return json({ order: ks, t }, 200, cors);
  }
  // POST /lib/<id>/devices/<dev>/cleanup asks the headset to clean up songs no playlist uses; DELETE takes it back.
  const cl = path.match(/^\/lib\/([A-Za-z0-9]{6,16})\/devices\/([A-Za-z0-9]{6,16})\/cleanup$/);
  if (cl) {
    const clib = await env.PLAYLISTS.get("lib:" + cl[1], "json");
    if (!clib) return json({ error: "Not found" }, 404, cors);
    const ckey = request.headers.get("X-Lib-Key") || "";
    if (!ckey || !safeEqual(await sha256(ckey), clib.hk)) return json({ error: "Wrong library key" }, 403, cors);
    if (!(clib.devices || []).some((x) => x.id === cl[2])) return json({ error: "Not found" }, 404, cors);
    if (request.method === "DELETE") {
      await env.PLAYLISTS.delete(clnKey(cl[1], cl[2]));
      await touch(env, cl[1], cl[2]);
      return json({ cleanup: null }, 200, cors);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
    if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const cinv = (await env.PLAYLISTS.get(invKey(cl[1], cl[2]), "json")) || {};
    if (!(cinv.features || []).includes("cleanup")) return json({ error: "Update Studio Sync on the headset to clean up songs from here" }, 409, cors);
    const old = await env.PLAYLISTS.get(clnKey(cl[1], cl[2]), "json");
    const cln = old && old.id ? old : { id: randomId(10), at: nowSec() };
    if (cln !== old) { await putTtl(env, clnKey(cl[1], cl[2]), cln); await touch(env, cl[1], cl[2]); }
    return json({ cleanup: cln }, 200, cors);
  }
  // POST /lib/<id>/devices/<dev>/getmissing { ks: [playlist keys] } or { all: true } asks the headset to download the
  // songs those playlists are missing; DELETE takes it back.
  const gmm = path.match(/^\/lib\/([A-Za-z0-9]{6,16})\/devices\/([A-Za-z0-9]{6,16})\/getmissing$/);
  if (gmm) {
    const glib = await env.PLAYLISTS.get("lib:" + gmm[1], "json");
    if (!glib) return json({ error: "Not found" }, 404, cors);
    const gkey = request.headers.get("X-Lib-Key") || "";
    if (!gkey || !safeEqual(await sha256(gkey), glib.hk)) return json({ error: "Wrong library key" }, 403, cors);
    if (!(glib.devices || []).some((x) => x.id === gmm[2])) return json({ error: "Not found" }, 404, cors);
    if (request.method === "DELETE") {
      await env.PLAYLISTS.delete(gmKey(gmm[1], gmm[2]));
      await touch(env, gmm[1], gmm[2]);
      return json({ getMissing: null }, 200, cors);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
    if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const ginv = (await env.PLAYLISTS.get(invKey(gmm[1], gmm[2]), "json")) || {};
    if (!(ginv.features || []).includes("missing")) return json({ error: "Update Studio Sync on the headset to get missing songs from here" }, 409, cors);
    const body = (await readJson(request, 20000)) || {};
    const known = new Set((ginv.items || []).map((x) => x.k));
    const ks = [...new Set((Array.isArray(body.ks) ? body.ks : []).filter((x) => typeof x === "string" && known.has(x)))].slice(0, MAX_INVENTORY);
    if (!body.all && !ks.length) return json({ error: "That playlist isn't on the headset anymore" }, 404, cors);
    // A request still waiting grows to cover both; "all" covers everything.
    const old = await env.PLAYLISTS.get(gmKey(gmm[1], gmm[2]), "json");
    const all = !!body.all || !!(old && old.all);
    const gm = { id: old && old.id ? old.id : randomId(10), at: old && old.at ? old.at : nowSec(), ...(all ? { all: true } : { ks: [...new Set(((old && old.ks) || []).concat(ks))].slice(0, MAX_INVENTORY) }) };
    await putTtl(env, gmKey(gmm[1], gmm[2]), gm);
    await touch(env, gmm[1], gmm[2]);
    return json({ getMissing: gm }, 200, cors);
  }
  // PUT /lib/<id>/devices/<dev>/autodl { set: { key: true|false } } turns auto-download on or off for playlists.
  const adm = path.match(/^\/lib\/([A-Za-z0-9]{6,16})\/devices\/([A-Za-z0-9]{6,16})\/autodl$/);
  if (adm) {
    const alib = await env.PLAYLISTS.get("lib:" + adm[1], "json");
    if (!alib) return json({ error: "Not found" }, 404, cors);
    const akey = request.headers.get("X-Lib-Key") || "";
    if (!akey || !safeEqual(await sha256(akey), alib.hk)) return json({ error: "Wrong library key" }, 403, cors);
    if (!(alib.devices || []).some((x) => x.id === adm[2])) return json({ error: "Not found" }, 404, cors);
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, cors);
    if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const ainv = (await env.PLAYLISTS.get(invKey(adm[1], adm[2]), "json")) || {};
    if (!(ainv.features || []).includes("autodl")) return json({ error: "Update Studio Sync on the headset to change auto-download from here" }, 409, cors);
    const body = (await readJson(request, 20000)) || {};
    const known = new Set((ainv.items || []).map((x) => x.k));
    const set = {};
    for (const [k, v] of Object.entries(body.set && typeof body.set === "object" ? body.set : {})) if (known.has(k) && typeof v === "boolean") set[k] = v;
    if (!Object.keys(set).length) return json({ error: "That playlist isn't on the headset anymore" }, 404, cors);
    // Changes the headset hasn't taken yet stay in; newer ones win. Always later than the last, like the order.
    const prev = (await env.PLAYLISTS.get(adlKey(adm[1], adm[2]), "json")) || {};
    const keep = prev.set && (prev.t || 0) > (ainv.adlApplied || 0) ? prev.set : {};
    const adl = { t: Math.max(nowSec(), (prev.t || 0) + 1), set: Object.assign({}, keep, set) };
    await putTtl(env, adlKey(adm[1], adm[2]), adl);
    await touch(env, adm[1], adm[2]);
    return json({ autodl: adl }, 200, cors);
  }
  const m = path.match(/^\/lib\/([A-Za-z0-9]{6,16})(\/items|\/claim|\/rekey|\/devices\/([A-Za-z0-9]{6,16})(\/playlists(?:\/(new|delete|[0-9a-f]{16})(\/send|\/restore|\/delete|\/cancel)?)?)?)?$/);
  if (!m) return json({ error: "Not found" }, 404, cors);
  const id = m[1], lib = await env.PLAYLISTS.get("lib:" + id, "json");
  if (!lib) return json({ error: "Not found" }, 404, cors);
  const key = request.headers.get("X-Lib-Key") || "";
  if (!key || !safeEqual(await sha256(key), lib.hk)) return json({ error: "Wrong library key" }, 403, cors);
  // Which public BeatLeader profile is connected in Studio for this library (X-Studio-Player: <id>|<name>),
  // so the owner's stats page can list Studio Sync users. Sent on the library refresh, saved at most once a day.
  const sp = !m[2] && request.method === "GET" ? (request.headers.get("X-Studio-Player") || "").match(/^(\d{3,25})\|(.{1,200})$/) : null;
  if (sp) {
    let nm = ""; try { nm = decodeURIComponent(sp[2]).replace(/[\u0000-\u001f]/g, "").slice(0, 60); } catch (e) {}
    const pl = lib.player || {};
    if (nm && (pl.id !== sp[1] || pl.name !== nm || nowSec() - (pl.t || 0) > 86400)) {
      lib.player = { id: sp[1], name: nm, t: nowSec() };
      const pw = putLib(env, id, lib);
      if (ctx && ctx.waitUntil) ctx.waitUntil(pw); else await pw;
    }
  }

  // A headset's own playlists, as it last reported them, plus new ones Studio is creating.
  if (m[4]) {
    const dv = (lib.devices || []).find((x) => x.id === m[3]);
    if (!dv) return json({ error: "Not found" }, 404, cors);
    const inv = (await env.PLAYLISTS.get(invKey(id, dv.id), "json")) || { items: [] };
    const out = (await env.PLAYLISTS.get(outKey(id, dv.id), "json")) || { items: [] };
    out.items = await liveOut(env, id, dv.id, out.items);
    const pendingList = () => out.items.map((x) => Object.assign({ id: x.id, k: x.k, file: x.file, title: x.title || "", create: !!x.create, restore: x.restore || 0, remove: !!x.remove, songs: !!(x.remove && x.songs), at: x.at }, x.v ? { v: x.v } : {}));
    // The newest version of a playlist: a send still waiting for the headset, else the headset's copy.
    // "" = not known (a restore or delete is waiting, or the headset hasn't shared this copy yet): no check.
    const latestV = (file, item) => {
      const w = out.items.find((x) => x.file === file);
      if (w) return w.v || "";
      return (item && item.have && item.v) || "";
    };
    const movedList = () => (out.moved || []).map((x) => ({ k: x.k, nk: x.nk, file: x.file }));
    // opts: { restore: backup time } or { remove: true, songs }; neither carries a body. opts.later leaves
    // saving the list to the caller (deleting several at once writes it once).
    const queue = async (k, file, title, create, body, opts) => {
      opts = opts || {};
      // One pending write per playlist: a newer send replaces the older one (a create stays a create).
      const prev = out.items.filter((x) => x.file === file);
      for (const w of prev) await env.PLAYLISTS.delete("outb:" + id + ":" + dv.id + ":" + w.id);
      out.items = out.items.filter((x) => x.file !== file);
      const w = { id: randomId(10), k, file, title: String(title || "").slice(0, 200), create: create || prev.some((x) => x.create), at: nowSec() };
      if (opts.restore) w.restore = opts.restore;
      else if (opts.remove) { w.remove = true; if (opts.songs) w.songs = true; }
      else { await putTtl(env, "outb:" + id + ":" + dv.id + ":" + w.id, JSON.stringify(body)); w.v = await plVersion(body); }
      out.items.push(w);
      if (!opts.later) { await putTtl(env, outKey(id, dv.id), out); await touch(env, id, dv.id); }
      return w;
    };
    const noSongs = () => !(inv.features || []).includes("delete-songs");
    if (!m[5] && request.method === "GET") {
      const old = inv.items.filter((it) => it.have && it.v === undefined).slice(0, 25);
      if (old.length) {
        for (const it of old) it.v = await plVersion(await env.PLAYLISTS.get("invb:" + id + ":" + dv.id + ":" + it.k));
        await putTtl(env, invKey(id, dv.id), inv);
      }
      const items = inv.items.map((it) => { const v = latestV(it.file, it); return Object.assign({ k: it.k, file: it.file, title: it.title, count: it.count }, mapsField(it.maps), soloField(it.solo), typeof it.auto === "boolean" ? { auto: it.auto } : {}, { ready: !!it.have, at: it.at }, v ? { v } : {}, { backups: it.backups || [] }); });
      const deleted = (inv.deleted || []).map((d) => ({ k: d.k, file: d.file, title: d.title, backups: d.backups }));
      const seen = Math.max(dv.seen || 0, +(await env.PLAYLISTS.get(seenKey(id, dv.id))) || 0);
      const ord = (await env.PLAYLISTS.get(ordKey(id, dv.id), "json")) || {};
      const feats = inv.features || [], more = {};
      if (feats.includes("order")) Object.assign(more, { orderT: ord.t || 0, orderApplied: inv.ordApplied || 0 });
      if (feats.includes("storage")) { const st = await env.PLAYLISTS.get(statKey(id, dv.id), "json"); if (st) more.stats = st; }
      if (feats.includes("cleanup")) {
        const [cln, clnr] = await Promise.all([env.PLAYLISTS.get(clnKey(id, dv.id), "json"), env.PLAYLISTS.get(clnrKey(id, dv.id), "json")]);
        if (cln) more.cleanup = cln;
        if (clnr) more.cleanupDone = clnr;
      }
      if (feats.includes("missing")) {
        const [gm, gmr] = await Promise.all([env.PLAYLISTS.get(gmKey(id, dv.id), "json"), env.PLAYLISTS.get(gmrKey(id, dv.id), "json")]);
        if (gm) more.getMissing = gm;
        if (gmr) more.getMissingDone = gmr;
      }
      if (feats.includes("autodl")) {
        const adl = await env.PLAYLISTS.get(adlKey(id, dv.id), "json");
        Object.assign(more, { autodlApplied: inv.adlApplied || 0 }, adl ? { autodl: adl } : {});
      }
      return json(Object.assign({ items, deleted, features: feats, pending: pendingList(), moved: movedList(), updated: inv.updated || 0, seen, order: Array.isArray(ord.ks) ? ord.ks : [] }, more), 200, Object.assign({ "Cache-Control": "no-store" }, cors));
    }
    if (m[5] === "new" && !m[6] && request.method === "POST") {
      if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      const pl = await readPlaylist(request);
      if (pl.error) return json({ error: pl.error }, 400, cors);
      // A file name from the title that doesn't clash with anything on the headset or queued.
      const taken = new Set(inv.items.map((x) => x.file.toLowerCase()).concat(out.items.map((x) => x.file.toLowerCase())));
      const base = (pl.value.playlistTitle || "Playlist").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^StudioSync_/i, "").replace(/^\.+/, "").trim().slice(0, 80) || "Playlist";
      let file = base + ".bplist", n = 2;
      while (taken.has(file.toLowerCase())) file = base + " (" + (n++) + ").bplist";
      const w = await queue(await fileKey(file), file, pl.value.playlistTitle, true, pl.value);
      return json({ k: w.k, file: w.file, v: w.v, pending: pendingList() }, 201, cors);
    }
    if (m[5] === "delete" && !m[6] && request.method === "POST") {
      if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      if (!(inv.features || []).includes("delete")) return json({ error: "Update Studio Sync on the headset to delete from here" }, 409, cors);
      const body = (await readJson(request, 20000)) || {};
      const ks = Array.isArray(body.ks) ? body.ks.filter((x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x)).slice(0, 200) : [];
      if (!ks.length) return json({ error: "Pick the playlists to delete" }, 400, cors);
      if (body.songs && noSongs()) return json({ error: "Update Studio Sync on the headset to delete songs from here" }, 409, cors);
      const done = [], missing = [];
      for (const kk of ks) {
        const hit = inv.items.find((x) => x.k === kk);
        if (!hit) { missing.push(kk); continue; }
        await queue(hit.k, hit.file, hit.title, false, null, { remove: true, songs: !!body.songs, later: true });
        done.push(kk);
      }
      if (done.length) { await putTtl(env, outKey(id, dv.id), out); await touch(env, id, dv.id); }
      return json({ deleted: done, missing, pending: pendingList() }, 200, cors);
    }
    let k = m[5] && m[5] !== "new" ? m[5] : "";
    // Follow a new playlist that was saved under another name on the headset.
    const mv = k && !inv.items.some((x) => x.k === k) && (out.moved || []).find((x) => x.k === k);
    if (mv) k = mv.nk;
    const it = k && inv.items.find((x) => x.k === k);
    const waiting = k && !it && out.items.find((x) => x.k === k && x.create);
    const del = k && !it && (inv.deleted || []).find((x) => x.k === k);
    // Undo a send, restore or delete the headset hasn't picked up yet.
    if (m[6] === "/cancel" && request.method === "POST") {
      const prev = out.items.filter((x) => x.k === k);
      if (!prev.length) return json({ error: "Nothing is waiting for that playlist" }, 404, cors);
      for (const w of prev) await env.PLAYLISTS.delete("outb:" + id + ":" + dv.id + ":" + w.id);
      out.items = out.items.filter((x) => x.k !== k);
      await putTtl(env, outKey(id, dv.id), out);
      await touch(env, id, dv.id);
      return json({ pending: pendingList() }, 200, cors);
    }
    if (m[6] === "/restore" && request.method === "POST" && del) {
      if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      const body = (await readJson(request, 2000)) || {};
      const t = Number(body.t);
      if (!del.backups.some((b) => b.t === t)) return json({ error: "That backup isn't on the headset anymore" }, 404, cors);
      await queue(del.k, del.file, del.title, false, null, { restore: t });
      return json({ pending: pendingList() }, 200, cors);
    }
    if (!it && !waiting) return json({ error: "That playlist isn't on the headset anymore" }, 404, cors);
    if (m[6] === "/delete" && request.method === "POST") {
      if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      if (!it) return json({ error: "The headset hasn't written that playlist yet" }, 409, cors);
      if (!(inv.features || []).includes("delete")) return json({ error: "Update Studio Sync on the headset to delete from here" }, 409, cors);
      const body = (await readJson(request, 2000)) || {};
      if (body.songs && noSongs()) return json({ error: "Update Studio Sync on the headset to delete songs from here" }, 409, cors);
      await queue(it.k, it.file, it.title, false, null, { remove: true, songs: !!body.songs });
      return json({ pending: pendingList() }, 200, cors);
    }
    if (!m[6] && request.method === "GET") {
      const w = url.searchParams.get("latest") === "1" ? out.items.find((x) => x.k === k && x.v) : null;
      const text = w ? await env.PLAYLISTS.get("outb:" + id + ":" + dv.id + ":" + w.id)
        : it ? await env.PLAYLISTS.get("invb:" + id + ":" + dv.id + ":" + it.k) : await env.PLAYLISTS.get("outb:" + id + ":" + dv.id + ":" + waiting.id);
      if (!text) return json({ error: "The headset hasn't uploaded this one yet" }, 404, cors);
      const v = w ? w.v : (it ? (it.have && it.v) || await plVersion(text) : waiting.v || "");
      return new Response(text, { headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, v ? { "X-Studio-Version": v } : {}, cors) });
    }
    if (m[6] === "/restore" && request.method === "POST") {
      if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      if (!it) return json({ error: "The headset hasn't written that playlist yet" }, 409, cors);
      const body = (await readJson(request, 2000)) || {};
      const t = Number(body.t);
      if (!(it.backups || []).some((b) => b.t === t)) return json({ error: "That backup isn't on the headset anymore" }, 404, cors);
      await queue(it.k, it.file, it.title, false, null, { restore: t });
      return json({ pending: pendingList() }, 200, cors);
    }
    if (m[6] === "/send" && request.method === "POST") {
      if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      const pl = await readPlaylist(request);
      if (pl.error) return json({ error: pl.error }, 400, cors);
      const target = it || waiting;
      const base = url.searchParams.get("base") || "", now = latestV(target.file, it);
      if (base && now && base !== now) return json({ error: "This playlist changed since you opened it", conflict: true, v: now, pending: pendingList() }, 409, cors);
      const w = await queue(target.k, target.file, pl.value.playlistTitle, false, pl.value);
      return json({ k: target.k, file: target.file, v: w.v, pending: pendingList() }, 200, cors);
    }
    return json({ error: "Method not allowed" }, 405, cors);
  }

  if (!m[2] && request.method === "GET") {
    return json({ items: lib.items || [], devices: await withSeen(env, id, publicDevices(lib)) }, 200, Object.assign({ "Cache-Control": "no-store" }, cors));
  }

  if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);

  if (m[2] === "/items" && request.method === "PUT") {
    const body = await readJson(request, 40000);
    if (!body || !Array.isArray(body.items)) return json({ error: "Expected { items: [] }" }, 400, cors);
    if (body.items.length > MAX_LIB_ITEMS) return json({ error: "A headset can sync up to " + MAX_LIB_ITEMS + " playlists" }, 400, cors);
    const seen = new Set(), items = [];
    for (const it of body.items) {
      if (!it || !/^[A-Za-z0-9]{6,16}$/.test(String(it.id || "")) || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: String(it.id), title: (typeof it.title === "string" ? it.title : "").slice(0, 200) });
    }
    lib.items = items;
    await putLib(env, id, lib);
    await Promise.all((lib.devices || []).map((d) => touch(env, id, d.id)));
    return json({ items, devices: publicDevices(lib) }, 200, cors);
  }

  // A new key for the library. Headsets keep working (they use their own tokens); every browser or script holding
  // the old key stops. Only Studio itself can do this, so a key copied into a script can't lock the owner out.
  if (m[2] === "/rekey" && request.method === "POST") {
    if (scripted) return json({ error: "Make a new key in Playlist Studio" }, 403, cors);
    const nk = randomHex(24);
    lib.hk = await sha256(nk);
    await putLib(env, id, lib);
    return json({ id, key: nk }, 200, cors);
  }

  if (m[2] === "/claim" && request.method === "POST") {
    if (!(await allowWrite(request, env, "claim", 10))) return json({ error: "Too many tries - wait a few minutes" }, 429, cors);
    const body = (await readJson(request, 2000)) || {};
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const rec = /^[A-Z0-9]{6}$/.test(code) ? await env.PLAYLISTS.get("code:" + code, "json") : null;
    if (!rec || !rec.th) return json({ error: "That code is wrong or expired. Get a fresh one from the headset." }, 404, cors);
    lib.devices = (lib.devices || []).filter((d) => d.th !== rec.th);
    if (lib.devices.length >= MAX_DEVICES) return json({ error: "Unlink a headset first (" + MAX_DEVICES + " max)" }, 400, cors);
    const dev = { id: randomId(8), th: rec.th, name: rec.name || "Quest", added: nowSec(), seen: 0 };
    lib.devices.push(dev);
    await putLib(env, id, lib);
    await env.PLAYLISTS.put("dev:" + rec.th, JSON.stringify({ lib: id, id: dev.id, added: dev.added }), { expirationTtl: LIB_TTL });
    await env.PLAYLISTS.delete("code:" + code);
    return json({ device: { id: dev.id, name: dev.name, added: dev.added, seen: 0 }, devices: publicDevices(lib) }, 200, cors);
  }

  // Rename a headset. Studio shows the new name, and so does anything that reads the device record.
  if (m[3] && !m[4] && request.method === "POST") {
    if (!(await allowWrite(request, env, "lib", LIB_WRITE_LIMIT))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const body = (await readJson(request, 2000)) || {};
    const d = (lib.devices || []).find((x) => x.id === m[3]);
    if (!d) return json({ error: "That headset isn't linked anymore" }, 404, cors);
    d.name = cleanName(body.name);
    await putLib(env, id, lib);
    return json({ device: { id: d.id, name: d.name }, devices: publicDevices(lib) }, 200, cors);
  }

  if (m[3] && !m[4] && request.method === "DELETE") {
    const d = (lib.devices || []).find((x) => x.id === m[3]);
    if (d) {
      lib.devices = lib.devices.filter((x) => x.id !== m[3]);
      await putLib(env, id, lib);
      await env.PLAYLISTS.delete("dev:" + d.th);
    }
    return json({ devices: publicDevices(lib) }, 200, cors);
  }
  return json({ error: "Method not allowed" }, 405, cors);
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

// ---------------------------------------------------------------- private stats page (/admin)
// How many headsets are linked and how many sync, plus the Studio Sync users by BeatLeader profile (only the
// public profile Studio had connected). No playlist names or headset names leave the Worker. The page is public but empty; the numbers need ADMIN_KEY, a Worker secret
// (npx wrangler secret put ADMIN_KEY), sent as "Authorization: Bearer <key>".
let adminFails = [];   // times of recent wrong admin keys, kept in memory only
async function admin(request, env, url) {
  const nocache = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
  if (url.pathname === "/admin" && request.method === "GET") {
    return new Response(ADMIN_PAGE, { headers: Object.assign({ "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https://cdn.assets.beatleader.com https://cdn.assets.beatleader.xyz https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com https://avatars.cloudflare.steamstatic.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://spanky3651.github.io" }, nocache) });
  }
  if ((url.pathname !== "/admin/stats" && url.pathname !== "/admin/gc") || request.method !== "GET") return json({ error: "Not found" }, 404, nocache);
  if (!env.ADMIN_KEY) return json({ error: "ADMIN_KEY isn't set on the Worker yet" }, 503, nocache);
  // Guessing protection without IP addresses: one shared count of wrong keys. After 20 in 10 minutes the
  // page refuses everyone (the owner included) until the window passes. Right keys are never counted.
  const t = nowSec();
  adminFails = adminFails.filter((x) => t - x < 600);
  if (adminFails.length >= 20) return json({ error: "Too many wrong keys - wait a few minutes" }, 429, nocache);
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S{8,200})$/);
  if (!m || !env.PLAYLISTS || !safeEqual(await sha256(m[1]), await sha256(env.ADMIN_KEY))) {
    adminFails.push(t);
    return json({ error: "Wrong key" }, 401, nocache);
  }
  if (url.pathname === "/admin/gc") {
    if (!env.GC_TOKEN) return json({ error: "GoatCounter isn't connected yet", setup: true }, 503, nocache);
    try { return json(await gcStats(env, url.searchParams.get("range") || "7d", url.searchParams.get("fresh") === "1", url.searchParams.get("site") || ""), 200, nocache); }
    catch (e) {
      if (e && e.message === "gc-auth") return json({ error: "GoatCounter refused the API key (" + e.gc + "). " + (url.searchParams.get("site") === "bl" ? "For the BeatLeader profile site, check that the key can read blprofile, or set GC_TOKEN_BL." : "Check that GC_TOKEN has the Read statistics permission.") }, 502, nocache);
      if (e && e.message === "gc-busy") return json({ error: "GoatCounter is rate limiting right now. Try again in a minute." }, 502, nocache);
      return json({ error: "GoatCounter didn't respond. Try again in a moment." }, 502, nocache);
    }
  }
  return json(await adminStats(env), 200, nocache);
}

async function adminStats(env) {
  const now = nowSec(), DAY = 86400, WEEKS = 8;
  const ids = [];
  let cursor;
  do {
    const page = await env.PLAYLISTS.list({ prefix: "lib:", cursor, limit: 1000 });
    for (const k of page.keys) ids.push(k.name.slice(4));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  // The owner's own libraries (ADMIN_EXCLUDE, comma-separated library ids) are left out of every count.
  const skip = new Set(String(env.ADMIN_EXCLUDE || "").split(/[\s,]+/).map((x) => x.split(".")[0]).filter(Boolean));
  const excluded = ids.filter((id) => skip.has(id)).length;
  if (excluded) ids.splice(0, ids.length, ...ids.filter((id) => !skip.has(id)));

  const st = { generated: now, excluded, libraries: ids.length, librariesNoHeadset: 0, librariesMulti: 0, headsets: 0,
    activeDay: 0, activeWeek: 0, activeMonth: 0, neverSynced: 0, newWeek: 0, newMonth: 0,
    sharedPlaylists: 0, hostedLinks: 0, linksByWeek: new Array(WEEKS).fill(0), activeByWeek: new Array(WEEKS).fill(0),
    // Of headsets linked 14+ days ago, how many still synced in the last 7 days.
    retentionBase: 0, retained: 0,
    // Synced at least once, but not in the last 14 days.
    goneQuiet: 0,
    // Mod version, read from what each headset says it can do (no version number is sent yet).
    modOld: 0, mod05: 0, mod07: 0, mod08: 0, modUnknown: 0, users: [], usersUnknown: 0,
    // Changes Studio queued that the headset hasn't picked up yet.
    pendingChanges: 0, pendingHeadsets: 0, pendingOldest: 0 };
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map(async (id) => {
      const lib = await env.PLAYLISTS.get("lib:" + id, "json");
      if (!lib) return;
      const devs = Array.isArray(lib.devices) ? lib.devices : [];
      st.hostedLinks += (lib.items || []).length;
      if (!devs.length) { st.librariesNoHeadset++; return; }
      const user = { id: (lib.player && lib.player.id) || "", name: (lib.player && lib.player.name) || "", headsets: devs.length, last: 0, linked: 0, mod: "" };
      if (devs.length > 1) st.librariesMulti++;
      const seen = await withSeen(env, id, devs);
      const invs = await Promise.all(devs.map((d) => env.PLAYLISTS.get(invKey(id, d.id), "json")));
      const outs = await Promise.all(devs.map(async (d) => {
        const out = await env.PLAYLISTS.get(outKey(id, d.id), "json");
        return out && Array.isArray(out.items) && out.items.length ? liveOut(env, id, d.id, out.items) : [];
      }));
      seen.forEach((d, j) => {
        st.headsets++;
        const s = d.seen || 0, added = d.added || 0;
        if (s > user.last) user.last = s;
        if (added && (!user.linked || added < user.linked)) user.linked = added;
        if (!s) st.neverSynced++;
        else {
          if (now - s < DAY) st.activeDay++;
          if (now - s < 7 * DAY) st.activeWeek++;
          if (now - s < 30 * DAY) st.activeMonth++;
          const sw = Math.floor((now - s) / (7 * DAY)); if (sw < WEEKS) st.activeByWeek[sw]++;
        }
        if (now - added < 7 * DAY) st.newWeek++;
        if (now - added < 30 * DAY) st.newMonth++;
        const w = Math.floor((now - added) / (7 * DAY)); if (added && w < WEEKS) st.linksByWeek[w]++;
        const inv = invs[j];
        if (inv && Array.isArray(inv.items)) st.sharedPlaylists += inv.items.length;
        if (now - added >= 14 * DAY) { st.retentionBase++; if (s && now - s < 7 * DAY) st.retained++; }
        if (s && now - s >= 14 * DAY) st.goneQuiet++;
        const f = inv && Array.isArray(inv.features) ? inv.features : null;
        let mv = "";
        if (!inv) st.modUnknown++;
        else if (f && f.includes("order")) { st.mod08++; mv = f.includes("missing") ? "0.9" : "0.8"; }
        else if (f && f.includes("delete-songs")) { st.mod07++; mv = "0.7"; }
        else if (f && (f.includes("restore") || f.includes("delete"))) { st.mod05++; mv = "0.5"; }
        else { st.modOld++; mv = "older"; }
        if (mv && mv !== "older" && (!user.mod || mv > user.mod)) user.mod = mv; else if (mv && !user.mod) user.mod = mv;
        const waiting = outs[j];
        if (waiting.length) {
          st.pendingChanges += waiting.length; st.pendingHeadsets++;
          for (const w of waiting) if (w.at && now - w.at > st.pendingOldest) st.pendingOldest = now - w.at;
        }
      });
      if (user.name) st.users.push(user); else st.usersUnknown++;
    }));
  }
  st.users.sort((a, b) => b.last - a.last);
  // Profile pictures from the same BeatLeader cache as the Players tab.
  try { const bl = await gcClans(env, st.users.filter((u) => u.id).slice(0, 60).map((u) => u.id)); st.users.forEach((u) => { const x = bl[u.id]; u.avatar = x ? gcAvatar(x.avatar) : ""; }); } catch (e) {}
  return st;
}

// Studio Sync icon (the same one as on the BeatLeader profile card), 92 px PNG.
const ADMIN_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAABcCAYAAADj79JYAAALF0lEQVR42u2de3BU1R3Hv7/72nuzm92QDWwSAiQBi1SD6GhAVJRhWg0+RvsAO04L1qm1M/UPRgQUX3Ws0gc++rBqnc500KkvqLTy0DrVKlpKeGhVTBRIJJD3a1/Ze+/u3dM/otaE7CObe/cR7m+GP5hz7j3nfPaX7/n9zrnnXkLG5poqKVhKcVYPjmYDrBqMaojgwSQyxuAHsRaAWhBnxxhH+/RI6HUA/Zncj8ZXvahClulWBlxFRHU4jY2BHSRGO1U1/jgw1GEy8KIKh0LrwPBjIlJg21f+AlgEhCe0CPtVOuDJBm02+PCDAHoT1eOT3EN0yI5NRPRTIhJtpCk8l0gk0IW8ILmNmP4agPh4PLxUll1/B2GxjTIjgX9XVUNXjzWxjgVckGXXWyBcaJObEPQ9qhpaCiCWVFIcsutxIlxrE5uoxmAmL0g+I6a/khC4w1F0C3F0r03LLF3H+TwvdBlGdP8YkuL0OWS0EpFsozI3etFU1ALhzhEe7pAdm4lokY3I/OiFFyEasejuLz1cluUaBv5TIuJtRNZ6Ofe5lN9rw7bUyxWHTPcBADccwdhSkgW7DABIkqQzOV762OZhvcUNfR4HTrRj7mwZJ14rcMCCfO3fWaKMy2UPLpXd8HEiPByHYo6HlxcRiRvoNwwMMgO98SgO6UM4pIVxQB/CUUMbcZ9ZvITvO8vwQKA9t7yBBQJA5fkE+RKpGCucU7BcKUGlICWsp3A8pnM8pg//D5fK7i/LumJR/HVoANsjA3hTC6JecmJjSSUA5Bg6lZMsO1tBNCuXkL2cgFVOL1a5yvA10dxV4AEjiqMxDec7XACAnw+25ww6Y2gmh+xUiciRiw7wDFjrrsB6TzkUzsKolI3MqXMFnTH4hVzBvkhy4felszBXUiwf5ehVjFzJCxE8vCBK92Ub9kZ3Jf7orUaZkI19DQLo1FXoJXIxiAFvacGsjl3IZmNFxGFLWS2WKyV5MUFvLKmEgwh3+09OPuCzeAlbp56BszKUkENaGCcNHX3xGLqMKBTw8AkiKngR54gK3HxmQ1nrqQABuCtL0LMCvIoT8YbvTFQkCfNG26ARw9OhHvxTDWCvFkIELGUbix0urHR6sbxofH9Bt3kqEAdwTxagk6y4mJUNFBOHN3zz0vbsz2IaNgc6sSXUCxWZda2EeKx2luE2d/m45olsRC+WT5rbps7BQtmVVt0HBtuxsvcoDupDIzcCx2kqGPbqYZyI6bjOWZr2ddmYSC2VlDUuH5YpqZ98a1RDuKH3KNriUVPbr3e4xn2N1SEjZxXsuYKMB0tnpKz3eKALS7qbTIcNAPWSM+Po5S53ZWF5+J+8NSnrPORvx/1+azxJBqFunBGRweLYo4Wwc2gQr0T8hQP8B04vznMk964toV7LYAPAfKkoveUCBoAY9qhBfKvnCIIsXnhh4Xp3RdLyf2tB3NzfaunA6hP84IwxvK8PQSQO1byI96NDeCTYjVcig4UZh3+vqBS1YuInLVQWx019rZYPrF76/4QZMGJ4XQ1gd8SPV1U/uuMx5MpMB77Rk3yyuXOgDS0xzfKBeTkBv/V3Yac6iD1qEDFCXpipUcpiyYXZSby7NabhD6GetO+39aUXUFNTk1Ffruz5BOv8bXhTyx/YpgO/XHEnLX840Dmu+y1f3oBDBxtxzz13QZIkTAYzFXiDnHgNQ2dxbAn3jvueDocDd2xYj0MHG9HQcIUN/Aur4EXUOYoSlr8RCUBlmS/b1NbWYtvWFyckM5MK+AUpsrqXTQq7Cl1mTANeyyffqXtXC5nW6UKWGdOA14hSkpSZ4UhMNb3zhSgzpgGfmcTDj8ZUWJkwF5LMmAbcSLJZcFiPWD6QQpEZ04Afi+pJ1k5CWRtQvsuMacB/FWzHZ2Ok7If1CJ4cR3Y52WXG1D1NHydgjbscZ4kKYozhgD6EzYGOlBvAiSwyZM5W17Fjx7D29vXYtWt3zoGbunjVFY9hw+CJgk1KBFcVPPNXQ562ACAeWt9hDDQ+AiPSm58ebrZN1MM1TcPDjzyKTZt+CV3Xk2urXIramz4E7ygeuSQRaMPxZ5eYBp3DJLWdO3fh3PMuwP33P5ASNgCU1K0+BTYASO4ZmHLBmvyUlHywTPVaLj8/YZnkqbaBT0Q+xozjvWcmEV7OBj5aPtbevh4tLS0ZzmQcxJLahMVRf4sN3MxwT/DUgJLs8Gv9n57ewCcqH6NNmZ78TSXRgSOnL/AJy8cY5p5zTcIyFjegdu4//YBblS2SIMNZvSxxLnDiHbBY5PQBbrZ8jDbP/B+C+MRrLaGWV/M3tS8E+Rjh3bwDZQvXJa0TanltkgInAUrVRXDVNsBR9nWc2HoNvv2dFZY2WbpoA3jFm7Bc7TyIaH/T5AHOF02Fs/qbcNZcDmf1MvCO4edaAs1bLW9bKp0Lb4qUvW/fZtPbzRpw78L1KK67EYQ49L4m8EoZZN8C0BhH+iId+yzvT/kVTyWPvfuaETryt8IDTlIxqq7bhqLKRWA0fDxVcid/UF/taLQWdsPTUMrPS+7d+x+1pG1LgAueWhTPXg5XbQOUqotB3PBaRDqP+MWjEajdH1gGe+qlm+CZtzL5D971PoIfPVM4wD3zrkfZ4jsyulbt+RAwVEsG6/vG71BStyplvfadN1r2g1sCvG/vgwCQEXQr5EQsnonKa/4C2Tc/Zd3uf21EdODTwgI+Eej6QLO5k/WiO9PuQ+jobgwc+I21kZmV5zQjJ94GGKFoxiVpX1M0YylABLXnA8DI8MF9XoanbjWmX70FxXOuSuuSofZGnNz+XcDi0xFZ2dP0XnQvyhauTVlv1GtNEDyyA8GmFxFp34tYKPmxbBKdkCvq4Zy1FCV1N4JP8uj0WCHg8eeWIa75rUaRvU3kdKEnslikH3rvR4iGO2GEuxGPRSAWTQOneCEWV0H2nZPRfYfaG9G+fYWpO/N5ARwAvIvvRtmidWl7uNUWPLIDHTtWgRla1trM6gtqIm1vpdT0bAHv/c+v0f36rQAzsrucke03AiWaSL84HEEWE9f6P8HJ7dcjePjZ3Kwf8YK0hghyPkC3ErahDqLn7bvRsfsWGMG2nMBmDH4BQCeQ/Y8djY7T1e73IHmqxxVdpJe5Hsbge08i0PQCWDSEHJ8g7BRoGPjcXLT+VegDjY8i+MlWKDMvQ/Hsq+E641qIrmmZQe76L4ZOvoNQ8zZEOvYiX4yATpJl53MgWpnLjngX3YnAR88gGjw+MiUvmQPZdy4cvgVQpi0Ap5SBl6eAl0vAWByx4InP/52E7m9FpHM/1I59YNEw8tIYe54k2bmBI3oItlluccbusF9nnU3ghj6P03W9iTE02zgsj1CadV1v+nxngO22kVg9YbKXv0zsZFmuZuA/tj8pY5V3M1VTaSYQ6uEAQFXVVgIes9FYFg4+BgyfLPtqHuB2yK7jk+2Lr3mg3QFNDVUBCAIjj5wEGLGf2IhMBk740RewgVHfYjNi0Q8FQVRAdLGNyhT3/oWmhh8bJS+nSo4su94EYYlNbEIT5S5NDV8JjDykmmAtxzVVltl+EM200WVEu01Vw2cDCIwuSnBaKNSjquE5jOEJm964J8mnVTU8eyzYp2j4KZloTN/B80IngAYi4mycSSXEILCbNTX8MyDx20pSvivUMKIHBJ57HuBlgJ1tfyTvFNBRBvyZWOwGTVP/kUZMPg5TlCoHaAMY3XS6Z6WMsTAIT2mIP4xIJO0XDGS8ASIoyoU8uBXEqJ4BU4jYFMZQMtl+CMaYSoRBxmiQgH7G2DvxePylaDSS0TPV/wOSFFs9iM9YvgAAAABJRU5ErkJggg==";
// ---------------------------------------------------------------- GoatCounter for the stats page (/admin/gc)
// Visitors, players, features and sources from GoatCounter, read with an API key that only the Worker holds
// (npx wrangler secret put GC_TOKEN). The page asks for it with the same ADMIN_KEY as the Studio Sync numbers.
// GoatCounter allows 4 API calls a second, so calls are spaced out and each range is cached for 5 minutes.
// GC_SITE (optional) is the GoatCounter code, playliststudio by default. ADMIN_ME (optional, comma-separated)
// are your own BeatLeader names, hidden from the player list by default. ADMIN_CLANS (optional) are the
// BeatLeader clan tags shown as clanmates, GENX and ROOT by default.
// The BeatLeader profile tab reads a second GoatCounter site: GC_SITE_BL (blprofile by default) with GC_TOKEN_BL,
// or GC_TOKEN when both sites are under the same GoatCounter account.
const GC_RANGES = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: 730 };   // all time looks back up to two years
const GC_CACHE_SEC = 300;
let gcLast = 0;
async function gcGet(env, path, params) {
  const site = String(env.GC_SITE || "playliststudio").replace(/[^a-z0-9-]/gi, "");
  const qs = new URLSearchParams();
  Object.keys(params || {}).forEach((k) => { if (params[k] != null && params[k] !== "") qs.set(k, String(params[k])); });
  for (let tries = 0; tries < 3; tries++) {
    const wait = 270 - (Date.now() - gcLast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gcLast = Date.now();
    const r = await fetch("https://" + site + ".goatcounter.com/api/v0" + path + (qs.toString() ? "?" + qs : ""), {
      headers: { Authorization: "Bearer " + env.GC_TOKEN, "Content-Type": "application/json", "User-Agent": "PlaylistStudioStats" } });
    if (r.status === 429) { const s = Math.min(5, Number(r.headers.get("X-Rate-Limit-Reset")) || 1); await new Promise((x) => setTimeout(x, s * 1000)); continue; }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("gc-auth"), { gc: r.status });
    if (!r.ok) throw Object.assign(new Error("gc-http"), { gc: r.status });
    return r.json();
  }
  throw Object.assign(new Error("gc-busy"), { gc: 429 });
}
function gcDay(t) { return new Date(t * 1000).toISOString().slice(0, 10); }
function gcIso(t) { return new Date(t * 1000).toISOString().slice(0, 19) + "Z"; }
// Every path in the range with its per-day counts. /stats/hits returns the busiest 100; the rest come
// by excluding the ones already seen.
async function gcHits(env, start, end) {
  const out = [], seen = new Set();
  for (let page = 0; page < 8; page++) {
    const j = await gcGet(env, "/stats/hits", { start: gcIso(start), end: gcIso(end), limit: 100, group: "day", exclude_paths: [...seen].join(",") });
    let fresh = 0;
    for (const h of (j && j.hits) || []) {
      if (seen.has(h.path_id)) continue;
      seen.add(h.path_id); fresh++;
      out.push({ id: h.path_id, path: h.path || "", title: h.title || "", event: !!h.event, count: h.count || 0,
        days: (h.stats || []).map((s) => [s.day, s.daily || 0]) });
    }
    if (!j || !j.more || !fresh) break;
  }
  return out;
}
async function gcList(env, page, start, end, limit) {
  try { const j = await gcGet(env, "/stats/" + page, { start: gcIso(start), end: gcIso(end), limit: limit || 20 }); return ((j && j.stats) || []).map((s) => ({ name: s.name || "", count: s.count || 0, scheme: s.ref_scheme || "" })); }
  catch (e) { if (e.message === "gc-auth") throw e; return null; }
}
function gcFirstDay(days) { for (const d of days || []) if (d[1] > 0) return d[0]; return null; }
function gcLastDay(days) { let l = null; for (const d of days || []) if (d[1] > 0) l = d[0]; return l; }
// First time each player and event ever showed up, kept in KV so "new player" and "never used" work for any
// range. The first run looks back over the whole year once to fill it in.
async function gcSeen(env, hits, now) {
  let seen = await env.PLAYLISTS.get("gc:seen", "json");
  if (!seen) {
    seen = { p: {}, e: {} };
    try { for (const h of await gcHits(env, now - 365 * 86400, now)) gcNote(seen, h); } catch (e) { if (e.message === "gc-auth") throw e; }
  }
  for (const h of hits) gcNote(seen, h);
  await env.PLAYLISTS.put("gc:seen", JSON.stringify(seen));
  return seen;
}
function gcNote(seen, h) {
  const f = gcFirstDay(h.days); if (!f) return;
  const m = /^profile\//.test(h.path) ? seen.p : h.event ? seen.e : null; if (!m) return;
  const k = h.path; if (!m[k] || f < m[k]) m[k] = f;
}
// Profile pictures only from BeatLeader's and Steam's image hosts (the page's CSP allows just these).
const GC_AVATAR_HOSTS = ["cdn.assets.beatleader.com", "cdn.assets.beatleader.xyz", "avatars.steamstatic.com", "avatars.akamai.steamstatic.com", "avatars.cloudflare.steamstatic.com"];
function gcAvatar(u) {
  try { const x = new URL(String(u || "")); return x.protocol === "https:" && GC_AVATAR_HOSTS.includes(x.hostname) ? x.toString() : ""; } catch (e) { return ""; }
}
async function gcClans(env, ids) {
  const out = {}; let fetched = 0;
  for (const id of ids) {
    const k = "gc:bl:" + id, c = await env.PLAYLISTS.get(k, "json");
    if (c && c.avatar !== undefined && nowSec() - c.t < 7 * 86400) { out[id] = c; continue; }
    if (c) out[id] = c;
    if (fetched >= 25) continue;
    fetched++;
    try {
      const r = await fetch("https://api.beatleader.xyz/player/" + encodeURIComponent(id) + "?stats=false", { headers: { "User-Agent": "PlaylistStudioStats" } });
      if (!r.ok) continue;
      const p = await r.json(), tags = ((p && p.clans) || []).map((c2) => c2 && c2.tag).filter(Boolean).slice(0, 4);
      const rec = { t: nowSec(), tags, avatar: gcAvatar(p && p.avatar) };
      out[id] = rec;
      await env.PLAYLISTS.put(k, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
    } catch (e) {}
  }
  return out;
}
async function gcGithub(env) {
  const c = await env.PLAYLISTS.get("gc:gh", "json");
  if (c && nowSec() - c.t < 3600) return c;
  const gh = (p) => fetch("https://api.github.com/repos/" + p, { headers: { "User-Agent": "PlaylistStudioStats", Accept: "application/vnd.github+json" } }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const since = gcIso(nowSec() - 95 * 86400);
  const [commits, rels] = await Promise.all([gh("Spanky3651/Playlist-Studio/commits?per_page=100&since=" + since), gh("Spanky3651/Studio-Sync/releases?per_page=20")]);
  const out = { t: nowSec(), pushes: [], releases: [] };
  if (Array.isArray(commits)) { const d = new Set(); for (const x of commits) { const at = x && x.commit && x.commit.committer && x.commit.committer.date; if (at) d.add(at.slice(0, 10)); } out.pushes = [...d].sort(); }
  if (Array.isArray(rels)) out.releases = rels.filter((r) => r && !r.draft).map((r) => ({ tag: r.tag_name || r.name || "", at: (r.published_at || "").slice(0, 10), downloads: (r.assets || []).reduce((a, x) => a + (x.download_count || 0), 0) }));
  if (!commits && !rels && c) return c;   // GitHub said no (rate limit): keep the last good copy
  await env.PLAYLISTS.put("gc:gh", JSON.stringify(out));
  return out;
}
// The BeatLeader profile page only counts views (a pixel per profile variant), so its tab gets the visit side:
// views per day, which profile page, where from, countries, phone or computer.
async function gcBlStats(env, range, fresh) {
  const e = Object.assign({}, env, { GC_SITE: env.GC_SITE_BL || "blprofile", GC_TOKEN: env.GC_TOKEN_BL || env.GC_TOKEN });
  const ck = "gc:cache:bl:" + range, cached = await env.PLAYLISTS.get(ck, "json");
  if (cached && nowSec() - cached.generated < (fresh ? 60 : GC_CACHE_SEC)) return cached;
  const now = nowSec(), DAY = 86400, n = GC_RANGES[range], today0 = Math.floor(now / DAY) * DAY;
  const start = range === "today" ? today0 : today0 - (n - 1) * DAY, end = now;
  const total = await gcGet(e, "/stats/total", { start: gcIso(start), end: gcIso(end) });
  let prev = null; if (range !== "all") try { prev = await gcGet(e, "/stats/total", { start: gcIso(start - n * DAY), end: gcIso(start) }); } catch (x) {}
  const hits = await gcHits(e, start, end);
  const [refs, sizes, locations, browsers] = [await gcList(e, "toprefs", start, end, 15), await gcList(e, "sizes", start, end, 10), await gcList(e, "locations", start, end, 12), await gcList(e, "browsers", start, end, 10)];
  let dayList = ((total && total.stats) || []).map((s) => ({ day: s.day, n: s.daily || 0, hourly: range === "today" ? s.hourly || [] : undefined }));
  if (range === "all") { const f = dayList.findIndex((x) => x.n > 0); dayList = f > 0 ? dayList.slice(f) : dayList; }
  const out = { site: "bl", generated: now, range, start: range === "all" && dayList.length ? dayList[0].day : gcDay(start), end: gcDay(end),
    visitors: (total && total.total) || 0, prevVisitors: prev ? prev.total || 0 : null, days: dayList,
    pages: hits.filter((h) => !h.event).map((h) => ({ path: h.path, title: h.title, count: h.count })), refs, sizes, locations, browsers };
  await env.PLAYLISTS.put(ck, JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}
async function gcStats(env, range, fresh, site) {
  if (!GC_RANGES[range]) range = "7d";
  if (site === "bl") return gcBlStats(env, range, fresh);
  const ck = "gc:cache:" + range, cached = await env.PLAYLISTS.get(ck, "json");
  if (cached && nowSec() - cached.generated < (fresh ? 60 : GC_CACHE_SEC)) return cached;
  const now = nowSec(), DAY = 86400, n = GC_RANGES[range];
  const today0 = Math.floor(now / DAY) * DAY;
  const start = range === "today" ? today0 : today0 - (n - 1) * DAY, end = now;
  const pstart = start - n * DAY;
  const total = await gcGet(env, "/stats/total", { start: gcIso(start), end: gcIso(end) });
  let prev = null; if (range !== "all") try { prev = await gcGet(env, "/stats/total", { start: gcIso(pstart), end: gcIso(start) }); } catch (e) {}
  const hits = await gcHits(env, start, end);
  const [refs, campaigns, sizes, locations, browsers] = [await gcList(env, "toprefs", start, end, 15), await gcList(env, "campaigns", start, end, 15),
    await gcList(env, "sizes", start, end, 10), await gcList(env, "locations", start, end, 12), await gcList(env, "browsers", start, end, 10)];
  const seen = await gcSeen(env, hits, now);
  const me = String(env.ADMIN_ME || "MSploit").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const players = hits.filter((h) => /^profile\//.test(h.path)).map((h) => {
    const name = h.path.slice(8), m = /\((\d{3,25})\)\s*$/.exec(h.title || "");
    return { name, id: m ? m[1] : "", count: h.count, last: gcLastDay(h.days), first: seen.p[h.path] || gcFirstDay(h.days), me: me.includes(name.toLowerCase()) };
  }).sort((a, b) => (b.last || "").localeCompare(a.last || "") || b.count - a.count);
  const bl = await gcClans(env, players.filter((p) => p.id).slice(0, 80).map((p) => p.id));
  players.forEach((p) => { const x = bl[p.id]; p.clans = x && !p.me ? x.tags || null : null; p.avatar = x ? gcAvatar(x.avatar) : ""; });
  const events = hits.filter((h) => h.event && !/^profile\//.test(h.path)).map((h) => ({ name: h.path.replace(/^app\//, ""), count: h.count, first: seen.e[h.path] || gcFirstDay(h.days), days: h.days }));
  const live = new Set(events.map((e) => e.name));
  const cold = Object.keys(seen.e).map((k) => k.replace(/^app\//, "")).filter((k) => !live.has(k)).sort();
  const pages = hits.filter((h) => !h.event).map((h) => ({ path: h.path, title: h.title, count: h.count }));
  const gh = await gcGithub(env);
  let dayList = ((total && total.stats) || []).map((s) => ({ day: s.day, n: s.daily || 0, hourly: range === "today" ? s.hourly || [] : undefined }));
  if (range === "all") { const f = dayList.findIndex((x) => x.n > 0); dayList = f > 0 ? dayList.slice(f) : dayList; }
  const out = { generated: now, range, start: range === "all" && dayList.length ? dayList[0].day : gcDay(start), end: gcDay(end),
    visitors: (total && total.total) || 0, eventVisitors: (total && total.total_events) || 0, prevVisitors: prev ? prev.total || 0 : null,
    days: dayList,
    players, events, cold, pages, refs, campaigns, sizes, locations, browsers,
    pushes: gh.pushes.filter((d) => d >= gcDay(start)), releases: gh.releases, myClans: String(env.ADMIN_CLANS || "GENX,ROOT").split(",").map((x) => x.trim()).filter(Boolean) };
  await env.PLAYLISTS.put(ck, JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}

const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Studio Stats</title>
<link rel="icon" type="image/png" href="${ADMIN_LOGO}">
<style>
:root{--bg:#000;--card:#0b0f17;--line:#1f2a3d;--text:#f2f5fa;--muted:#9aa6b8;--blue:#2f7bff;--red:#ff2740;--green:#3ddc84;--amber:#ffc23d;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,'Segoe UI',Arial,sans-serif;padding:24px 16px 48px}
main{max-width:980px;margin:0 auto}
h1{font-size:26px;margin:0}
.brand{display:flex;align-items:center;gap:12px;margin:0 0 6px}
.brand img{width:44px;height:44px;border-radius:11px;box-shadow:0 0 16px rgba(47,123,255,.25);flex:none}
.sub{color:var(--muted);font-size:15px;margin:0 0 22px}
.keyrow{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:11px 13px;font-size:16px;font-family:inherit}
.keyrow input{min-width:220px}
button{background:var(--blue);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--muted)}
.msg{color:var(--muted);font-size:15px;min-height:22px;margin:0 0 16px}
.msg.err{color:#ff8a98}
.msg:empty{display:none}
.embed body{padding-top:16px}
.embed .brand,.embed .top .sub{display:none}
.embed .top{justify-content:flex-end;margin-bottom:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;min-width:0}
.label{font-size:13px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.value{font-size:34px;font-weight:800;margin-top:2px;overflow-wrap:anywhere}
.note{font-size:14px;color:var(--muted)}
.up{color:var(--green);font-weight:700}.down{color:#ff8a98;font-weight:700}
.hero .value{color:var(--green)}
.value.bad{color:#ff8a98}
h2{font-size:18px;margin:26px 0 10px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
h2 small{font-size:14px;color:var(--muted);font-weight:500}
.bars{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.bar{display:grid;grid-template-columns:minmax(110px,200px) 1fr 56px;align-items:center;gap:10px;margin:6px 0;font-size:15px}
.bar .lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar code,.mono{font:13.5px ui-monospace,Consolas,monospace;color:#cfe0ff}
.track{height:14px;background:#111827;border-radius:7px;overflow:hidden}
.fill{height:100%;border-radius:7px;background:var(--blue);display:block}
.fill.alt{background:var(--red)}.fill.g{background:var(--green)}.fill.a{background:var(--amber)}
.num{text-align:right;font-weight:700}
.empty{color:var(--muted);font-size:15px;margin:2px 0}
.hidden{display:none !important}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.top .sub{margin:0}
.tools{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap}
.tools button{padding:7px 12px;font-size:14px;font-weight:600}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:16px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{background:none;border:0;border-bottom:3px solid transparent;border-radius:0;color:var(--muted);padding:10px 14px;font-size:15.5px;font-weight:700;white-space:nowrap;flex:none}
.tabs button[aria-selected="true"]{color:var(--text);border-bottom-color:var(--blue)}
.range{display:flex;gap:6px;margin:0 0 16px;flex-wrap:wrap;align-items:center}
.range span{color:var(--muted);font-size:14px;margin-right:4px}
.range button,.chip{background:var(--card);border:1px solid var(--line);color:var(--muted);padding:7px 13px;font-size:14px;font-weight:600;border-radius:20px}
.range button[aria-pressed="true"],.chip[aria-pressed="true"]{border-color:var(--blue);color:#fff;background:rgba(47,123,255,.16)}
.chart{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.chart svg{width:100%;height:220px;display:block}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:14px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.alert{display:flex;gap:10px;align-items:flex-start;background:rgba(255,39,64,.08);border:1px solid rgba(255,39,64,.45);border-radius:12px;padding:11px 14px;font-size:15px;margin:0 0 16px;color:#ffc2cb}
.alert b{color:#fff}
.gcmsg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;color:var(--muted);font-size:15px}
.gcmsg b{color:var(--text)}
.gcmsg code{color:#cfe0ff}
.pf{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.pf input{min-width:180px;padding:9px 12px;font-size:15px}
.plist{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.prow{display:grid;grid-template-columns:minmax(0,1fr) 110px 120px 80px;gap:10px;align-items:center;padding:11px 16px;border-top:1px solid #141c2a;font-size:15px}
.prow.head{border-top:0;font-size:12.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);font-weight:600;padding-top:12px;padding-bottom:8px}
.pwho{display:flex;align-items:center;gap:11px;min-width:0}
.pav{position:relative;flex:none;width:36px;height:36px;border-radius:9px;background:#141c2a;border:1px solid var(--line);display:grid;place-items:center;font-weight:800;font-size:15px;color:var(--muted);overflow:hidden}
.pav img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.pname{min-width:0}
.prow a{color:#cfe0ff;text-decoration:none;font-weight:700;overflow-wrap:anywhere}
.prow a:hover{text-decoration:underline}
.prow .n{text-align:right;font-weight:700}
.pb{font-size:11.5px;font-weight:700;border-radius:6px;padding:1px 7px;margin-left:6px;border:1px solid;white-space:nowrap;display:inline-block}
.pb.new{color:#9ff0c4;border-color:#1d4a33;background:#06140d}.pb.back{color:#8fbaff;border-color:#1f3456}
.pb.clan{color:var(--muted);border-color:var(--line)}.pb.mine{color:#ffd28a;border-color:#4a3a1c}.pb.me{color:var(--muted);border-color:var(--line);border-style:dashed}
.more{margin-top:10px;padding:7px 12px;font-size:14px;font-weight:600}
.when{color:var(--muted);font-size:14px;margin-top:18px}
.funnel .bar{grid-template-columns:minmax(120px,190px) 1fr 110px}
.bars.feat .bar{grid-template-columns:minmax(0,1.3fr) minmax(80px,1fr) 56px;margin:9px 0}
.bar .fl{display:flex;flex-direction:column;white-space:normal;line-height:1.3;min-width:0}
.bar .fl b{font-weight:700;color:var(--text)}
.fd{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.fd code{font-size:12px;color:#8fa6c8}
.coldlist{display:flex;flex-wrap:wrap;gap:8px}
.coldlist span{border:1px solid var(--line);border-radius:8px;padding:4px 9px;font-size:14px;color:var(--muted)}
.funnel .num small{display:block;color:var(--muted);font-weight:500;font-size:12.5px}
@media(max-width:700px){
  body{padding:18px 12px 40px}
  .grid{grid-template-columns:1fr 1fr;gap:10px}
  .card{padding:12px 14px}
  .value{font-size:28px}
  .two{grid-template-columns:1fr}
  .bar{grid-template-columns:minmax(0,1fr) 34% 48px;gap:8px;font-size:14.5px}
  .funnel .bar{grid-template-columns:minmax(0,1fr) 30% 84px}
  .bars{padding:12px 14px}
  .prow{grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:11px 14px}
  .prow.head{display:none}
  .prow .c-first{display:none}
  .prow .c-last{grid-column:1;grid-row:2;color:var(--muted);font-size:13.5px}
  .prow .n{grid-column:2;grid-row:1 / span 2}
  .chart svg{height:180px}
  .funnel .lab{white-space:normal}
  .bars.feat .bar{grid-template-columns:minmax(0,1fr) 26% 44px}
  .ofv{display:none}
  .range span{display:none}
  .range button{padding:6px 11px;font-size:13.5px}
  .tab-long{display:none}
}
.tab-short{display:none}
@media(max-width:700px){.tab-short{display:inline}}
@media(max-width:380px){.grid{grid-template-columns:1fr}}
</style></head><body><main>
<div class="top"><div><div class="brand"><img src="${ADMIN_LOGO}" alt="" width="44" height="44"><h1>Studio stats</h1></div>
<p class="sub">Visitors, players and features from GoatCounter, and headsets from Studio Sync.</p></div>
<div class="tools hidden" id="tools"><button id="refresh" class="ghost">Refresh</button><button id="forget" class="ghost">Forget key</button></div></div>
<div class="keyrow" id="keyrow"><input id="key" type="password" placeholder="Admin key" autocomplete="current-password">
<button id="go">Show stats</button></div>
<p class="msg" id="msg"></p>
<div id="out" class="hidden">
<div class="tabs" role="tablist" id="tabs">
<button role="tab" data-tab="vis" aria-selected="true">Visitors</button>
<button role="tab" data-tab="ply" aria-selected="false">Players</button>
<button role="tab" data-tab="feat" aria-selected="false">Features</button>
<button role="tab" data-tab="src" aria-selected="false"><span class="tab-long">Where they come from</span><span class="tab-short">Sources</span></button>
<button role="tab" data-tab="bl" aria-selected="false"><span class="tab-long">BeatLeader profile</span><span class="tab-short">BL profile</span></button>
<button role="tab" data-tab="sync" aria-selected="false">Studio Sync</button>
</div>
<div class="range" id="range"><span>Range</span><button data-r="today" aria-pressed="true">Today</button><button data-r="7d" aria-pressed="false">7 days</button><button data-r="30d" aria-pressed="false">30 days</button><button data-r="90d" aria-pressed="false">90 days</button><button data-r="all" aria-pressed="false">All time</button></div>
<div id="gcmsg" class="gcmsg hidden"></div>

<section data-sec="vis">
<div id="alert" class="alert hidden"></div>
<div class="grid">
<div class="card hero"><div class="label">Visitors</div><div class="value" id="v-vis">-</div><div class="note" id="v-visn"></div></div>
<div class="card"><div class="label" id="v-todl">Today</div><div class="value" id="v-tod">-</div><div class="note" id="v-todn"></div></div>
<div class="card"><div class="label">Built a playlist</div><div class="value" id="v-built">-</div><div class="note" id="v-builtn"></div></div>
<div class="card"><div class="label">Connected a profile</div><div class="value" id="v-conn">-</div><div class="note" id="v-connn"></div></div>
</div>
<h2 id="v-charth">Visitors per day <small>dots are days you pushed changes</small></h2>
<div class="chart"><svg id="v-chart" viewBox="0 0 700 220" preserveAspectRatio="none" role="img" aria-label="Visitors per day"></svg>
<div class="legend"><span><i style="background:var(--blue)"></i>Visitors</span><span><i style="background:var(--green)"></i>Built a playlist</span><span id="v-pushleg"><i style="background:var(--amber);border-radius:50%"></i>Push to GitHub</span></div></div>
<div class="two" style="margin-top:4px">
<div><h2>Phone or computer</h2><div class="bars" id="v-dev"></div></div>
<div><h2>Countries</h2><div class="bars" id="v-geo"></div></div>
</div>
<h2>From visit to playlist <small>about, since each step counts people per event</small></h2>
<div class="bars funnel" id="v-fun"></div>
</section>

<section data-sec="ply" class="hidden">
<div class="grid">
<div class="card hero"><div class="label">Players</div><div class="value" id="p-all">-</div><div class="note">connected a BeatLeader profile</div></div>
<div class="card"><div class="label">New players</div><div class="value" id="p-new">-</div><div class="note" id="p-newn">first time ever connecting</div></div>
<div class="card"><div class="label">Came back</div><div class="value" id="p-back">-</div><div class="note" id="p-backn">connected before this range too</div></div>
<div class="card"><div class="label">Your clanmates</div><div class="value" id="p-clan">-</div><div class="note" id="p-clann"></div></div>
</div>
<h2>Who used it <small>tap a name to open their BeatLeader profile</small></h2>
<div class="pf"><input id="p-find" type="search" placeholder="Find a player" aria-label="Find a player"><button class="chip" id="p-fnew" aria-pressed="false">New only</button><button class="chip" id="p-fclan" aria-pressed="false">Clanmates</button><button class="chip" id="p-fme" aria-pressed="true">Hide me</button></div>
<div class="plist" id="p-list"></div>
<button class="ghost more hidden" id="p-more">Show more</button>
<p class="when">Names come from the profile connects Studio sends to GoatCounter. Someone who only browses without connecting stays anonymous.</p>
</section>

<section data-sec="feat" class="hidden">
<div class="grid">
<div class="card"><div class="label">Features used</div><div class="value" id="f-used">-</div><div class="note">different events in this range</div></div>
<div class="card"><div class="label">Not used</div><div class="value" id="f-cold">-</div><div class="note">seen before, nothing in this range</div></div>
<div class="card"><div class="label">Problems</div><div class="value" id="f-prob">-</div><div class="note">script errors and failed loads</div></div>
</div>
<h2>By area</h2><div class="bars" id="f-areas"></div>
<h2>Most used</h2><div class="bars feat" id="f-top"></div><button class="ghost more hidden" id="f-more">Show all</button>
<h2>New in the last 30 days <small>features first used recently</small></h2><div class="bars feat" id="f-fresh"></div>
<h2>Problems</h2><div class="bars feat" id="f-probs"></div>
<h2>Not used in this range <small>candidates to simplify or cut</small></h2><div class="bars" id="f-colds"></div>
</section>

<section data-sec="src" class="hidden">
<div class="grid">
<div class="card hero"><div class="label">From your links</div><div class="value" id="s-camp">-</div><div class="note">visits with a utm tag</div></div>
<div class="card"><div class="label">From search engines</div><div class="value" id="s-search">-</div><div class="note">Google, Bing, DuckDuckGo and others</div></div>
<div class="card"><div class="label">From other sites</div><div class="value" id="s-sites">-</div><div class="note">links on Reddit, Discord, BeatLeader...</div></div>
</div>
<h2>Your campaigns <small>utm_campaign</small></h2><div class="bars" id="s-camps"></div>
<h2>Sites sending people</h2><div class="bars" id="s-refs"></div>
<h2>Landing on</h2><div class="bars" id="s-pages"></div>
<h2>Browsers</h2><div class="bars" id="s-br"></div>
</section>

<section data-sec="bl" class="hidden">
<div id="b-msg" class="gcmsg hidden"></div>
<div class="grid">
<div class="card hero"><div class="label">Profile views</div><div class="value" id="b-vis">-</div><div class="note" id="b-visn"></div></div>
<div class="card"><div class="label" id="b-todl">Today</div><div class="value" id="b-tod">-</div><div class="note" id="b-todn"></div></div>
<div class="card"><div class="label">Busiest day</div><div class="value" id="b-best">-</div><div class="note" id="b-bestn"></div></div>
<div class="card"><div class="label">On phones</div><div class="value" id="b-phone">-</div><div class="note">of views with a known screen size</div></div>
</div>
<h2 id="b-charth">Views per day</h2>
<div class="chart"><svg id="b-chart" viewBox="0 0 700 220" preserveAspectRatio="none" role="img" aria-label="Profile views per day"></svg></div>
<h2>Pages counted</h2><div class="bars" id="b-pages"></div>
<div class="two">
<div><h2>Where from</h2><div class="bars" id="b-refs"></div></div>
<div><h2>Countries</h2><div class="bars" id="b-geo"></div></div>
</div>
<h2>Phone or computer</h2><div class="bars" id="b-dev"></div>
<p class="when" id="b-when"></p>
</section>

<section data-sec="sync" class="hidden">
<div class="grid">
<div class="card hero"><div class="label">Active today</div><div class="value" id="activeDay"></div><div class="note">synced in the last 24 hours</div></div>
<div class="card hero"><div class="label">Active this week</div><div class="value" id="activeWeek"></div><div class="note">last 7 days</div></div>
<div class="card"><div class="label">Active this month</div><div class="value" id="activeMonth"></div><div class="note">last 30 days</div></div>
<div class="card"><div class="label">Headsets linked</div><div class="value" id="headsets"></div><div class="note" id="neverNote"></div></div>
<div class="card"><div class="label">New this week</div><div class="value" id="newWeek"></div><div class="note" id="newMonthNote"></div></div>
<div class="card"><div class="label">Players</div><div class="value" id="players"></div><div class="note" id="multiNote"></div></div>
<div class="card"><div class="label">Playlists shared</div><div class="value" id="sharedPlaylists"></div><div class="note">from headsets to Studio</div></div>
<div class="card"><div class="label">Started, not linked</div><div class="value" id="librariesNoHeadset"></div><div class="note">opened linking but no headset yet</div></div>
<div class="card hidden" id="dlCard"><div class="label">Mod downloads</div><div class="value" id="dlTotal"></div><div class="note">all Studio Sync releases on GitHub</div></div>
</div>
<h2>Studio Sync users <small>tap a name to open their BeatLeader profile</small></h2>
<div class="plist" id="u-list"></div>
<p class="when" id="u-note"></p>
<div id="relWrap" class="hidden"><h2>Downloads per release</h2><div class="bars" id="relBars"></div></div>
<h2>Keeping people</h2>
<div class="grid">
<div class="card hero"><div class="label">Retention</div><div class="value" id="retention"></div><div class="note" id="retentionNote"></div></div>
<div class="card"><div class="label">Gone quiet</div><div class="value" id="goneQuiet"></div><div class="note">synced before, nothing in 14+ days</div></div>
<div class="card"><div class="label">Waiting for headsets</div><div class="value" id="pendingChanges"></div><div class="note" id="pendingNote"></div></div>
</div>
<h2>Mod versions</h2><div class="bars" id="modBars"></div>
<h2>New headsets per week</h2><div class="bars" id="linksBars"></div>
<h2>Headsets by last sync</h2><div class="bars" id="activeBars"></div>
<p class="when" id="when"></p>
</section>
<p class="when" id="gcwhen"></p>
</div>
</main>
<script>
(function () {
  var embedded = /[?&]embed=1/.test(location.search);
  if (embedded) {
    document.documentElement.classList.add('embed');
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') try { parent.postMessage('studio-sync-stats-close', 'https://spanky3651.github.io'); } catch (x) {} });
  }
  var K = 'studioSyncAdminKey', keyIn = document.getElementById('key'), msg = document.getElementById('msg');
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }
  function getKey() { return ls(K) || ''; }
  function setKey(v) { ls(K, v || null); }
  function $(id) { return document.getElementById(id); }
  function txt(id, v) { $(id).textContent = v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function signedIn(on) { $('keyrow').classList.toggle('hidden', on); $('tools').classList.toggle('hidden', !on); if (!on) $('out').classList.add('hidden'); }
  function say(t, err) { msg.textContent = t; msg.className = 'msg' + (err ? ' err' : ''); }
  // rows: [label html, count, fill class, shown number text]
  function bars(id, rows, cls, emptyText) {
    var el = $(id);
    if (!rows.length) { el.innerHTML = '<p class="empty">' + esc(emptyText || 'Nothing yet in this range.') + '</p>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([1]));
    el.innerHTML = rows.map(function (r) {
      return '<div class="bar"><span class="lab">' + r[0] + '</span><span class="track"><span class="fill ' + (r[2] || cls || '') + '" style="width:' + Math.max(r[1] ? 2 : 0, Math.round(r[1] / max * 100)) + '%"></span></span><span class="num">' + (r[3] != null ? r[3] : fmt(r[1])) + '</span></div>';
    }).join('');
  }
  function weekBars(id, data, alt) { bars(id, data.map(function (n, i) { return [i === 0 ? 'This week' : i === 1 ? 'Last week' : i + ' weeks ago', n, alt ? 'alt' : '']; })); }
  function ago(sec) { var h = Math.floor(sec / 3600); return h < 1 ? 'under an hour' : h < 48 ? h + ' hour' + (h === 1 ? '' : 's') : Math.floor(h / 24) + ' days'; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dshort(d) { if (!d) return '-'; var p = d.split('-'); return MON[+p[1] - 1] + ' ' + (+p[2]); }
  function dago(d) {
    if (!d) return '-';
    var t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), n = Math.floor((Date.now() - t) / 86400000);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago';
  }

  // ---- tabs and range ----
  var tab = ls('studioStatsTab') || 'vis', range = 'today', gc = null, gcBusy = false, sync = null;
  function showTab(t) {
    if (!document.querySelector('[data-sec="' + t + '"]')) t = 'vis';
    tab = t; ls('studioStatsTab', t);
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === t ? 'true' : 'false'); });
    Array.prototype.forEach.call(document.querySelectorAll('section[data-sec]'), function (s) { s.classList.toggle('hidden', s.getAttribute('data-sec') !== t); });
    $('range').classList.toggle('hidden', t === 'sync');
    $('gcmsg').classList.toggle('hidden', t === 'sync' || t === 'bl' || !$('gcmsg').textContent);
    $('gcwhen').classList.toggle('hidden', t === 'sync' || t === 'bl');
    if (t === 'vis' && gc) chart(gc, dailyWhere(BUILD));
    if (t === 'bl') { if (bl && bl.range === range) chart(bl, null, BLIDS); else if (getKey() && $('out') && !$('out').classList.contains('hidden')) loadBl(false); }
    if (t !== 'bl' && t !== 'sync' && gc && gc.range !== range) loadGc(false);
  }
  function showRange() { Array.prototype.forEach.call(document.querySelectorAll('#range button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-r') === range ? 'true' : 'false'); }); }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-tab]'); if (b) showTab(b.getAttribute('data-tab')); });
  $('range').addEventListener('click', function (e) { var b = e.target.closest('button[data-r]'); if (!b || b.getAttribute('data-r') === range) return; range = b.getAttribute('data-r'); showRange(); if (tab === 'bl') loadBl(false); else loadGc(false); });

  // ---- GoatCounter ----
  var BUILD = /^(export|quest-send|lq-add|lq-add-to|lq-add-to-mine|lq-upload-.*|share-create)$/;
  var SEARCH = /^(search-beatleader|search-beatsaver|search-recommend)$/;
  var ADD = /^(row-add|top-plays|build-from-plays|quick-add|gallery-load|stats-top-plays|versus-build)$/;
  var PROB = /(^js-error|fail)/;
  function ev(name) { var x = null; (gc.events || []).forEach(function (e) { if (e.name === name) x = e; }); return x; }
  function sumWhere(re) { var n = 0; gc.events.forEach(function (e) { if (re.test(e.name)) n += e.count; }); return n; }
  function maxWhere(re) { var n = 0; gc.events.forEach(function (e) { if (re.test(e.name) && e.count > n) n = e.count; }); return n; }
  function dailyWhere(re) { var m = {}; gc.events.forEach(function (e) { if (re.test(e.name)) (e.days || []).forEach(function (d) { m[d[0]] = (m[d[0]] || 0) + d[1]; }); }); return m; }
  function gcMsg(t) { var el = $('gcmsg'); el.innerHTML = t; el.classList.toggle('hidden', !t || tab === 'sync' || tab === 'bl'); }
  function loadGc(fresh) {
    var key = getKey(); if (!key || gcBusy) return;
    gcBusy = true; gcMsg(gc ? '' : 'Loading GoatCounter...'); txt('gcwhen', 'Loading ' + $('range').querySelector('[aria-pressed="true"]').textContent + '...');
    fetch('/admin/gc?range=' + encodeURIComponent(range) + (fresh ? '&fresh=1' : ''), { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      gcBusy = false;
      if (!res.ok) {
        txt('gcwhen', '');
        if (res.status === 401) { setKey(''); signedIn(false); say(res.j.error || 'Wrong key', true); return; }
        if (res.j.setup) gcMsg('<b>GoatCounter isn’t connected yet.</b> Make an API key in GoatCounter (your name at the top, then API, with permission to read statistics), then in the Playlist-Studio <code>worker</code> folder run <code>npx wrangler secret put GC_TOKEN</code> and paste it.');
        else gcMsg(esc(res.j.error || 'Couldn’t load GoatCounter.'));
        return;
      }
      gc = res.j; gcMsg(''); renderGc();
    }).catch(function () { gcBusy = false; txt('gcwhen', ''); gcMsg('Couldn’t reach the Worker.'); });
  }
  function renderGc() {
    var d = gc, built = Math.min(d.visitors, sumWhere(BUILD)), conn = ev('connect-profile');
    // Visitors
    txt('v-vis', fmt(d.visitors));
    if (d.prevVisitors != null && d.prevVisitors > 0) { var ch = Math.round((d.visitors - d.prevVisitors) / d.prevVisitors * 100); $('v-visn').innerHTML = '<span class="' + (ch >= 0 ? 'up' : 'down') + '">' + (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch) + '%</span> vs the ' + ({ today: 'day', '7d': '7 days', '30d': '30 days', '90d': '90 days' }[d.range] || 'period') + ' before'; }
    else txt('v-visn', d.range === 'today' ? 'so far today' : d.range === 'all' ? 'since ' + dshort(d.start) : dshort(d.start) + ' to ' + dshort(d.end));
    var last = d.days.length ? d.days[d.days.length - 1] : null;
    if (d.range === 'today') {
      var hr = (last && last.hourly) || [], best = -1, bi = 0; hr.forEach(function (n, i) { if (n > best) { best = n; bi = i; } });
      txt('v-todl', 'Busiest hour'); txt('v-tod', best > 0 ? (bi % 12 || 12) + (bi < 12 ? ' AM' : ' PM') : '-'); txt('v-todn', best > 0 ? best + ' visitors, UTC' : 'no visits yet');
    } else { txt('v-todl', 'Today'); txt('v-tod', fmt(last ? last.n : 0)); txt('v-todn', 'visitors so far, UTC day'); }
    txt('v-built', fmt(built)); txt('v-builtn', 'downloaded, sent or synced' + (d.visitors ? ' · ' + Math.round(built / d.visitors * 100) + '% of visitors' : ''));
    txt('v-conn', fmt(conn ? conn.count : 0)); txt('v-connn', d.visitors ? Math.round((conn ? conn.count : 0) / d.visitors * 100) + '% of visitors' : '');
    var errs = ev('js-error'), al = $('alert');
    if (errs && errs.days && errs.days.length > 2) {
      var ds = errs.days, lastE = ds[ds.length - 1][1], prevE = ds[ds.length - 2][1], rest = ds.slice(0, -2).map(function (x) { return x[1]; }), avg = rest.length ? rest.reduce(function (a, b) { return a + b; }, 0) / rest.length : 0, peak = Math.max(lastE, prevE);
      if (peak >= 5 && peak >= 3 * Math.max(avg, 1)) { al.innerHTML = '<span>⚠</span><span><b>js-error jumped to ' + peak + ' ' + (peak === lastE ? 'today' : 'yesterday') + '</b> (usually about ' + Math.round(avg) + ' a day). See Problems on the Features tab.</span>'; al.classList.remove('hidden'); }
      else al.classList.add('hidden');
    } else al.classList.add('hidden');
    chart(d, dailyWhere(BUILD));
    var dev = { Phone: 0, Tablet: 0, Computer: 0, Unknown: 0 };
    (d.sizes || []).forEach(function (s) { var n = s.name.toLowerCase(); dev[/phone/.test(n) && !/tablet/.test(n) ? 'Phone' : /phone|tablet/.test(n) ? 'Tablet' : /monitor|computer|laptop|desktop/.test(n) ? 'Computer' : 'Unknown'] += s.count; });
    bars('v-dev', [['Phone', dev.Phone, 'a'], ['Computer', dev.Computer], ['Tablet or small laptop', dev.Tablet, 'g'], ['Unknown', dev.Unknown, '']].filter(function (r) { return r[1] > 0; }));
    bars('v-geo', (d.locations || []).slice(0, 8).map(function (s) { return [esc(s.name || 'Unknown'), s.count]; }));
    var F = [['Visited', d.visitors], ['Connected a profile', conn ? conn.count : 0], ['Searched', maxWhere(SEARCH)], ['Added maps', maxWhere(ADD)], ['Downloaded or sent', built]];
    var top = Math.max(1, d.visitors);
    $('v-fun').innerHTML = F.map(function (f, i) { var p = Math.min(100, Math.round(f[1] / top * 100)); return '<div class="bar"><span class="lab">' + f[0] + '</span><span class="track"><span class="fill' + (i === F.length - 1 ? ' g' : '') + '" style="width:' + p + '%"></span></span><span class="num">' + fmt(f[1]) + '<small>' + p + '%<span class="ofv"> of visitors</span></small></span></div>'; }).join('');
    renderPlayers();
    // Features
    var evs = d.events.slice().sort(function (a, b) { return b.count - a.count; }), probs = evs.filter(function (e) { return PROB.test(e.name); }), use = evs.filter(function (e) { return !PROB.test(e.name); });
    txt('f-used', fmt(use.length)); txt('f-cold', fmt(d.cold.length)); txt('f-prob', fmt(probs.reduce(function (a, e) { return a + e.count; }, 0)));
    $('f-prob').classList.toggle('bad', probs.length > 0);
    var showAll = $('f-more').getAttribute('data-all') === '1';
    var areas = {}; use.forEach(function (e) { var a = featInfo(e.name).area; areas[a] = (areas[a] || 0) + e.count; });
    bars('f-areas', Object.keys(areas).map(function (a) { return [esc(a), areas[a]]; }).sort(function (a, b) { return b[1] - a[1]; }));
    bars('f-top', use.slice(0, showAll ? 999 : 15).map(function (e) { return featRow(e); }));
    $('f-more').classList.toggle('hidden', use.length <= 15); $('f-more').textContent = showAll ? 'Show fewer' : 'Show all ' + use.length;
    var cut = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    bars('f-fresh', use.filter(function (e) { return e.first && e.first >= cut; }).map(function (e) { var r = featRow(e, 'g'); r[0] = r[0].replace('</b>', '</b><span class="fd">first used ' + dshort(e.first) + '</span>'); return r; }), '', 'Nothing new in the last 30 days.');
    bars('f-probs', probs.map(function (e) { return featRow(e, 'alt'); }), '', 'No problems in this range.');
    $('f-colds').innerHTML = d.cold.length ? '<div class="coldlist">' + d.cold.map(function (n) { var f = featInfo(n); return '<span title="' + esc(f.desc + ' (' + n + ')') + '">' + esc(f.label) + '</span>'; }).join('') + '</div>' : '<p class="empty">Every feature seen before was used in this range.</p>';
    // Sources
    var camps = (d.campaigns || []), refs = (d.refs || []).filter(function (r) { return r.scheme !== 'c'; }), SE = /google|bing|duckduckgo|yahoo|yandex|ecosia|brave|startpage|baidu|qwant/i;
    txt('s-camp', fmt(camps.reduce(function (a, c) { return a + c.count; }, 0)));
    txt('s-search', fmt(refs.filter(function (r) { return SE.test(r.name); }).reduce(function (a, r) { return a + r.count; }, 0)));
    txt('s-sites', fmt(refs.filter(function (r) { return !SE.test(r.name) && r.name; }).reduce(function (a, r) { return a + r.count; }, 0)));
    bars('s-camps', camps.map(function (c) { return [esc(c.name || '(none)'), c.count, 'g']; }), '', 'No tagged links used in this range.');
    bars('s-refs', refs.filter(function (r) { return r.name; }).map(function (r) { return [esc(r.name), r.count]; }));
    bars('s-pages', (d.pages || []).slice(0, 10).map(function (p) { return ['<span class="mono">' + esc(p.path || '/') + '</span>', p.count]; }));
    bars('s-br', (d.browsers || []).slice(0, 8).map(function (b) { return [esc(b.name || 'Unknown'), b.count]; }));
    renderReleases();
    txt('gcwhen', 'GoatCounter ' + dshort(d.start) + (d.start !== d.end ? ' to ' + dshort(d.end) : '') + ' (UTC days). Updated ' + new Date(d.generated * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ', kept for 5 minutes.');
  }
  // ---- what each event means ----
  // [area, short name, what the person did]. Names ending in * cover a family (the rest of the name is shown).
  var FEAT = {
    'search-beatleader': ['Search', 'Searched BeatLeader', 'Ran a search of the ranked BeatLeader catalog'],
    'search-beatsaver': ['Search', 'Searched BeatSaver', 'Ran a search of BeatSaver by tags or text'],
    'search-recommend': ['For You', 'Top pp gains search', 'Loaded the unplayed maps that add the most pp'],
    'bsr-hop': ['Search', 'Searched a BSR code', 'Typed a BSR code into search and jumped to that map'],
    'bsr-hop-fallback': ['Search', 'BSR code fallback', 'A BSR code search fell back to BeatSaver'],
    'bsr-hop-text': ['Search', 'BSR code as text', 'Searched what looked like a BSR code as plain text'],
    'diff-change': ['Search', 'Changed difficulties', 'Turned difficulty filters on or changed them'],
    'pp-filter': ['Search', 'PP range filter', 'Used the PP Range panel'],
    'level-*': ['Search', 'Star level chip', 'Picked a star level chip (Learning, Comfortable, Pushing...)'],
    'level-auto-default': ['Search', 'Default star level', 'A new visitor got the 4 to 7 star starting level'],
    'level-auto-me': ['Search', 'My level from profile', 'Studio set the star level from their scores'],
    'newbie-easier': ['Search', 'Easier maps for a new player', 'Took the "show easier maps" offer'],
    'newbie-hint-dismiss': ['Search', 'Closed new player tip', 'Dismissed the new player hint'],
    'accsaber-load': ['Search', 'AccSaber Pools', 'Loaded an AccSaber ranked pool'],
    'accsaber-cat-*': ['Search', 'AccSaber category', 'Picked an AccSaber category'],
    'maps-like-this': ['Search', 'Maps like this', 'Found maps similar to one map'],
    'nofail-chip': ['Search', 'No Fail runs chip', 'Filtered results to their No Fail runs'],
    'nofail-quick': ['Search', 'No Fail quick list', 'Used the No Fail quick list'],
    'density-*': ['Results', 'Row density', 'Switched between compact and roomy rows'],
    'results-more': ['Results', 'Results menu', 'Opened the ... menu above the results'],
    'results-more-head': ['Results', '+ Add on phones', 'Opened + Add in the Search Results header on a phone'],
    'row-add': ['Playlist', 'Added a map', 'Added one map from the results to Your Playlist'],
    'row-unadd': ['Playlist', 'Removed from a result row', 'Took a map back out from its result row'],
    'row-replay': ['Results', 'Watched a replay', 'Opened a replay from a result row'],
    'top-plays': ['Profile', 'Top plays to playlist', 'Loaded their top 25 to 500 pp plays'],
    'build-from-plays': ['Profile', 'Built from my plays', 'Loaded every map they have played'],
    'quick-add': ['Playlist', 'Quick Add', 'Pasted BSR codes, links or hashes into Quick Add'],
    'undo': ['Playlist', 'Undo', 'Undid a playlist change'],
    'redo': ['Playlist', 'Redo', 'Redid a playlist change'],
    'sel-*': ['Playlist', 'Select mode', 'Used select mode on the playlist'],
    'refine': ['Playlist', 'Refine Playlist', 'Used a Refine Playlist tool'],
    'refresh-stars': ['Playlist', 'Refresh ratings', 'Refreshed star ratings for the playlist'],
    'fill-data': ['Playlist', 'Fill data', 'Filled missing map data for imported maps'],
    'session-ramp': ['Playlist', 'Warm-up order', 'Reordered the playlist from easy to hard'],
    'playlist-name': ['Playlist', 'Named a playlist', 'Typed a name in the new Name field'],
    'import': ['Playlist', 'Imported a .bplist', 'Opened a playlist file into Studio'],
    'combine-open-*': ['Playlist', 'Combine playlists', 'Opened Combine playlists'],
    'save-playlist': ['Library', 'Saved to library', 'Saved a playlist to the browser library'],
    'load-playlist': ['Library', 'Opened from library', 'Opened a saved playlist'],
    'library-backup': ['Library', 'Library backup', 'Downloaded a backup of their library'],
    'library-restore': ['Library', 'Library restore', 'Restored a library backup'],
    'export': ['Save and send', 'Downloaded a .bplist', 'Downloaded the playlist file'],
    'export-tab-*': ['Save and send', 'Save and send tab', 'Switched tabs in Save and send'],
    'quest-send': ['Save and send', 'Sent over USB', 'Sent the playlist to a Quest over a cable'],
    'quest-connect': ['Save and send', 'Quest USB connect', 'Started connecting a Quest over USB'],
    'quest-auth-wait': ['Save and send', 'Waiting on Quest allow', 'Waited for "Allow USB debugging" on the headset'],
    'quest-no-answer': ['Problems', 'Quest USB no answer', 'The Quest didn\u2019t answer over USB'],
    'quest-cancel': ['Save and send', 'Quest USB cancelled', 'Cancelled sending over USB'],
    'cable-pitch': ['Studio Sync', 'Saw the Studio Sync pitch', 'Saw the "skip the cable" Studio Sync card'],
    'cable-pitch-no': ['Studio Sync', 'Dismissed the pitch', 'Pressed Not now on the Studio Sync card'],
    'share-create': ['Share', 'Made a share link', 'Created a share link for a playlist'],
    'share-open': ['Share', 'Opened a share link', 'Opened someone\u2019s shared playlist link'],
    'share-paste': ['Share', 'Pasted a share link', 'Pasted a share link into Studio'],
    'link-load': ['Share', 'Loaded a playlist link', 'Loaded a playlist from a link'],
    'link-load-failed': ['Problems', 'Playlist link failed', 'A playlist link couldn\u2019t be loaded'],
    'pub-delete': ['Share', 'Deleted a hosted link', 'Removed a hosted sync link'],
    'gallery-open': ['Starters', 'Opened the gallery', 'Opened the ready-made playlist gallery'],
    'empty-gallery': ['Starters', 'Gallery from empty results', 'Opened the gallery from "No results yet"'],
    'gallery-load': ['Starters', 'Loaded a starter playlist', 'Loaded a ready-made playlist'],
    'gallery-*': ['Starters', 'Starter playlist', 'Picked a ready-made playlist'],
    'connect-profile': ['Profile', 'Connected a profile', 'Connected their BeatLeader profile'],
    'profile-switch': ['Profile', 'Switched player', 'Used Switch player in the account menu'],
    'profile-disconnect': ['Profile', 'Disconnected', 'Disconnected their profile'],
    'profile-clan-bl': ['Clans', 'BeatLeader clan chip', 'Opened their BeatLeader clan from the profile chip'],
    'profile-clan-as': ['Clans', 'AccSaber clan chip', 'Opened their AccSaber clan from the profile chip'],
    'profile-clan-war': ['Clans', 'Clan war banner', 'Pressed Fight on the clan war banner'],
    'ss-sync': ['Profile', 'ScoreSaber pull', 'Pulled their ScoreSaber plays'],
    'ss-sync-auto': ['Profile', 'ScoreSaber refresh', 'Sync scores also refreshed ScoreSaber'],
    'stats-open': ['Stats', 'Opened Stats', 'Opened the Stats card'],
    'stats-add': ['Stats', 'Added from Stats', 'Added a recent score\u2019s map from Stats'],
    'stats-top-plays': ['Stats', 'Top 50 from Stats', 'Built from top 50 plays inside Stats'],
    'stats-score-open': ['Stats', 'Opened a score', 'Expanded a recent score in Stats'],
    'stats-versus': ['Stats', 'Versus from Stats', 'Opened "Maps they beat you on"'],
    'versus-build': ['Stats', 'Versus list', 'Loaded the maps another player beats them on'],
    'full-stats-replay': ['Stats', 'Replay from Stats', 'Watched a replay from Stats'],
    'full-stats-share': ['Stats', 'Shared Stats', 'Shared a Stats card link'],
    'stats-clan': ['Clans', 'Clan maps (old button)', 'Opened clan maps from the old Stats button'],
    'stats-asclan': ['Clans', 'AccSaber clan (old button)', 'Opened the AccSaber clan from the old Stats button'],
    'clan-open': ['Clans', 'BeatLeader clan view', 'Opened the BeatLeader clan maps view'],
    'clan-scan': ['Clans', 'Clan maps scan', 'Loaded their clan\u2019s maps to defend or capture'],
    'clan-recheck': ['Clans', 'Clan re-check', 'Re-checked the clan maps'],
    'clan-switch': ['Clans', 'Switched clan', 'Picked another of their clans'],
    'clan-switch-bl': ['Clans', 'To BeatLeader clan', 'Switched from AccSaber to the BeatLeader clan view'],
    'clan-ss': ['Clans', 'Clan maps with SS', 'Looked at replay-without-SS chances'],
    'clan-fail': ['Problems', 'Clan maps failed', 'BeatLeader didn\u2019t answer the clan scan'],
    'asclan-open': ['Clans', 'AccSaber clan view', 'Opened the AccSaber clan view'],
    'asclan-scan': ['Clans', 'AccSaber clan load', 'Loaded AccSaber missions and standings'],
    'asclan-recheck': ['Clans', 'AccSaber re-check', 'Re-checked AccSaber'],
    'asclan-switch': ['Clans', 'To AccSaber clan', 'Switched to the AccSaber clan view'],
    'asclan-war': ['Clans', 'War maps', 'Opened the war maps card'],
    'asclan-pick-*': ['Clans', 'Mission picks', 'Opened the map picks for a clan mission'],
    'asclan-fail': ['Problems', 'AccSaber failed', 'AccSaber didn\u2019t answer the clan view'],
    'foryou-*': ['For You', 'For You', 'Used a For You button'],
    'foryou-connect': ['For You', 'Connect from For You', 'Connected from the For You card'],
    'rank-up-plan': ['For You', 'Rank-up plan', 'Ran the rank-up planner'],
    'tour-shown': ['First visit', 'Saw the welcome', 'Saw the welcome popup'],
    'clear-logo': ['Other', 'Logo triple tap', 'Cleared everything with the logo triple tap'],
    'egg-115': ['Other', 'Easter egg 115', 'Found the 115 easter egg'],
    'egg-bomb': ['Other', 'Easter egg bomb', 'Found the bomb easter egg'],
    'pwa-link': ['App', 'Link into the app', 'Opened a Studio link in the installed app'],
    'pwa-open-file': ['App', 'Opened a .bplist file', 'Double-clicked a .bplist into the installed app'],
    'onquest-open': ['Studio Sync', 'Opened a headset playlist', 'Opened a playlist that\u2019s on their Quest'],
    'lq-link': ['Studio Sync', 'Linked a headset', 'Linked a Quest to Studio'],
    'lq-unlink': ['Studio Sync', 'Unlinked a headset', 'Removed a linked Quest'],
    'lq-first-sync': ['Studio Sync', 'First sync', 'A newly linked headset synced for the first time'],
    'lq-first-ok': ['Studio Sync', 'First sync seen', 'Closed the "linked and synced" card'],
    'lq-add': ['Studio Sync', 'Sent to headset', 'Sent a playlist to a linked Quest'],
    'lq-add-to': ['Studio Sync', 'Added maps to a headset list', 'Added maps to a playlist on their Quest'],
    'lq-add-to-mine': ['Studio Sync', 'Added to their own list', 'Added maps to one of their headset playlists'],
    'lq-upload-*': ['Studio Sync', 'Upload to headset', 'Uploaded a playlist to the headset'],
    'lq-edit': ['Studio Sync', 'Edited a headset playlist', 'Opened a Quest playlist to edit'],
    'lq-done': ['Studio Sync', 'Done editing', 'Finished editing a headset playlist'],
    'lq-autosave': ['Studio Sync', 'Autosave', 'Changes to a headset playlist saved by themselves'],
    'lq-sendback': ['Studio Sync', 'Sent edits back', 'Sent edits back to the headset'],
    'lq-arrived': ['Studio Sync', 'Changes arrived', 'The headset picked up their changes'],
    'lq-order-sent': ['Studio Sync', 'New order sent', 'Reordered headset playlists'],
    'lq-order-arrived': ['Studio Sync', 'New order arrived', 'The headset picked up a new playlist order'],
    'lq-reorder': ['Studio Sync', 'Reordered', 'Dragged playlists into a new order'],
    'lq-sort-*': ['Studio Sync', 'Sorted headset list', 'Sorted the headset playlist list'],
    'lq-rename': ['Studio Sync', 'Renamed headset', 'Renamed a linked Quest'],
    'lq-rename-pl': ['Studio Sync', 'Renamed a playlist', 'Renamed a playlist on the headset'],
    'lq-restore': ['Studio Sync', 'Restored a playlist', 'Brought back a deleted or older playlist'],
    'lq-copy': ['Studio Sync', 'Copied to another headset', 'Copied a playlist to their other Quest'],
    'lq-download': ['Studio Sync', 'Downloaded from headset', 'Downloaded a headset playlist as a file'],
    'lq-select': ['Studio Sync', 'Select mode', 'Selected several headset playlists'],
    'lq-hide': ['Studio Sync', 'Hid the panel', 'Hid the Studio Sync panel'],
    'lq-peek': ['Studio Sync', 'Peeked at a playlist', 'Looked inside a headset playlist'],
    'lq-peek-remove': ['Studio Sync', 'Removed while peeking', 'Removed a map while peeking'],
    'lq-quick-add-*': ['Studio Sync', 'Quick add to headset', 'Quick-added maps to a headset playlist'],
    'lq-quick-remove': ['Studio Sync', 'Quick remove', 'Removed a map from a headset playlist'],
    'lq-clean': ['Studio Sync', 'Clean up songs', 'Started cleaning songs in no playlist'],
    'lq-clean-ask': ['Studio Sync', 'Clean up opened', 'Opened the clean up songs question'],
    'lq-clean-cancel': ['Studio Sync', 'Clean up cancelled', 'Backed out of cleaning up songs'],
    'lq-clean-done': ['Studio Sync', 'Clean up done', 'The headset deleted unused songs'],
    'lq-gm-done': ['Studio Sync', 'Got missing songs', 'Downloaded missing songs to the headset'],
    'lq-gm-cancel': ['Studio Sync', 'Missing songs cancelled', 'Cancelled getting missing songs'],
    'lq-conflict*': ['Studio Sync', 'Edit conflict', 'Picked a side when the Quest and Studio both changed a list'],
    'lq-open-*': ['Studio Sync', 'Opened Studio Sync', 'Opened the Studio Sync tab'],
    'lq-key-show': ['Studio Sync', 'Showed library key', 'Showed their library key'],
    'lq-key-link': ['Studio Sync', 'Second device link', 'Opened Studio Sync on another device with the key'],
    'lq-qr-show': ['Studio Sync', 'Showed QR code', 'Showed the QR code for another device'],
    'lq-rekey': ['Studio Sync', 'New library key', 'Made a new library key'],
    'lq-migrate': ['Studio Sync', 'Library moved', 'Moved an old library to the new format'],
    'lq-nudge-no': ['Studio Sync', 'Update nudge dismissed', 'Dismissed the "update Studio Sync" nudge'],
    'lq-cancel': ['Studio Sync', 'Cancelled', 'Cancelled a Studio Sync action'],
    'github-click': ['Links', 'GitHub link', 'Clicked through to the source on GitHub'],
    'kofi-click': ['Links', 'Support me link', 'Clicked the Support me (Ko-fi) button'],
    'mbf-link': ['Links', 'ModsBeforeFriday link', 'Clicked the ModsBeforeFriday link'],
    'studiosync-download': ['Links', 'Studio Sync download', 'Clicked to download the Studio Sync mod'],
    'studiosync-releases': ['Links', 'Studio Sync releases', 'Opened the Studio Sync releases page'],
    'studiosync-update': ['Links', 'Studio Sync update', 'Clicked to update Studio Sync'],
    'js-error': ['Problems', 'Page error', 'A script error on the page'],
    'js-error-promise': ['Problems', 'Page error (async)', 'A script error from a background task'],
  };
  function featInfo(name) {
    var x = FEAT[name], rest = '';
    if (!x) { var best = ''; Object.keys(FEAT).forEach(function (k) { if (k.slice(-1) === '*' && name.indexOf(k.slice(0, -1)) === 0 && k.length > best.length) best = k; }); if (best) { x = FEAT[best]; rest = name.slice(best.length - 1).replace(/^-/, ''); } }
    if (!x) return { area: PROB.test(name) ? 'Problems' : 'Other', label: name.replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }), desc: '', name: name };
    return { area: x[0], label: x[1] + (rest ? ': ' + rest.replace(/-/g, ' ') : ''), desc: x[2], name: name };
  }
  function featRow(e, cls) {
    var f = featInfo(e.name);
    return ['<span class="fl"><b>' + esc(f.label) + '</b><span class="fd">' + esc(f.desc ? f.desc : f.area) + ' · <code>' + esc(e.name) + '</code></span></span>', e.count, cls || ''];
  }
  function chart(d, built, ids) {
    ids = ids || { svg: 'v-chart', head: 'v-charth', leg: 'v-pushleg', what: 'Visitors', dots: true };
    var svg = $(ids.svg), days = d.days, W = Math.max(280, Math.round(svg.clientWidth || 700)), H = 200;
    svg.setAttribute('viewBox', '0 0 ' + W + ' 220');
    if (!days.length) { svg.innerHTML = ''; return; }
    if (d.range === 'today') {
      var hr = (days[days.length - 1].hourly || []).slice(0, 24); days = hr.map(function (n, i) { return { day: '', n: n, h: i }; });
      $(ids.head).innerHTML = ids.what + ' per hour <small>UTC</small>';
    } else $(ids.head).innerHTML = ids.what + ' per day' + (ids.dots ? ' <small>dots are days you pushed changes</small>' : '');
    var max = 4; days.forEach(function (x) { if (x.n > max) max = x.n; });
    max = Math.ceil(max / 4) * 4;
    var n = days.length, X = function (i) { return n === 1 ? W / 2 : 30 + i * (W - 50) / (n - 1); }, Y = function (v) { return H - 12 - v / max * (H - 30); };
    var g = '';
    for (var k = 0; k <= 4; k++) { var yy = Y(max * k / 4); g += '<line x1="30" x2="' + (W - 20) + '" y1="' + yy + '" y2="' + yy + '" stroke="#1f2a3d"/><text x="0" y="' + (yy + 4) + '" fill="#6b7890" font-size="11">' + Math.round(max * k / 4) + '</text>'; }
    var pushes = d.range === 'today' || !ids.dots ? [] : (d.pushes || []);
    days.forEach(function (x, i) { if (pushes.indexOf(x.day) >= 0) g += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="12" y2="' + (H - 12) + '" stroke="#ffc23d" stroke-dasharray="3 4" opacity=".6"/><circle cx="' + X(i) + '" cy="14" r="5" fill="#ffc23d"><title>Pushed ' + dshort(x.day) + '</title></circle>'; });
    function path(vals) { return vals.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' '); }
    g += '<path d="' + path(days.map(function (x) { return x.n; })) + '" fill="none" stroke="#2f7bff" stroke-width="3" vector-effect="non-scaling-stroke"/>';
    if (d.range !== 'today' && built) g += '<path d="' + path(days.map(function (x) { return Math.min(x.n, built[x.day] || 0); })) + '" fill="none" stroke="#3ddc84" stroke-width="3" vector-effect="non-scaling-stroke"/>';
    var labs = d.range === 'today' ? [[0, '12 AM'], [12, '12 PM'], [n - 1, (n - 1) + ':00']] : [[0, dshort(days[0].day)], [Math.floor((n - 1) / 2), dshort(days[Math.floor((n - 1) / 2)].day)], [n - 1, dshort(days[n - 1].day)]];
    labs.forEach(function (l, j) { g += '<text x="' + X(l[0]) + '" y="' + (H + 16) + '" fill="#9aa6b8" font-size="12" text-anchor="' + (j === 0 ? 'start' : j === 2 ? 'end' : 'middle') + '">' + esc(l[1]) + '</text>'; });
    svg.innerHTML = g;
    if (ids.leg) $(ids.leg).classList.toggle('hidden', !pushes.length);
  }
  // ---- BeatLeader profile (second GoatCounter site) ----
  var bl = null, blBusy = false, BLIDS = { svg: 'b-chart', head: 'b-charth', what: 'Views', dots: false };
  function devSplit(sizes) { var dev = { Phone: 0, Tablet: 0, Computer: 0, Unknown: 0 }; (sizes || []).forEach(function (s) { var n = s.name.toLowerCase(); dev[/phone/.test(n) && !/tablet/.test(n) ? 'Phone' : /phone|tablet/.test(n) ? 'Tablet' : /monitor|computer|laptop|desktop/.test(n) ? 'Computer' : 'Unknown'] += s.count; }); return dev; }
  function bMsg(t) { var el = $('b-msg'); el.innerHTML = t; el.classList.toggle('hidden', !t); }
  function loadBl(fresh) {
    var key = getKey(); if (!key || blBusy) return;
    blBusy = true; if (!bl) bMsg('Loading your BeatLeader profile views...');
    fetch('/admin/gc?site=bl&range=' + encodeURIComponent(range) + (fresh ? '&fresh=1' : ''), { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      blBusy = false;
      if (!res.ok) {
        if (res.status === 401) { setKey(''); signedIn(false); say(res.j.error || 'Wrong key', true); return; }
        bMsg(res.j.setup ? '<b>GoatCounter isn\u2019t connected yet.</b> Add GC_TOKEN to the Worker first (see the Visitors tab).' : esc(res.j.error || 'Couldn\u2019t load the BeatLeader profile site.'));
        return;
      }
      bl = res.j; bMsg(''); renderBl();
    }).catch(function () { blBusy = false; bMsg('Couldn\u2019t reach the Worker.'); });
  }
  function renderBl() {
    var d = bl;
    txt('b-vis', fmt(d.visitors));
    if (d.prevVisitors != null && d.prevVisitors > 0) { var ch = Math.round((d.visitors - d.prevVisitors) / d.prevVisitors * 100); $('b-visn').innerHTML = '<span class="' + (ch >= 0 ? 'up' : 'down') + '">' + (ch >= 0 ? '\u25B2 ' : '\u25BC ') + Math.abs(ch) + '%</span> vs the ' + ({ today: 'day', '7d': '7 days', '30d': '30 days', '90d': '90 days' }[d.range] || 'period') + ' before'; }
    else txt('b-visn', d.range === 'all' ? 'since ' + dshort(d.start) : d.range === 'today' ? 'so far today' : dshort(d.start) + ' to ' + dshort(d.end));
    var last = d.days.length ? d.days[d.days.length - 1] : null, best = null;
    d.days.forEach(function (x) { if (!best || x.n > best.n) best = x; });
    txt('b-tod', fmt(last ? last.n : 0)); txt('b-todn', 'views so far, UTC day');
    txt('b-best', best && best.n ? fmt(best.n) : '-'); txt('b-bestn', best && best.n ? dshort(best.day) : 'no views yet');
    var dev = devSplit(d.sizes), known = dev.Phone + dev.Tablet + dev.Computer;
    txt('b-phone', known ? Math.round(dev.Phone / known * 100) + '%' : '-');
    chart(d, null, BLIDS);
    var PAGES = { '/msploit-profile': 'Your BeatLeader profile (all themes)' };
    bars('b-pages', (d.pages || []).map(function (p) { var nm = PAGES[p.path] || p.title || p.path; return ['<span class="fl"><b>' + esc(nm) + '</b><span class="fd"><code>' + esc(p.path) + '</code></span></span>', p.count]; }), '', 'No profile views in this range.');
    bars('b-refs', (d.refs || []).filter(function (r) { return r.name; }).map(function (r) { return [esc(r.name), r.count]; }), '', 'No referrers in this range.');
    bars('b-geo', (d.locations || []).slice(0, 8).map(function (s2) { return [esc(s2.name || 'Unknown'), s2.count]; }));
    bars('b-dev', [['Phone', dev.Phone, 'a'], ['Computer', dev.Computer], ['Tablet or small laptop', dev.Tablet, 'g'], ['Unknown', dev.Unknown, '']].filter(function (r) { return r[1] > 0; }));
    txt('b-when', 'GoatCounter (blprofile) ' + dshort(d.start) + (d.start !== d.end ? ' to ' + dshort(d.end) : '') + '. Updated ' + new Date(d.generated * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ', kept for 5 minutes.');
  }
  // ---- players ----
  var pf = { find: '', fnew: false, fclan: false, fme: ls('studioStatsHideMe') !== '0' }, pShown = 40;
  $('p-fme').setAttribute('aria-pressed', pf.fme ? 'true' : 'false');
  function mine(p) { return (p.clans || []).some(function (t) { return (gc.myClans || []).indexOf(t) >= 0; }); }
  function renderPlayers() {
    if (!gc) return;
    var all = gc.players.filter(function (p) { return !(pf.fme && p.me); }), start = gc.start;
    var allTime = gc.range === 'all', cut = allTime ? new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10) : start;
    var isNew = function (p) { return p.first && p.first >= cut; };
    txt('p-newn', allTime ? 'first connected in the last 7 days' : 'first time ever connecting'); txt('p-backn', allTime ? 'first connected before that' : 'connected before this range too');
    txt('p-all', fmt(all.length)); txt('p-new', fmt(all.filter(isNew).length)); txt('p-back', fmt(all.filter(function (p) { return !isNew(p); }).length));
    txt('p-clan', fmt(all.filter(mine).length)); txt('p-clann', 'players in ' + ((gc.myClans || []).join(' or ') || 'your clans'));
    var q = pf.find.toLowerCase(), list = all.filter(function (p) { return (!q || p.name.toLowerCase().indexOf(q) >= 0) && (!pf.fnew || isNew(p)) && (!pf.fclan || mine(p)); });
    var h = '<div class="prow head"><span>Player</span><span class="c-first">First seen</span><span class="c-last">Last seen</span><span class="n">Connects</span></div>';
    if (!list.length) h += '<div class="prow"><span class="empty">No players match.</span></div>';
    list.slice(0, pShown).forEach(function (p) {
      var url = p.id ? 'https://beatleader.com/u/' + encodeURIComponent(p.id) : 'https://beatleader.com/ranking/1?search=' + encodeURIComponent(p.name);
      var b = (p.me ? '<span class="pb me">YOU</span>' : isNew(p) ? '<span class="pb new">NEW</span>' : '<span class="pb back">BACK</span>') +
        (p.clans || []).map(function (t) { return '<span class="pb ' + ((gc.myClans || []).indexOf(t) >= 0 ? 'mine' : 'clan') + '">' + esc(t) + '</span>'; }).join('');
      var av = '<span class="pav" aria-hidden="true">' + esc((p.name || '?').charAt(0).toUpperCase()) + (p.avatar && p.avatar.indexOf('https://') === 0 ? '<img src="' + esc(p.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</span>';
      h += '<div class="prow"><span class="pwho"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' + av + '</a><span class="pname"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + esc(p.name) + ' on BeatLeader">' + esc(p.name) + '</a>' + b + '</span></span><span class="c-first">' + dshort(p.first) + '</span><span class="c-last">' + dago(p.last) + '</span><span class="n">' + fmt(p.count) + '</span></div>';
    });
    $('p-list').innerHTML = h;
    $('p-more').classList.toggle('hidden', list.length <= pShown); $('p-more').textContent = 'Show ' + Math.min(40, list.length - pShown) + ' more';
  }
  $('p-find').addEventListener('input', function () { pf.find = this.value.trim(); pShown = 40; renderPlayers(); });
  [['p-fnew', 'fnew'], ['p-fclan', 'fclan'], ['p-fme', 'fme']].forEach(function (x) {
    $(x[0]).addEventListener('click', function () { pf[x[1]] = !pf[x[1]]; this.setAttribute('aria-pressed', pf[x[1]] ? 'true' : 'false'); if (x[1] === 'fme') ls('studioStatsHideMe', pf.fme ? '1' : '0'); pShown = 40; renderPlayers(); });
  });
  $('p-more').addEventListener('click', function () { pShown += 40; renderPlayers(); });
  $('f-more').addEventListener('click', function () { this.setAttribute('data-all', this.getAttribute('data-all') === '1' ? '0' : '1'); renderGc(); });
  // ---- Studio Sync ----
  function sago(sec) { if (!sec) return 'never synced'; var d = Math.floor((Date.now() / 1000 - sec) / 86400); return d <= 0 ? 'synced today' : d === 1 ? 'synced yesterday' : 'synced ' + d + ' days ago'; }
  function renderUsers(s) {
    var us = s.users || [], h = '<div class="prow head"><span>Player</span><span class="c-first">Linked</span><span class="c-last">Last sync</span><span class="n">Headsets</span></div>';
    if (!us.length) h += '<div class="prow"><span class="empty">No Studio Sync users with a connected profile yet.</span></div>';
    us.forEach(function (u) {
      var url = u.id ? 'https://beatleader.com/u/' + encodeURIComponent(u.id) : '#';
      var av = '<span class="pav" aria-hidden="true">' + esc((u.name || '?').charAt(0).toUpperCase()) + (u.avatar && u.avatar.indexOf('https://') === 0 ? '<img src="' + esc(u.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</span>';
      var linked = u.linked ? new Date(u.linked * 1000).toISOString().slice(0, 10) : '';
      h += '<div class="prow"><span class="pwho"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' + av + '</a><span class="pname"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + esc(u.name) + ' on BeatLeader">' + esc(u.name) + '</a>' +
        (u.mod ? '<span class="pb ' + (u.mod === '0.9' ? 'new' : 'clan') + '">' + (u.mod === 'older' ? 'old mod' : esc(u.mod)) + '</span>' : '') + '</span></span><span class="c-first">' + (linked ? dshort(linked) : '-') + '</span><span class="c-last">' + sago(u.last) + '</span><span class="n">' + fmt(u.headsets) + '</span></div>';
    });
    $('u-list').innerHTML = h;
    txt('u-note', (s.usersUnknown ? s.usersUnknown + (s.usersUnknown === 1 ? ' more player hasn\u2019t' : ' more players haven\u2019t') + ' opened Studio with a connected profile since this list started, so their name isn\u2019t known yet. ' : '') + 'Names come from the BeatLeader profile connected in Studio when it checks the headset list.');
  }
  function renderReleases() {
    var rel = gc && gc.releases || [];
    $('dlCard').classList.toggle('hidden', !rel.length); $('relWrap').classList.toggle('hidden', !rel.length);
    if (!rel.length) return;
    txt('dlTotal', fmt(rel.reduce(function (a, r) { return a + r.downloads; }, 0)));
    var rows = rel.slice(0, 6).map(function (r) { return [esc(r.tag) + (r.at ? ' <span class="note">' + dshort(r.at) + '</span>' : ''), r.downloads]; });
    if (sync) rows.push(['Headsets linked', sync.headsets, 'g']);
    bars('relBars', rows);
  }
  function loadSync() {
    var key = keyIn.value.trim() || getKey();
    if (!key) { say('Enter your admin key.', true); return; }
    say('Loading...');
    fetch('/admin/stats', { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      if (!res.ok) { if (res.status === 401) { setKey(''); signedIn(false); } say(res.j.error || 'Couldn’t load stats.', true); return; }
      var first = !getKey() || !sync;
      setKey(key); keyIn.value = ''; signedIn(true);
      var s = sync = res.j, players = s.libraries - s.librariesNoHeadset;
      txt('activeDay', s.activeDay); txt('activeWeek', s.activeWeek); txt('activeMonth', s.activeMonth);
      txt('headsets', s.headsets); txt('neverNote', s.neverSynced ? s.neverSynced + ' never synced' : 'all have synced at least once');
      txt('newWeek', s.newWeek); txt('newMonthNote', s.newMonth + ' in the last 30 days');
      txt('players', players); txt('multiNote', s.librariesMulti ? s.librariesMulti + ' with more than one headset' : 'one headset each');
      txt('sharedPlaylists', s.sharedPlaylists); txt('librariesNoHeadset', s.librariesNoHeadset);
      weekBars('linksBars', s.linksByWeek); weekBars('activeBars', s.activeByWeek, true);
      txt('retention', s.retentionBase ? Math.round(s.retained / s.retentionBase * 100) + '%' : '-');
      txt('retentionNote', s.retentionBase ? s.retained + ' of ' + s.retentionBase + ' headsets linked 2+ weeks ago synced this week' : 'no headsets linked 2+ weeks ago yet');
      txt('goneQuiet', s.goneQuiet);
      txt('pendingChanges', s.pendingChanges);
      txt('pendingNote', s.pendingChanges ? 'on ' + s.pendingHeadsets + ' headset' + (s.pendingHeadsets === 1 ? '' : 's') + ', oldest ' + ago(s.pendingOldest) : 'nothing queued');
      renderUsers(s);
      bars('modBars', [['0.8 or newer', s.mod08 || 0], ['0.7', s.mod07], ['0.5 to 0.6', s.mod05], ['Older than 0.5', s.modOld], ['Not shared yet', s.modUnknown]]);
      txt('when', 'Updated ' + new Date(s.generated * 1000).toLocaleString() + '. Last sync times are at most 10 minutes old.' + (s.excluded ? ' Your own library is left out.' : ' Your own headsets are counted (ADMIN_EXCLUDE isn’t set).'));
      $('out').classList.remove('hidden'); say('');
      renderReleases();
      if (first || !gc) loadGc(false);
      if (tab === 'bl' && !bl) loadBl(false);
    }).catch(function () { say('Couldn’t reach the Worker.', true); });
  }
  $('go').addEventListener('click', loadSync);
  keyIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadSync(); });
  $('refresh').addEventListener('click', function () { loadSync(); if (tab === 'bl') loadBl(true); else loadGc(true); });
  $('forget').addEventListener('click', function () { setKey(''); gc = null; sync = null; signedIn(false); say('Key forgotten on this device.'); keyIn.focus(); });
  var rz = null; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (gc && tab === 'vis') chart(gc, dailyWhere(BUILD)); if (bl && tab === 'bl') chart(bl, null, BLIDS); }, 150); });
  showRange(); showTab(tab);
  if (getKey()) { $('keyrow').classList.add('hidden'); loadSync(); }
})();
</script></body></html>`;
