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
      if (e && e.message === "gc-auth") return json({ error: "GoatCounter refused the API key (" + e.gc + "). " + ({ bl: "For the BeatLeader profile site, check that the key can read blprofile, or set GC_TOKEN_BL.", hsv: "For HSV Config Generator, check that the key can read hsv-generator, or set GC_TOKEN_HSV.", rs: "For ReeSaber Studio, check that the key can read reesaberstudio, or set GC_TOKEN_RS." }[url.searchParams.get("site")] || "Check that GC_TOKEN has the Read statistics permission.") }, 502, nocache);
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
// or GC_TOKEN when both sites are under the same GoatCounter account. The HSV Config Generator and ReeSaber Studio
// tabs work the same way: GC_SITE_HSV (hsv-generator) and GC_SITE_RS (reesaberstudio), with GC_TOKEN_HSV / GC_TOKEN_RS
// only if those sites sit under a different account.
const GC_OTHER = {
  bl: (env) => ({ code: env.GC_SITE_BL || "blprofile", token: env.GC_TOKEN_BL, tool: false }),
  hsv: (env) => ({ code: env.GC_SITE_HSV || "hsv-generator", token: env.GC_TOKEN_HSV, tool: true }),
  rs: (env) => ({ code: env.GC_SITE_RS || "reesaberstudio", token: env.GC_TOKEN_RS, tool: true })
};
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
// One entry broken down further, like a country into its states and regions.
async function gcDetail(env, page, id, start, end, limit) {
  try { const j = await gcGet(env, "/stats/" + page + "/" + encodeURIComponent(id), { start: gcIso(start), end: gcIso(end), limit: limit || 20 }); return ((j && j.stats) || []).map((s) => ({ name: s.name || "", count: s.count || 0 })); }
  catch (e) { if (e.message === "gc-auth") throw e; return null; }
}
async function gcList(env, page, start, end, limit) {
  try { const j = await gcGet(env, "/stats/" + page, { start: gcIso(start), end: gcIso(end), limit: limit || 20 }); return ((j && j.stats) || []).map((s) => ({ id: s.id != null ? String(s.id) : "", name: s.name || "", count: s.count || 0, scheme: s.ref_scheme || "" })); }
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
// The tool sites also send feature events and utm campaigns, so their tabs get those too (no region lookups,
// to keep each load to a handful of API calls).
async function gcSiteStats(env, key, range, fresh) {
  const cfg = GC_OTHER[key](env), tool = cfg.tool;
  const e = Object.assign({}, env, { GC_SITE: cfg.code, GC_TOKEN: cfg.token || env.GC_TOKEN });
  const ck = "gc:cache:" + key + ":" + range, cached = await env.PLAYLISTS.get(ck, "json");
  if (cached && nowSec() - cached.generated < (fresh ? 60 : GC_CACHE_SEC)) return cached;
  const now = nowSec(), DAY = 86400, n = GC_RANGES[range], today0 = Math.floor(now / DAY) * DAY;
  const start = range === "today" ? today0 : today0 - (n - 1) * DAY, end = now;
  const total = await gcGet(e, "/stats/total", { start: gcIso(start), end: gcIso(end) });
  let prev = null; if (range !== "all") try { prev = await gcGet(e, "/stats/total", { start: gcIso(start - n * DAY), end: gcIso(start) }); } catch (x) {}
  const hits = await gcHits(e, start, end);
  const [refs, sizes, locations, browsers] = [await gcList(e, "toprefs", start, end, tool ? 20 : 15), await gcList(e, "sizes", start, end, 10), await gcList(e, "locations", start, end, 25), await gcList(e, "browsers", start, end, 10)];
  const campaigns = tool ? await gcList(e, "campaigns", start, end, 15) : undefined;
  // States and regions for the busiest countries (GoatCounter has no city level).
  if (!tool) for (const c of (locations || []).filter((x) => x.id && x.count > 0).slice(0, 10)) c.regions = await gcDetail(e, "locations", c.id, start, end, 20);
  let dayList = ((total && total.stats) || []).map((s) => ({ day: s.day, n: s.daily || 0, hourly: range === "today" ? s.hourly || [] : undefined }));
  if (range === "all") { const f = dayList.findIndex((x) => x.n > 0); dayList = f > 0 ? dayList.slice(f) : dayList; }
  const out = { site: key, code: cfg.code, generated: now, range, start: range === "all" && dayList.length ? dayList[0].day : gcDay(start), end: gcDay(end),
    visitors: (total && total.total) || 0, prevVisitors: prev ? prev.total || 0 : null, days: dayList,
    pages: hits.filter((h) => !h.event).map((h) => ({ path: h.path, title: h.title, count: h.count })), refs, sizes, locations, browsers };
  if (tool) {
    out.eventVisitors = (total && total.total_events) || 0;
    out.campaigns = campaigns;
    out.events = hits.filter((h) => h.event).map((h) => ({ name: h.path.replace(/^app\//, ""), count: h.count }));
  }
  await env.PLAYLISTS.put(ck, JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}
async function gcStats(env, range, fresh, site) {
  if (!GC_RANGES[range]) range = "7d";
  if (GC_OTHER[site]) return gcSiteStats(env, site, range, fresh);
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
:root{--bg:#000;--card:#0a0e16;--card2:#0d1320;--line:#1c2638;--text:#f2f5fa;--muted:#9aa6b8;--blue:#2f7bff;--cyan:#38bdf8;--red:#ff2740;--green:#3ddc84;--amber:#ffc23d;}
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
.card{position:relative;background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:16px;padding:16px 18px;min-width:0;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent,#26324a),transparent 70%)}
.card.hero{--accent:var(--green)}
.spark{width:100%;height:30px;margin-top:10px;opacity:.95}
.spark svg{width:100%;height:100%;display:block}
.spark:empty{display:none}
.label{font-size:13px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.value{font-size:34px;font-weight:800;margin-top:2px;overflow-wrap:anywhere}
.note{font-size:14px;color:var(--muted)}
.up{color:var(--green);font-weight:700}.down{color:#ff8a98;font-weight:700}
.hero .value{color:var(--green)}
.value.bad{color:#ff8a98}
h2{font-size:18px;margin:28px 0 10px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;letter-spacing:.2px}
h2 small{font-size:14px;color:var(--muted);font-weight:500}
.bars{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.bar{display:grid;grid-template-columns:minmax(110px,200px) 1fr 56px;align-items:center;gap:10px;margin:6px 0;font-size:15px}
.bar .lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar code,.mono{font:13.5px ui-monospace,Consolas,monospace;color:#cfe0ff}
.track{height:14px;background:#111827;border-radius:7px;overflow:hidden}
.fill{height:100%;border-radius:7px;background:linear-gradient(90deg,#1f5fe0,var(--blue) 60%,#5aa0ff);display:block}
.fill.alt{background:linear-gradient(90deg,#c41e33,var(--red))}.fill.g{background:linear-gradient(90deg,#1fae66,var(--green))}.fill.a{background:linear-gradient(90deg,#d99a1c,var(--amber))}
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
.tabs button[aria-selected="true"]{color:var(--text);border-bottom-color:var(--blue);text-shadow:0 0 18px rgba(47,123,255,.45)}
.range{display:flex;gap:6px;margin:0 0 16px;flex-wrap:wrap;align-items:center}
.range span{color:var(--muted);font-size:14px;margin-right:4px}
.range button,.chip{background:var(--card);border:1px solid var(--line);color:var(--muted);padding:7px 13px;font-size:14px;font-weight:600;border-radius:20px}
.range button[aria-pressed="true"],.chip[aria-pressed="true"]{border-color:var(--blue);color:#fff;background:rgba(47,123,255,.16)}
.chart{position:relative;background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:16px;padding:14px 16px}
.chart svg{touch-action:pan-y}
.ctip{position:absolute;top:10px;z-index:2;background:#111a2b;border:1px solid #2a3a58;border-radius:10px;padding:6px 10px;font-size:13.5px;color:var(--muted);pointer-events:none;white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,.5)}
.ctip b{color:#fff;font-size:16px;margin-right:4px}.ctip span{display:block;font-size:12.5px}
.map{position:relative;background:radial-gradient(ellipse at 50% 40%,#0c1626,#070a12 75%);border:1px solid var(--line);border-radius:16px;padding:12px}
.map svg{width:100%;height:auto;display:block}
.map path{stroke:#05070c;stroke-width:.5;transition:opacity .15s}
.map path.hot:hover{stroke:#fff;stroke-width:1}
.maptip{position:absolute;z-index:2;background:#111a2b;border:1px solid #2a3a58;border-radius:10px;padding:6px 10px;font-size:13px;color:var(--muted);pointer-events:none;white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,.5)}
.maptip b{display:block;color:#fff;font-size:14.5px}
.maplegend{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);margin:8px 4px 0}
.maplegend i{flex:0 1 180px;height:8px;border-radius:4px;background:linear-gradient(90deg,rgb(18,40,92),rgb(36,99,235),rgb(56,189,248),rgb(61,220,132))}
.blk.hidden{display:none !important}
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
.value.sm{font-size:22px;line-height:1.25;margin-top:6px}
.geo details{border-top:1px solid #141c2a}
.geo details:first-child{border-top:0}
.geo summary{list-style:none;cursor:pointer}
.geo summary::-webkit-details-marker{display:none}
.geo summary .lab::before{content:"▸";display:inline-block;width:16px;color:var(--muted);transition:transform .15s}
.geo details[open] summary .lab::before{transform:rotate(90deg)}
.geo summary.nokids .lab::before{content:"";}
.geo .sub{padding:0 0 8px 18px}
.geo .sub .bar{font-size:14px;margin:4px 0}
.geo .sub .fill{background:#5b8fe0}
section.loading{opacity:.45;pointer-events:none;transition:opacity .15s}
.range .rbusy{color:#8fbaff;font-size:14px;margin-left:6px;display:inline}
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
  .fdc{display:none}
  .ofv{display:none}
  .range > span:first-child{display:none}
  .range .rbusy{flex-basis:100%;margin:2px 0 0}
  .range button{padding:6px 11px;font-size:13.5px}
  .tab-long{display:none}
}
.tab-short{display:none}
@media(max-width:700px){.tab-short{display:inline}}
@media(max-width:380px){.grid{grid-template-columns:1fr}}
</style></head><body><main>
<div class="top"><div><div class="brand"><img src="${ADMIN_LOGO}" alt="" width="44" height="44"><h1>Studio stats</h1></div>
<p class="sub">Visitors, players and features from GoatCounter for Studio and your other tools, and headsets from Studio Sync.</p></div>
<div class="tools hidden" id="tools"><button id="refresh" class="ghost">Refresh</button><button id="forget" class="ghost">Forget key</button></div></div>
<div class="keyrow" id="keyrow"><input id="key" type="password" placeholder="Admin key" autocomplete="current-password">
<button id="go">Show stats</button></div>
<p class="msg" id="msg"></p>
<div id="out" class="hidden">
<div class="tabs" role="tablist" id="tabs">
<button role="tab" data-tab="vis" aria-selected="true">Visitors</button>
<button role="tab" data-tab="ply" aria-selected="false">Players</button>
<button role="tab" data-tab="feat" aria-selected="false">Features</button>
<button role="tab" data-tab="src" aria-selected="false">Sources</button>
<button role="tab" data-tab="sync" aria-selected="false">Studio Sync</button>
<button role="tab" data-tab="bl" aria-selected="false"><span class="tab-long">BeatLeader profile</span><span class="tab-short">BL profile</span></button>
<button role="tab" data-tab="hsv" aria-selected="false"><span class="tab-long">HSV Config</span><span class="tab-short">HSV</span></button>
<button role="tab" data-tab="rs" aria-selected="false">ReeSaber</button>
</div>
<div class="range" id="range"><span>Range</span><button data-r="today" aria-pressed="true">Today</button><button data-r="7d" aria-pressed="false">7 days</button><button data-r="30d" aria-pressed="false">30 days</button><button data-r="90d" aria-pressed="false">90 days</button><button data-r="all" aria-pressed="false">All time</button><span class="rbusy" id="rangeBusy" aria-live="polite"></span></div>
<div id="gcmsg" class="gcmsg hidden"></div>

<section data-sec="vis">
<div id="alert" class="alert hidden"></div>
<div class="grid">
<div class="card hero" data-keep><div class="label">Visitors</div><div class="value" id="v-vis">-</div><div class="note" id="v-visn"></div><div class="spark" id="v-spark"></div></div>
<div class="card"><div class="label" id="v-todl">Today</div><div class="value" id="v-tod">-</div><div class="note" id="v-todn"></div></div>
<div class="card" style="--accent:var(--cyan)"><div class="label">Built a playlist</div><div class="value" id="v-built">-</div><div class="note" id="v-builtn"></div></div>
<div class="card" style="--accent:var(--blue)"><div class="label">Connected a profile</div><div class="value" id="v-conn">-</div><div class="note" id="v-connn"></div></div>
</div>
<h2 id="v-charth">Visitors per day <small>dots are days you pushed changes</small></h2>
<div class="chart"><svg id="v-chart" viewBox="0 0 700 220" preserveAspectRatio="none" role="img" aria-label="Visitors per day"></svg>
<div class="legend"><span><i style="background:var(--blue)"></i>Visitors</span><span><i style="background:var(--green)"></i>Built a playlist</span><span id="v-pushleg"><i style="background:var(--amber);border-radius:50%"></i>Push to GitHub</span></div></div>
<div class="blk"><h2>Where visitors are <small>hover or tap a country</small></h2><div class="map" id="v-map"></div></div>
<div class="two" style="margin-top:4px">
<div class="blk"><h2>Phone or computer</h2><div class="bars" id="v-dev"></div></div>
<div class="blk"><h2>Top countries</h2><div class="bars" id="v-geo"></div></div>
</div>
<div class="blk"><h2>From visit to playlist <small>about, since each step counts people per event</small></h2>
<div class="bars funnel" id="v-fun"></div></div>
</section>

<section data-sec="ply" class="hidden">
<div class="grid">
<div class="card hero" data-keep><div class="label">Players</div><div class="value" id="p-all">-</div><div class="note">connected a BeatLeader profile</div></div>
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
<div class="blk"><h2>By area</h2><div class="bars" id="f-areas"></div></div>
<div class="blk"><h2>Most used</h2><div class="bars feat" id="f-top"></div><button class="ghost more hidden" id="f-more">Show all</button></div>
<div class="blk"><h2>New in the last 30 days <small>features first used recently</small></h2><div class="bars feat" id="f-fresh"></div></div>
<div class="blk"><h2>Problems</h2><div class="bars feat" id="f-probs"></div></div>
<div class="blk"><h2>Not used in this range <small>candidates to simplify or cut</small></h2><div class="bars" id="f-colds"></div></div>
</section>

<section data-sec="src" class="hidden">
<div class="grid">
<div class="card hero"><div class="label">From your links</div><div class="value" id="s-camp">-</div><div class="note">visits with a utm tag</div></div>
<div class="card"><div class="label">From search engines</div><div class="value" id="s-search">-</div><div class="note">Google, Bing, DuckDuckGo and others</div></div>
<div class="card" style="--accent:var(--cyan)"><div class="label">From AI assistants</div><div class="value" id="s-ai">-</div><div class="note">Gemini, ChatGPT, Claude and others</div></div>
<div class="card"><div class="label">From other sites</div><div class="value" id="s-sites">-</div><div class="note">Reddit, Discord, BeatLeader and others</div></div>
</div>
<div class="blk"><h2>Where your links were posted <small>utm_source</small></h2><div class="bars" id="s-links"></div></div>
<div class="blk"><h2>Your campaigns <small>utm_campaign</small></h2><div class="bars" id="s-camps"></div></div>
<div class="blk"><h2>Sites sending people</h2><div class="bars" id="s-refs"></div></div>
<div class="blk"><h2>Landing on</h2><div class="bars" id="s-pages"></div></div>
<div class="blk"><h2>Browsers</h2><div class="bars" id="s-br"></div></div>
</section>

<section data-sec="bl" class="hidden">
<div id="b-msg" class="gcmsg hidden"></div>
<div class="grid">
<div class="card hero" data-keep><div class="label">Profile views</div><div class="value" id="b-vis">-</div><div class="note" id="b-visn"></div><div class="spark" id="b-spark"></div></div>
<div class="card"><div class="label" id="b-todl">Today</div><div class="value" id="b-tod">-</div><div class="note" id="b-todn"></div></div>
<div class="card"><div class="label">Busiest day</div><div class="value" id="b-best">-</div><div class="note" id="b-bestn"></div></div>
<div class="card"><div class="label">On phones</div><div class="value" id="b-phone">-</div><div class="note">of views with a known screen size</div></div>
</div>
<h2 id="b-charth">Views per day</h2>
<div class="chart"><svg id="b-chart" viewBox="0 0 700 220" preserveAspectRatio="none" role="img" aria-label="Profile views per day"></svg></div>
<div class="blk"><h2>Pages counted</h2><div class="bars" id="b-pages"></div></div>
<h2 id="b-geoh">Where viewers are <small>country, then state or region</small></h2>
<div class="grid">
<div class="card"><div class="label">Countries</div><div class="value" id="b-ncty">-</div><div class="note">with at least one view</div></div>
<div class="card"><div class="label">Top country</div><div class="value sm" id="b-tcty">-</div><div class="note" id="b-tctyn"></div></div>
<div class="card"><div class="label">Top state or region</div><div class="value sm" id="b-treg">-</div><div class="note" id="b-tregn"></div></div>
</div>
<div class="blk"><div class="map" id="b-map" style="margin-bottom:12px"></div></div>
<div class="bars geo" id="b-geo"></div>
<div class="blk"><h2>States and regions <small>all countries together</small></h2><div class="bars" id="b-regs"></div></div>
<p class="when" id="b-geonote"></p>
<div class="blk"><h2>Where from</h2><div class="bars" id="b-refs"></div></div>
<div class="blk"><h2>Phone or computer</h2><div class="bars" id="b-dev"></div></div>
<p class="when" id="b-when"></p>
</section>

<section data-sec="hsv" class="hidden">
<div id="h-msg" class="gcmsg hidden"></div>
<div class="grid">
<div class="card hero" data-keep><div class="label">Visitors</div><div class="value" id="h-vis">-</div><div class="note" id="h-visn"></div><div class="spark" id="h-spark"></div></div>
<div class="card" style="--accent:var(--cyan)"><div class="label">Used a feature</div><div class="value" id="h-act">-</div><div class="note" id="h-actn"></div></div>
<div class="card"><div class="label">Busiest day</div><div class="value" id="h-best">-</div><div class="note" id="h-bestn"></div></div>
<div class="card"><div class="label">On phones</div><div class="value" id="h-phone">-</div><div class="note">of visits with a known screen size</div></div>
</div>
<h2 id="h-charth">Visitors per day</h2>
<div class="chart"><svg id="h-chart" viewBox="0 0 700 220" preserveAspectRatio="none" role="img" aria-label="Visitors per day"></svg></div>
<div class="blk"><h2>Most used <small>visitors per feature</small></h2><div class="bars feat" id="h-feat"></div><button class="ghost more hidden" id="h-more">Show all</button></div>
<div class="blk"><h2>Problems</h2><div class="bars feat" id="h-probs"></div></div>
<div class="blk"><h2>Where your links were posted <small>utm_source</small></h2><div class="bars" id="h-srcs"></div></div>
<div class="blk"><h2>Your campaigns <small>utm_campaign</small></h2><div class="bars" id="h-camps"></div></div>
<div class="blk"><h2>Sites sending people</h2><div class="bars" id="h-refs"></div></div>
<div class="blk"><h2>Landing on</h2><div class="bars" id="h-pages"></div></div>
<div class="blk"><h2>Where visitors are <small>hover or tap a country</small></h2><div class="map" id="h-map"></div></div>
<div class="two" style="margin-top:4px">
<div class="blk"><h2>Phone or computer</h2><div class="bars" id="h-dev"></div></div>
<div class="blk"><h2>Top countries</h2><div class="bars" id="h-geo"></div></div>
</div>
<p class="when" id="h-when"></p>
</section>

<section data-sec="rs" class="hidden">
<div id="r-msg" class="gcmsg hidden"></div>
<div class="grid">
<div class="card hero" data-keep><div class="label">Visitors</div><div class="value" id="r-vis">-</div><div class="note" id="r-visn"></div><div class="spark" id="r-spark"></div></div>
<div class="card" style="--accent:var(--cyan)"><div class="label">Used a feature</div><div class="value" id="r-act">-</div><div class="note" id="r-actn"></div></div>
<div class="card"><div class="label">Busiest day</div><div class="value" id="r-best">-</div><div class="note" id="r-bestn"></div></div>
<div class="card"><div class="label">On phones</div><div class="value" id="r-phone">-</div><div class="note">of visits with a known screen size</div></div>
</div>
<h2 id="r-charth">Visitors per day</h2>
<div class="chart"><svg id="r-chart" viewBox="0 0 700 220" preserveAspectRatio="none" role="img" aria-label="Visitors per day"></svg></div>
<div class="blk"><h2>Most used <small>visitors per feature</small></h2><div class="bars feat" id="r-feat"></div><button class="ghost more hidden" id="r-more">Show all</button></div>
<div class="blk"><h2>Problems</h2><div class="bars feat" id="r-probs"></div></div>
<div class="blk"><h2>Where your links were posted <small>utm_source</small></h2><div class="bars" id="r-srcs"></div></div>
<div class="blk"><h2>Your campaigns <small>utm_campaign</small></h2><div class="bars" id="r-camps"></div></div>
<div class="blk"><h2>Sites sending people</h2><div class="bars" id="r-refs"></div></div>
<div class="blk"><h2>Landing on</h2><div class="bars" id="r-pages"></div></div>
<div class="blk"><h2>Where visitors are <small>hover or tap a country</small></h2><div class="map" id="r-map"></div></div>
<div class="two" style="margin-top:4px">
<div class="blk"><h2>Phone or computer</h2><div class="bars" id="r-dev"></div></div>
<div class="blk"><h2>Top countries</h2><div class="bars" id="r-geo"></div></div>
</div>
<p class="when" id="r-when"></p>
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
    var blk = el.closest('.blk'); if (blk) blk.classList.toggle('hidden', !rows.length);
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
    $('gcmsg').classList.toggle('hidden', ownTab(t) || !$('gcmsg').textContent);
    $('gcwhen').classList.toggle('hidden', ownTab(t));
    if (t === 'vis' && gc) chart(gc, dailyWhere(BUILD));
    if (t === 'bl') { if (bl && bl.range === range) chart(bl, null, BLIDS); else if (getKey() && $('out') && !$('out').classList.contains('hidden')) loadBl(false); }
    if (isTool(t)) { if (toolData[t] && toolData[t].range === range) renderTool(t); else if (getKey() && $('out') && !$('out').classList.contains('hidden')) loadTool(t, false); }
    if (!ownTab(t) && gc && gc.range !== range) loadGc(false);
    busyUi();
  }
  function showRange() { Array.prototype.forEach.call(document.querySelectorAll('#range button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-r') === range ? 'true' : 'false'); }); }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-tab]'); if (b) showTab(b.getAttribute('data-tab')); });
  $('range').addEventListener('click', function (e) { var b = e.target.closest('button[data-r]'); if (!b || b.getAttribute('data-r') === range) return; range = b.getAttribute('data-r'); showRange(); if (tab === 'bl') loadBl(false); else if (isTool(tab)) loadTool(tab, false); else loadGc(false); });

  // ---- GoatCounter ----
  var BUILD = /^(export|quest-send|lq-add|lq-add-to|lq-add-to-mine|lq-upload-.*|share-create)$/;
  var SEARCH = /^(search-beatleader|search-beatsaver|search-recommend)$/;
  var ADD = /^(row-add|top-plays|build-from-plays|quick-add|gallery-load|stats-top-plays|versus-build)$/;
  var PROB = /(^js-error|fail)/;
  function ev(name) { var x = null; (gc.events || []).forEach(function (e) { if (e.name === name) x = e; }); return x; }
  function sumWhere(re) { var n = 0; gc.events.forEach(function (e) { if (re.test(e.name)) n += e.count; }); return n; }
  function maxWhere(re) { var n = 0; gc.events.forEach(function (e) { if (re.test(e.name) && e.count > n) n = e.count; }); return n; }
  function dailyWhere(re) { var m = {}; gc.events.forEach(function (e) { if (re.test(e.name)) (e.days || []).forEach(function (d) { m[d[0]] = (m[d[0]] || 0) + d[1]; }); }); return m; }
  function gcMsg(t) { var el = $('gcmsg'); el.innerHTML = t; el.classList.toggle('hidden', !t || ownTab(tab)); }
  // Every range change starts a new load; an answer for a range that's no longer picked is dropped,
  // so a slow load can't swallow the next click or paint old numbers over new ones.
  var gcTok = 0, blTok = 0;
  function rangeName(r) { return { today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'All time' }[r] || r; }
  function busyUi() {
    var on = (gcBusy && !ownTab(tab)) || (blBusy && tab === 'bl') || (isTool(tab) && !!toolBusy[tab]);
    Array.prototype.forEach.call(document.querySelectorAll('section[data-sec]'), function (sx) { sx.classList.toggle('loading', on && sx.getAttribute('data-sec') !== 'sync'); });
    $('rangeBusy').textContent = on ? 'Loading ' + rangeName(range) + '...' : '';
  }
  function loadGc(fresh) {
    var key = getKey(); if (!key) return;
    var tok = ++gcTok, want = range;
    gcBusy = true; gcMsg(gc ? '' : 'Loading GoatCounter...'); busyUi();
    fetch('/admin/gc?range=' + encodeURIComponent(want) + (fresh ? '&fresh=1' : ''), { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      if (tok !== gcTok) return;
      gcBusy = false; busyUi();
      if (!res.ok) {
        txt('gcwhen', '');
        if (res.status === 401) { setKey(''); signedIn(false); say(res.j.error || 'Wrong key', true); return; }
        if (res.j.setup) gcMsg('<b>GoatCounter isn’t connected yet.</b> Make an API key in GoatCounter (your name at the top, then API, with permission to read statistics), then in the Playlist-Studio <code>worker</code> folder run <code>npx wrangler secret put GC_TOKEN</code> and paste it.');
        else gcMsg(esc(res.j.error || 'Couldn’t load GoatCounter.'));
        return;
      }
      gc = res.j; gcMsg(''); renderGc();
    }).catch(function () { if (tok !== gcTok) return; gcBusy = false; busyUi(); txt('gcwhen', ''); gcMsg('Couldn’t reach the Worker.'); });
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
    var fv = $('v-fun').closest('.blk'); if (fv) fv.classList.toggle('hidden', !d.visitors);
    bars('v-geo', (d.locations || []).filter(function (s) { return s.count > 0; }).slice(0, 8).map(function (s) { return [esc(s.name && !/unknown/i.test(s.name) ? s.name : 'Unknown'), s.count]; }));
    worldMap('v-map', d.locations, 'visitors');
    spark('v-spark', d.range === 'today' ? ((d.days[d.days.length - 1] || {}).hourly || []) : d.days.map(function (x) { return x.n; }), '#3ddc84');
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
    var camps = (d.campaigns || []), links = (d.refs || []).filter(function (r) { return r.scheme === 'c' && r.name; }), refs = (d.refs || []).filter(function (r) { return r.scheme !== 'c' && r.name; });
    txt('s-camp', fmt(camps.reduce(function (a, c) { return a + c.count; }, 0)));
    txt('s-search', fmt(refSum(refs, function (k) { return k === 'search'; })));
    txt('s-ai', fmt(refSum(refs, function (k) { return k === 'ai'; })));
    txt('s-sites', fmt(refSum(refs, function (k) { return k !== 'search' && k !== 'ai'; })));
    bars('s-links', links.map(function (r) { return refRow(r, 'g'); }));
    bars('s-camps', camps.filter(function (c) { return c.count > 0; }).map(campRow), '', 'No tagged links used in this range.');
    bars('s-refs', refs.map(function (r) { return refRow(r); }));
    bars('s-pages', (d.pages || []).slice(0, 10).map(function (p) { return pageRow(p, 'Playlist Studio home'); }));
    bars('s-br', (d.browsers || []).slice(0, 8).map(function (b) { return [esc(b.name || 'Unknown'), b.count]; }));
    renderReleases();
    ['vis', 'feat', 'src'].forEach(hideEmptyCards);
    $('f-colds').closest('.blk').classList.toggle('hidden', !d.cold.length);
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
    'quest-no-answer': ['Problems', 'Quest USB no answer', 'The Quest didn\\u2019t answer over USB'],
    'quest-cancel': ['Save and send', 'Quest USB cancelled', 'Cancelled sending over USB'],
    'cable-pitch': ['Studio Sync', 'Saw the Studio Sync pitch', 'Saw the "skip the cable" Studio Sync card'],
    'cable-pitch-no': ['Studio Sync', 'Dismissed the pitch', 'Pressed Not now on the Studio Sync card'],
    'share-create': ['Share', 'Made a share link', 'Created a share link for a playlist'],
    'share-open': ['Share', 'Opened a share link', 'Opened someone\\u2019s shared playlist link'],
    'share-paste': ['Share', 'Pasted a share link', 'Pasted a share link into Studio'],
    'link-load': ['Share', 'Loaded a playlist link', 'Loaded a playlist from a link'],
    'link-load-failed': ['Problems', 'Playlist link failed', 'A playlist link couldn\\u2019t be loaded'],
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
    'stats-add': ['Stats', 'Added from Stats', 'Added a recent score\\u2019s map from Stats'],
    'stats-top-plays': ['Stats', 'Top 50 from Stats', 'Built from top 50 plays inside Stats'],
    'stats-score-open': ['Stats', 'Opened a score', 'Expanded a recent score in Stats'],
    'stats-versus': ['Stats', 'Versus from Stats', 'Opened "Maps they beat you on"'],
    'versus-build': ['Stats', 'Versus list', 'Loaded the maps another player beats them on'],
    'full-stats-replay': ['Stats', 'Replay from Stats', 'Watched a replay from Stats'],
    'full-stats-share': ['Stats', 'Shared Stats', 'Shared a Stats card link'],
    'stats-clan': ['Clans', 'Clan maps (old button)', 'Opened clan maps from the old Stats button'],
    'stats-asclan': ['Clans', 'AccSaber clan (old button)', 'Opened the AccSaber clan from the old Stats button'],
    'clan-open': ['Clans', 'BeatLeader clan view', 'Opened the BeatLeader clan maps view'],
    'clan-scan': ['Clans', 'Clan maps scan', 'Loaded their clan\\u2019s maps to defend or capture'],
    'clan-recheck': ['Clans', 'Clan re-check', 'Re-checked the clan maps'],
    'clan-switch': ['Clans', 'Switched clan', 'Picked another of their clans'],
    'clan-switch-bl': ['Clans', 'To BeatLeader clan', 'Switched from AccSaber to the BeatLeader clan view'],
    'clan-ss': ['Clans', 'Clan maps with SS', 'Looked at replay-without-SS chances'],
    'clan-fail': ['Problems', 'Clan maps failed', 'BeatLeader didn\\u2019t answer the clan scan'],
    'asclan-open': ['Clans', 'AccSaber clan view', 'Opened the AccSaber clan view'],
    'asclan-scan': ['Clans', 'AccSaber clan load', 'Loaded AccSaber missions and standings'],
    'asclan-recheck': ['Clans', 'AccSaber re-check', 'Re-checked AccSaber'],
    'asclan-switch': ['Clans', 'To AccSaber clan', 'Switched to the AccSaber clan view'],
    'asclan-war': ['Clans', 'War maps', 'Opened the war maps card'],
    'asclan-pick-*': ['Clans', 'Mission picks', 'Opened the map picks for a clan mission'],
    'asclan-fail': ['Problems', 'AccSaber failed', 'AccSaber didn\\u2019t answer the clan view'],
    'foryou-*': ['For You', 'For You', 'Used a For You button'],
    'foryou-connect': ['For You', 'Connect from For You', 'Connected from the For You card'],
    'rank-up-plan': ['For You', 'Rank-up plan', 'Ran the rank-up planner'],
    'tour-shown': ['First visit', 'Saw the welcome', 'Saw the welcome popup'],
    'clear-logo': ['Other', 'Logo triple tap', 'Cleared everything with the logo triple tap'],
    'egg-115': ['Other', 'Easter egg 115', 'Found the 115 easter egg'],
    'egg-bomb': ['Other', 'Easter egg bomb', 'Found the bomb easter egg'],
    'pwa-link': ['App', 'Link into the app', 'Opened a Studio link in the installed app'],
    'pwa-open-file': ['App', 'Opened a .bplist file', 'Double-clicked a .bplist into the installed app'],
    'onquest-open': ['Studio Sync', 'Opened a headset playlist', 'Opened a playlist that\\u2019s on their Quest'],
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
    return ['<span class="fl"><b>' + esc(f.label) + '</b><span class="fd">' + esc(f.desc ? f.desc : f.area) + '<span class="fdc"> · <code>' + esc(e.name) + '</code></span></span></span>', e.count, cls || ''];
  }
  // ---- world heatmap ----
  // Country shapes from Natural Earth (public domain, 1:110m), drawn once per map; colors follow views.
  var WORLD = {"w":960,"h":440,"p":{"FJ":"M950,310L950.7,309.5L951.4,310.4L950.6,312L948.8,312.4L947.5,312L947.6,310.7L948.9,309.6ZM955.6,307L953.8,307.8L951.9,308.5L951.9,307.3L953.3,306.7L954.2,306.5L956,305.5L956,305.5L955.6,307ZM4,305.5L4,305.5L4,305.5L4.5,305.4L4.5,306.9L4.4,307L4.4,307L4,305.5Z","TZ":"M570.7,258.7L571.2,259L580.9,265.3L581,267.1L584.8,270.2L583.5,274L583.6,275.8L585.3,276.9L585.4,277.7L584.6,279.6L584.8,280.5L584.5,282L585.4,283.9L586.4,287L587.4,287.7L585.2,289.5L582.3,290.7L580.7,290.6L579.7,291.6L577.8,291.6L577.1,292L573.9,291.2L571.9,291.4L571.3,287.2L570.4,285.7L569.9,284.9L567.3,284.3L565.9,283.4L564.2,282.9L563.1,282.3L562,281.6L560.6,277.6L559.1,275.9L558.6,274.1L558.9,272.5L558.5,269.7L559.6,269.5L560.5,268.4L561.6,266.8L562.3,266.1L562.3,265.1L561.7,264.4L561.5,263.2L562.3,262.8L562.5,261L561.4,259.2L562.4,258.9L565.3,258.9Z","EH":"M457.6,169.8L457.6,170L457.6,170.6L457.5,175.4L449,175.2L448.9,183.2L446.4,183.5L445.7,185.1L446.1,189.6L435.9,189.5L435.3,190.6L435.4,189.3L435.5,189.3L441.4,189L441.7,187.9L442.8,186.5L443.8,182.2L447.5,178.8L448.8,174.9L449.6,174.7L450.5,172.2L452.7,171.9L453.7,172.3L454.8,172.3L455.7,171.6L457.3,171.5L457.3,169.8Z","CA":"M190.2,103.9L189.9,103.9L187,100.9L186.1,99.7L182.6,98.4L182.9,95.8L184.4,94L182.3,92.7L183.4,90.3L182.1,88.2L183,86.7L185.3,85.3L186.5,83.4L183.9,81.6L184.1,78.3L184.2,76.3L183.2,75L182.6,73.8L182.6,72.3L179.6,73.3L176.2,74.8L175.8,73L175.2,71.7L173.8,71L171.7,70.9L185.6,55.2L195.1,45.3L198.3,45.9L200.3,47.2L202.1,47.4L205,46.3L208.2,45.5L210.9,45.8L215,44.7L218.9,44L219.3,45.1L221.4,44.5L223,43.3L224.1,43.6L225.4,45.9L229.6,44.1L228.2,46.1L231,45.7L232.5,44.9L234.8,45.1L236.9,46.2L240.9,47.1L243.3,47.6L245.4,47.4L247.1,48.8L243.2,50.1L246.5,50.6L252.3,50.3L254.3,49.9L255.3,51.5L258.6,50.1L257.3,49L259.3,48.1L261.9,48L263.7,47.7L264.9,48.3L265.9,49.8L268.4,49.6L271.2,50.7L274.6,50.3L277.6,50.4L278.5,48.7L280.6,48.3L283.2,49.2L281.5,51.7L284.2,49.6L285.8,49.6L288.5,47L287.4,45.4L285.8,44.3L287.9,41.5L291.6,39.6L293.9,40L295.2,41.1L295.9,44.1L293.3,45.3L296.7,45.9L295,48.6L299,46.5L300.4,48.2L298.6,50.1L299.5,51.9L302.8,50L305.6,47.7L307.5,44.9L310.2,45.1L313,45.4L315,46.7L314.3,48L312,49.5L312.7,50.9L311.7,52.2L306.6,54.1L303.4,54.5L301.8,53.7L300.4,55L297,57.3L295.7,58.5L292.3,60.3L289.1,60.5L286.8,61.7L285.6,63.5L282.9,63.8L279,66.1L274.9,69.2L272.8,71.4L270.8,74.7L273.8,75.2L273.4,77.9L273.3,80L276.7,79.5L280.3,80.7L282,81.8L283,83.2L285.4,84L287.2,85.2L290.9,85.4L293.3,85.7L291.8,88.2L291.3,91.2L291.6,94.5L293.9,97.3L296.1,96.3L298.5,93.3L299.2,88.6L298.2,87.1L302.4,85.7L305.8,83.7L307.9,81.6L308.6,79.7L308.1,77.3L306.3,75.1L310.3,72.2L310.5,69.6L311.9,65.2L313.7,64.6L317,65.4L319.1,65.6L321.2,64.9L322.8,65.8L324.7,67.5L324.9,68.5L328.7,68.8L327.7,71.1L326.9,74.7L328.8,75.1L329.7,76.8L333.5,75.2L336.8,72.1L338.8,70.8L339.6,73.3L341.1,76.9L342.4,80.4L340.9,82.2L343.3,83.8L344.8,85.5L348.2,86.3L349.4,87.2L349.6,89.7L351.3,90.1L351.9,91.2L351.1,94.5L349.1,95.6L347.2,96.7L343,97.7L339.4,100.2L335.3,100.7L330.5,100L327,100L324.5,100.2L321.9,102.4L318.4,103.7L313.8,107.7L310.2,110.5L312.4,110L317.4,106L323.1,103.5L326.7,103.2L328.4,104.7L325.6,106.7L325.4,110L325.6,112.3L328.3,113.8L332.4,113.3L335.6,109.9L335.2,112.1L336.5,113.2L333,115.2L327.2,117L324.5,118.3L321.2,120.5L319.5,120.3L320,117.7L324.9,115.1L321,115.2L318.2,115.6L317.1,113.9L318.3,109.7L317.5,108.9L315.8,109.4L315.2,108.6L312.7,110.9L311.3,113.2L310,114.6L308.9,115.1L308.1,115.3L307.6,116L303.2,116L299.5,116L298.2,116.6L295,118.8L294.6,119L293.5,120.2L291.3,120.2L288.9,120.2L287.6,120.7L287.8,121.3L287.8,122.3L287.6,122.6L284,124.1L281.3,124.6L278,126.2L277.4,126.2L276.7,125.8L276.5,125.3L276.7,125L277.6,123.9L279.3,122.2L280.5,120.4L280.9,117.7L281.3,115L279.3,113.5L279.8,113L279.6,112.6L278.9,112.6L278.6,112.1L278.7,111.4L278.2,111.7L277.5,111.7L277.8,111.3L277.3,111L277.4,110.3L275.9,109.3L274.4,108.3L272.5,107.1L270.7,106L268.2,106.9L267.4,106.9L264.8,106.1L262.8,106.5L260.8,105.6L258.6,105.1L257.1,104.9L256.5,104.4L256.8,102.7L256,102.7L255.5,103.9L250.6,103.9L242.6,103.9L234.5,103.9L227.5,103.9L220.4,103.9L213.4,103.9L206.2,103.9L203.9,103.9L196.9,103.9ZM299.4,64.9L301.6,63.6L304.6,63.6L304.2,64.2L301,65.7L299.5,65.6ZM323.5,37.4L322.2,36L322.8,35.1L323.9,35L328.2,35.2L330.7,36.6L330.5,37.3L328.4,37.2L326.3,37.2L324,37.5ZM306.8,65.9L308,65.1L308.9,65.1L309.1,65.7L307.6,67.1L306.7,66.9L306.6,66.1ZM300.4,31.9L298.6,32.9L296,32.7L294.1,32.1L296,31L299.3,30.3L300.3,31.2ZM304.9,25.8L304,25.9L300.6,25.8L300.7,25.1L304.4,25.1L305.4,25.6ZM302.1,23L303.6,23.8L302.3,24.6L299.1,25.1L298.1,24.5L298.1,23.7L298.9,22.7L301.2,22.8ZM309.8,33.4L306.9,33.1L302.4,32.3L302.8,30.9L303.5,29.7L302.4,28.7L298.8,28.4L297.2,27.7L298.7,26.7L302.5,26.8L303.9,27.6L307.6,27.6L308.6,28.4L307.5,29.3L309.2,29.8L310,30.4L312.5,30.5L315.1,30.7L318.6,30.2L322.6,30L325.5,30.1L327,31.1L326.7,32.1L325.1,32.7L321.9,33.3L319.6,33L313.8,33.3ZM273.9,24.4L276.2,24.7L274.8,25.4L270.7,26.1L268.7,25.3L271,24.6ZM276.1,22.9L278,23.3L275.2,23.8L272.2,23.8L272.6,23.5L275.2,22.8ZM350.6,97L348.9,98.8L346.7,101.5L348.4,100.5L349.9,101.1L348.8,102.1L350.6,103L351.9,102.2L354,103.2L352.8,105.4L354.5,104.8L354.5,106.4L354.8,108.3L353.2,111L352.1,111.1L350.6,110.5L351.7,108.1L351.1,107.7L347.8,110.3L346.4,110.2L348.4,108.8L346.3,108L343.7,108.2L339.1,108.1L338.9,107.2L340.7,106.2L339.9,105.3L342.4,103.5L346.1,98.7L348,97.1L350.3,96L351.3,96.2ZM303.5,57.6L305.3,58.5L307.3,59.4L306.8,60.7L308.5,60.4L309.5,61.4L307.2,62.2L304.2,61.6L303.7,60.3L300.8,61.8L297,63.2L297.1,61.6L294.1,61.9L296.7,60.5L298.1,58.4L300.3,55.9L301.6,56.1L301.4,57.3L302.7,56.9ZM324.8,38.5L327.3,37.5L330.9,38.8L332.9,40L332.5,41.1L336.5,40.5L337.8,42.2L342.1,43.2L343.3,44.2L344,46.7L339.7,47.9L343.7,49.6L346.7,50.2L348.6,52.7L351.8,52.8L350.4,54.7L345.4,57.9L343.3,56.7L341.1,54.1L338.3,54.5L337.3,56L338.8,57.6L341.2,58.8L341.7,59.6L342,62.3L340.4,64.3L338,63.5L333.6,61.3L335.6,63.7L337.2,65.3L337.1,66.3L331.7,65.2L327.8,63.6L325.8,62.3L326.9,61.5L324.4,60.1L322,58.7L321.6,59.5L315.3,60L314,59L316.4,57L320.4,57L324.8,56.6L324.6,55.7L326,54.3L330,51.7L330,50.5L329.7,49.6L327.2,48.3L323.5,47.4L325.2,46.8L323.9,45.2L322.2,45L321.1,44.1L319.6,44.9L315.8,45.2L308.8,44.6L305,43.9L302,43.5L300.9,42.6L303.8,41.4L300.9,41.4L302.1,38.8L305.1,36.5L307.8,35.5L313.3,34.8L310.8,36.5L311.3,38L314.4,36L320,35L321.8,37.6L320.4,39.2ZM297.1,34L301.1,34.1L304.3,34.7L299.8,36.9L297.1,37.4L293.7,39.3L291.5,39.2L291.9,37L292.8,35.8L294.6,34.7ZM247.1,29.2L252.2,27.4L257.7,25.9L260.6,25.9L263.5,25.5L261.3,27.4L259,28.2L257.1,28.3L252.6,29.3L249.2,29.7ZM176.5,88.9L178.9,88.7L176,92L176.4,94.4L175.5,94.4L175,93L175,91.7L174.5,90.8L175,89.5L175.7,88.5ZM287.3,21.8L290.6,22.1L294.7,22.9L295,24L294.9,24.9L292.1,24.7L289.8,23.9L285.7,23.9L288.2,23.2L286.5,22.6ZM187.8,105.4L186.4,105.8L183.3,104.4L183.2,103.4L181.7,102.3L181.8,101.5L179.7,100.9L179.7,99.3L180.4,98.6L182.4,99.2L183.6,99.7L185.6,100L185.8,101L186.1,102.5L187.8,103.7ZM245.5,33.2L247.8,33.8L252.6,33.9L253.8,34.6L254.9,35.7L251.9,36.3L245.5,38.1L241.4,39.9L240.4,41L234.1,42.2L234,41.1L230.7,39.7L232.6,38.7L235.7,36.8L239,35.2L238.6,33.6ZM275,29.8L277.1,29.4L279,29.5L278.3,30.7L276.1,31.9L269.2,32.3L263.4,33.3L260.4,33.4L260.9,32.6L265.9,31.5L257,31.8L254.7,31.3L259.7,29L262.1,28.3L266.6,29.1L268.7,30.5L271.8,30.7L271.3,28.4L273.8,27.6L275.5,27.8L275.1,29ZM271.6,36.7L273,37.7L272.2,40.2L271.5,42L273.8,43.3L276.6,44.5L275.5,45.6L272,45.8L272.6,46.9L271.2,47.8L267.8,47.4L264.9,46.7L262.4,46.9L257.9,47.7L252.4,48.1L248.6,48.4L248.5,47.1L246.3,46.4L244.2,46.7L243.5,44.7L245,44.4L248.5,43.9L251.3,44L254.2,43.6L250.9,43L246.4,43.2L243.6,43.1L243.4,42.2L248.9,41.2L245.8,41.2L242.9,40.5L246.3,38.6L248.6,37.6L255.2,36.1L256.7,36.6L254.7,37.7L259.8,37L261.4,38.2L264.7,37L265.8,37.8L265.4,40.3L267.2,39.2L268,36.6L270,36.3ZM282.8,37.6L281.9,36L285.2,34.7L287.1,35.3L290.8,35L290.7,35.7L288,36.9L290.2,38L288.1,40.3L284.2,41.3L282.4,41L281.8,40.1L278.3,38.1L279,37.3ZM272.5,35.4L275.2,35.3L276.3,35.8L273.2,37.5L271.6,35.7ZM294.5,27.7L295,28.8L294.1,30.1L291.7,31.9L288.3,32.1L286.6,31.7L287.8,30.3L284.5,30.5L286.1,28.6L288,28.7L291.6,27.9L294.1,28ZM307.6,18.9L309.5,18.3L311.5,18.1L311.3,17.7L315.5,17.5L316.6,18.7L319.2,19.1L321.7,19.5L321.8,21L323.3,21.7L320.2,22.4L315.4,24.1L311.9,24.2L308.4,23.9L307.2,23L308,22.2L310,21.6L306.7,21.6L305.4,20.9L305.3,19.9ZM318.5,16.2L321.6,15.9L323.7,15.8L327.5,15.5L330.9,14.7L333,14.8L334.2,15.4L336.8,14.3L339.4,14L342.8,13.8L348.2,13.8L348.8,14L354.2,13.6L357.8,13.8L361.4,13.9L365.9,14L369.4,14.3L372.1,14.8L371.6,15.3L366.6,16.2L362,16.6L360,17L363.9,17L358.7,18.3L355.3,18.9L350.8,20.7L346.8,21L345.3,21.5L339.6,21.7L341.9,22L340.3,22.4L341,23.5L338.6,24.3L335.3,25L333.8,25.9L330.6,26.6L330.5,27.1L333.8,27L333.4,27.6L327.4,29L322.9,28.4L317.1,28.7L314.5,28.4L311,28.3L311.7,27.2L315.6,26.6L316,25L317.3,24.8L321.5,25.8L320.1,24.3L317.5,23.9L319.8,23L323.5,22.4L324.7,21.7L322.9,20.8L323.2,19.7L328,19.8L329.2,20L332.7,19.2L328.9,19L322.5,19.1L320.1,18.4L319.5,17.5L318.1,16.9ZM324.9,51.3L323.1,52.1L320.8,52.2L320.9,50.9L322.6,49.4L324.7,49L325.9,49.8L325.3,50.9ZM285.1,45.9L285.7,46.9L283.8,47.8L281.6,47L279.7,47.3L277.8,46.1L280.1,45.3L282.4,44.2L284,44.9L284.9,45.4ZM328.6,101.3L329.5,101L332.3,101.8L334.4,103L334.3,103.6L333.1,103.6L330.3,102.7ZM327.3,109.8L327.7,111.3L329.4,111.7L331.6,111.6L330.1,112.9L329.2,113.1L326.5,111.8L326.2,110.8Z","US":"M190.2,103.9L196.9,103.9L203.9,103.9L206.2,103.9L213.4,103.9L220.4,103.9L227.5,103.9L234.5,103.9L242.6,103.9L250.6,103.9L255.5,103.9L256,102.7L256.8,102.7L256.5,104.4L257.1,104.9L258.6,105.1L260.8,105.6L262.8,106.5L264.8,106.1L267.4,106.9L268.2,106.9L270.7,106L272.5,107.1L274.4,108.3L275.9,109.3L277.4,110.3L277.3,111L277.8,111.3L277.5,111.7L278.2,111.7L278.7,111.4L278.6,112.1L278.9,112.6L279.6,112.6L279.8,113L279.3,113.5L281.3,115L280.9,117.7L280.5,120.4L279.3,122.2L277.6,123.9L276.7,125L276.5,125.3L276.7,125.8L277.4,126.2L278,126.2L281.3,124.6L284,124.1L287.6,122.6L287.8,122.3L287.8,121.3L287.6,120.7L288.9,120.2L291.3,120.2L293.5,120.2L294.6,119L295,118.8L298.2,116.6L299.5,116L303.2,116L307.6,116L308.1,115.3L308.9,115.1L310,114.6L311.3,113.2L312.7,110.9L315.2,108.6L315.8,109.4L317.5,108.9L318.3,109.7L317.1,113.9L318.2,115.6L318.4,116.6L315.4,118.1L312.6,119.2L309.8,120.1L308,121.9L307.4,122.6L307,124.2L307.4,125.8L308.4,125.9L308.4,124.8L308.9,125.5L308.5,126.4L306.7,126.9L305.6,126.8L303.6,127.3L302.5,127.5L301,127.6L298.8,128.5L302.5,128L303.1,128.5L299.4,129.5L297.8,129.5L298,129.1L297,130L297.7,130.1L296.6,132.3L294.2,134.7L294.2,133.9L293.7,133.7L293.1,133L293.2,134.6L293.7,135.2L293.4,136.4L292.3,137.6L290.3,140L290.1,139.9L291.4,137.8L290.4,136.6L290.8,134L290,135.4L290,137.4L288.5,136.9L289.9,137.9L289.3,140.8L290,141L290,142.1L289.6,145.2L287.5,147.5L284.7,148.5L282.6,150.3L281.3,150.5L279.7,151.6L279.1,152.7L275.9,154.7L274.1,156.2L272.5,158L271.7,160.2L271.7,162.4L272,165.1L272.7,167.3L272.5,168.6L273,172.3L272.6,174.4L272.3,175.6L271.3,177.5L270.5,177.9L269.2,177.5L269.1,176.1L268.2,175.4L267.3,172.7L266.5,170.3L266.4,169.1L267.3,167L266.9,165.3L265.5,162.7L264.6,162.2L261.7,163.7L261.3,163.5L260.3,162L258.9,161.3L255.9,161.7L253.7,161.3L251.7,161.5L250.6,162L250.8,162.8L250.5,164.1L250.9,164.7L250.3,165.1L249.5,164.7L248.4,165.3L246.5,165.2L245,163.5L242.7,163.9L241,163.2L239.3,163.4L237,164.1L234.1,166.5L231.3,167.8L229.5,169.3L228.6,170.7L228.1,172.8L227.9,174.3L228.2,175.4L227.2,175.5L225.5,174.8L223.7,173.8L223.3,172.4L223.2,170.2L222.1,168.4L221.6,166.6L220.8,164.5L219.3,163.2L217.2,163.3L215,165.7L213.1,164.8L212,163.9L211.8,162.1L211.4,160.5L210.3,159.1L209.2,158.2L208.6,157L204.2,157L203.8,158.3L201.8,158.3L196.7,158.4L191.6,156.2L188.2,154.6L188.6,154L185.3,154.4L182.3,154.6L182.4,153L181.4,151.2L180.3,150.9L180.4,150L179,149.8L178.4,149L176.1,148.7L175.7,148.2L176,146.4L174.7,143.3L174.3,139L174.7,138.3L174,137.3L173.1,134.7L173.9,132.1L173.3,130.4L175,127.9L176.1,125.2L176.4,122.9L178.7,120L180.4,117.2L182.1,114.4L183.8,110.4L184.4,107.8L184.5,106.4L185.1,105.8L188,106.8L187.7,109.7L188.7,108.9L189.7,106.4ZM71.9,193.4L72.3,193.7L72.6,194.1L73,195.2L72.9,195.4L71.7,196.1L70.8,196.5L70.2,197.1L69.7,196.6L70,195.7L69.8,194.6L70,194.3L70.6,193.8L70.6,193.1L70.8,192.9L71,192.9ZM70.9,191.3L70.6,191.7L69.6,191.9L69.4,191.2L69.1,191L69.1,190.8L69.5,190.5L70.3,190.8ZM69.2,190L69.1,190.4L67.7,190.3L68,189.9ZM66.4,188.3L66.5,188.5L67,189.6L66.8,189.8L66.6,189.7L65.8,189.6L65.6,188.9L65.6,188.8ZM63.3,186.8L63.2,187.5L62.8,187.8L62,187.3L62.2,187L62.7,186.7ZM116.2,70.7L117.7,70.9L116.8,72L115,72.4L114.1,71.9L113.6,71.1ZM139,77.5L140.3,77.7L140.5,78.6L137.4,80L134.3,81.1L133.8,80.3L134.6,79L137.5,78ZM195.1,45.3L185.6,55.2L171.7,70.9L173.8,71L175.2,71.7L175.8,73L176.2,74.8L179.6,73.3L182.6,72.3L182.6,73.8L183.2,75L184.2,76.3L184.1,78.3L183.9,81.6L186.5,83.4L185.3,85.3L183,86.7L182.5,85.6L181.2,84.7L182.3,82.1L181.2,79.8L182,77.1L180,76.9L176.5,76.8L174.6,76L172.4,73L170.7,72.5L167.7,71.5L164.5,71.7L161.3,70.4L159.7,69.2L156.8,69.8L155.5,71.8L154.1,72L151.1,72.6L148.3,73.5L145.3,74.1L146.5,72.5L150,69.7L153.1,68.8L153.1,68.1L148.9,69.7L145.7,71.6L140.7,73.6L141.1,75L137.2,77L133.8,78.2L130.8,79.1L129.2,80.4L124.4,81.8L122.5,83.2L118.8,84.4L117.4,84.2L114.6,85L111.5,86L108.7,87L104.1,87.8L104.2,87.4L107.8,86L110.8,85.1L114.6,83.5L117.7,83.2L119.9,82L124.5,80.3L125.5,79.7L128,78.7L130.3,76.5L133,74.8L129.6,75.7L129.4,75.2L127.2,76.2L127.1,74.8L125.6,75.8L126.1,74.4L122.8,75.5L121.4,75.5L122.8,73.8L124.2,72.8L123.7,71.8L120.4,72.3L119.8,71L119,70.3L120.5,68.7L120.1,67.5L122.5,65.9L125.9,64.4L128.1,62.9L130,62.7L131.1,63.2L134.1,61.9L135.4,62.1L137.9,61.2L138.8,60L138.1,59.5L140.8,58.4L139.5,58.5L136.6,59.1L135.3,59.7L134.3,59.1L131,59.4L128.6,58.7L128.9,57.6L128,56.1L132.2,54.9L138.3,53.6L140,53.6L138.2,55L142.7,54.8L142.8,53.2L141.4,52.2L141.4,50.8L140.7,49.7L138.9,48.9L141.6,47.5L145.4,47.4L149.3,46.2L151.3,44.9L154.8,43.7L157.1,43.4L162.2,42.2L163.8,42.4L168.5,41L170.9,41.6L171,42.7L172.5,42.2L175.7,42.4L174.9,43L177.5,43.4L179.8,43.2L183.1,44L186.8,44.2L187.9,44.6L191.1,44.2L193.3,44.9ZM114.7,61.2L115.4,61.7L117,61.4L118,62.2L119.7,62.5L119.2,62.8L117,63.4L116,62.8L115.7,62.3L113.7,62.5L113.4,62.2Z","KZ":"M685.8,103.3L684.8,105.3L683,105.5L684,108.6L683.2,109.9L678.1,108.9L678.3,114.4L677.3,115.1L672.9,116.3L676.8,121.6L675.3,122.4L676.1,124.2L674.4,123.7L672.9,122.6L669.1,122.3L665.1,122.2L664.3,122.5L660.5,121.3L659.3,121.9L659.4,123.7L655.1,122.6L653.6,123.1L653.4,124.4L652.2,125L649.5,127.1L649,129.3L648,129.4L647,127.9L643.9,127.8L642.7,125.3L641.5,125.3L641,122.2L637.5,119.9L633.4,120.2L630.6,120.6L627.7,117.9L625.4,116.7L621.1,114.5L620.6,114.2L614.8,116.1L617.4,127.4L616.2,127.5L613.9,125.1L612.1,124.2L609.5,124.9L608.6,125.9L608.3,125.2L608.7,123.9L608,122.8L604.9,121.8L603.3,119L601.8,118.2L601.5,117.2L603.9,117.5L603.6,115.3L605.5,114.8L607.7,115.2L607.5,112.3L606.6,110.4L604.3,110.5L602.1,109.8L599.6,111.1L597.5,111.8L596.2,111.3L596.1,109.7L594.2,107.7L592.4,107.8L590,105.7L590.9,103.4L590.1,102.8L591.2,99.5L594,101.3L593.8,99.1L597.8,95.8L601.4,95.8L607.1,97.8L610.2,99L612.3,97.8L616,97.7L619.4,99.3L619.8,98.4L623.2,98.5L623.3,97.1L619,95.1L620.8,93.6L620.1,92.8L622.1,92L619.8,90L620.5,89L628.7,88L629.6,87.3L634.9,86.2L636.5,85L640.8,85.6L642.7,88.6L644.8,87.9L648.1,88.9L648.5,90.5L650.6,90.4L655.3,87.6L654.8,88.5L658.6,90.8L666.7,98.3L667.4,96.8L671.2,98.5L674.3,97.7L675.8,98.2L677.6,100L679.5,100.5L681,101.8L683.9,101.4Z","UZ":"M617.4,127.4L614.8,116.1L620.6,114.2L621.1,114.5L625.4,116.7L627.7,117.9L630.6,120.6L633.4,120.2L637.5,119.9L641,122.2L641.5,125.3L642.7,125.3L643.9,127.8L647,127.9L648,129.4L649,129.3L649.5,127.1L652.2,125L653.4,124.4L654.2,124.7L652.7,126.7L654.8,127.9L656.3,127.1L659.7,128.7L657.1,131L655.1,130.7L654.2,130.7L653.6,129.9L653.7,128.4L650.6,129.2L650.3,131.2L649.6,132.9L647.5,132.7L647.1,134.1L649.1,134.8L650.2,137.1L649.5,140.3L647.5,139.6L646.1,139.6L645.7,137.7L642.1,136.4L639.2,134.8L637.3,133.4L634,131.3L632.1,128.1L631.1,127.5L628.5,127.6L627.4,127L626.6,124.6L622.9,122.9L621.3,124.7L619.4,125.8L620.1,127.3Z","PG":"M857.3,263.8L861.9,265.9L866.7,267.7L868.5,269.3L869.9,270.8L870.2,272.6L874.5,274.6L875,276.2L872.6,276.5L873,278.6L875.2,280.6L876.6,283.9L878.1,283.8L877.9,285.2L879.9,285.7L879,286.3L881.7,287.6L881.3,288.5L879.5,288.7L878.9,287.9L876.7,287.6L874,287.1L872.2,285.1L870.8,283.4L869.7,280.7L866.4,279.3L864,280.2L862.3,281.3L862.4,283.5L860.2,284.6L858.8,284.1L856,284L856.9,273.9ZM888.3,267.1L889.3,268L889.5,269.7L888.6,270.5L888.2,268.7L887.7,267.5L886.5,266.4L885,265.1L883.1,264.2L883.9,263.5L885.3,264.3L886.2,265L887.3,265.8ZM884.3,273.8L882.8,274.6L881.4,275.3L880,275.3L877.8,274.4L876.4,273.5L876.7,272.6L879,273L880.5,272.8L881,271.3L881.4,271.2L881.6,272.9L883.1,272.6L883.9,271.6L885.5,270.5L885.3,268.6L886.9,268.6L887.4,269.1L887.3,270.8L886.2,272.7L884.8,272.9ZM893.7,272.3L894.4,273L895.6,274.9L896.8,276L896.3,276.8L895.6,277.2L894.5,276L893.5,274L893.1,271.6L893.5,271.3Z","ID":"M857.3,263.8L856.9,273.9L856,284L853.9,281.4L851.3,280.8L850.5,281.7L847.1,281.8L848.5,279.2L850.2,278.4L849.8,275L848.7,272.4L843.6,269.8L841.5,269.5L837.6,266.7L836.7,268.2L835.7,268.5L835.1,267.3L835.1,266L833.2,264.5L836.1,263.3L838,263.4L837.8,262.6L833.9,262.6L832.8,260.7L830.4,260.2L829.3,258.6L833,257.9L834.3,256.9L838.6,258.1L839,259.3L839.7,264.3L842.4,266.1L844.7,262.9L847.8,261L850.2,261L852.5,262.1L854.4,263.2ZM813.3,283.3L813.5,283.9L813.4,284.8L811.5,287.1L809.1,287.8L808.9,287.4L809.2,286.4L810.5,284.5ZM838.4,277.1L838.3,274.7L838.9,273.6L839.5,272.6L840.1,273.5L840,275ZM795.3,242.9L793.8,245.7L795.9,248.6L795.5,250.1L798.5,252.9L795.3,253.3L794.4,255.4L794.5,258.2L792,260.3L791.8,263.4L790.7,268.1L790.3,267L787.2,268.4L786.2,266.5L784.3,266.4L783,265.4L779.8,266.5L778.9,265L777.1,265.2L774.9,264.8L774.6,260.6L773.3,259.8L772,257.1L771.6,254.4L771.9,251.6L773.5,249.5L774,251.6L775.8,253.3L777.5,252.7L779.2,252.9L780.8,251.4L782,251.1L784.6,251.9L786.8,251.3L788.1,247L789.1,245.9L789.9,242.4L792.9,242.4ZM826.2,264.4L829.1,265.3L830,267.7L827.7,266.4L825.5,266.1L824,266.3L822.2,266.2L822.8,264.5ZM819.4,267.5L817.5,266.9L817.1,265.6L819.8,265.4L820.4,266.4ZM822.4,249L822.6,250.7L824.2,250.9L824.4,252.2L824.3,254.9L822.9,254.6L822.5,256.5L823.6,258.1L822.9,258.5L821.8,256.5L821,252.6L821.5,250.1ZM809,253L812.1,252.9L814.7,250.6L815.2,251.3L813.1,254.4L811.1,255L808.5,254.4L804,254.5L801.7,255L801.3,257.3L803.7,260.1L805.1,258.7L810.1,257.6L809.9,259.1L808.7,258.6L807.6,260.4L805.2,261.6L807.6,265.6L807.1,266.7L809.3,270.2L809.2,272.3L807.8,273.2L806.8,272.1L808.2,269.5L805.5,270.7L804.9,269.9L805.3,268.7L803.4,266.9L803.7,263.9L801.9,264.8L802,268.4L801.9,272.8L800.2,273.3L799.1,272.4L800,269.5L799.7,266.5L798.5,266.5L797.8,264.4L798.9,262.4L799.4,259.9L800.7,255.2L801.3,254L803.5,251.7L805.6,252.6ZM800.4,287.5L797.1,285.3L799.6,284.7L800.9,285.7L801.8,286.6L801.5,287.4ZM803.7,282.2L805.5,281.9L808,280.8L807.4,282.5L803.4,283.4L799.8,283L799.9,281.9L802.1,281.2ZM795.5,281.6L797.2,281.4L797.7,282.7L794.6,283.3L792.7,283.7L791.3,283.7L792.3,281.9L793.8,281.9L794.6,280.8ZM769.8,275.6L770.1,276.7L775.2,277L775.9,275.7L780.8,277.2L781.6,279.2L785.6,279.8L788.7,281.6L785.6,282.8L782.7,281.6L780.3,281.7L777.6,281.4L775.1,280.9L772.1,279.7L770.1,279.4L769,279.8L764.2,278.5L763.8,277.2L761.4,276.9L763.4,274L766.6,274.2L768.7,275.4ZM759.3,259.1L759.8,261.2L760.7,263L762.6,263.2L763.9,265.2L763.1,269.1L762.8,273.8L759.8,273.9L757.7,271.3L754.4,268.8L753.3,266.9L751.3,264.4L750,262.1L748,257.7L745.7,255.2L744.9,252.5L743.9,250.1L741.4,248.1L740,245.5L737.9,243.7L735,240.3L734.7,238.8L736.4,238.9L740.6,239.5L743.1,242.5L745.2,244.6L746.7,245.9L749.3,249.2L752,249.3L754.3,251.4L755.9,254L757.9,255.4L756.9,257.9L758.4,259Z","AR":"M321.6,418.4L323,419.8L324.9,422L328.5,423.7L331.9,424.5L331.4,425.9L329.3,426.1L327.8,425L326.4,425L323.9,425ZM332.5,349.6L332.2,352.1L332,355.3L332.5,358.4L332.1,359.1L332.2,361.1L332.3,362.7L336,365.4L336,367.5L337.8,368.9L338,370.4L336.3,374.4L332.9,376.1L328.1,376.7L325.3,376.4L326.2,378.2L326.2,380.6L327,382.1L325.8,383.2L323.4,383.6L320.7,382.5L320,383.3L321.1,386.4L322.9,387.3L324,386.3L325.1,387.9L323.1,388.9L321.7,390.8L322.1,393.9L321.9,395.5L319.7,395.5L318.2,397.1L318.2,399.4L321.1,401.6L323.6,402.2L323.6,404.9L321.3,406.6L320.8,410.1L319.1,411.3L318.6,412.7L320.3,415.8L322.5,417.5L321.4,417.4L319.1,416.9L313.4,416.5L311.8,414.8L311.1,412.6L309.6,412.8L308.4,411.7L307.1,408.5L308.5,407.2L308.6,405.3L307.9,403.7L308.3,401.1L308,397.1L307.2,395.3L308.1,394.7L307.5,393.6L306.2,393L306.6,391.7L305.2,390.5L303.7,387L304.5,386.4L303.1,382.6L302.9,379.4L302.9,376.7L304.1,375.5L302.6,372.5L301.9,369.7L303.4,367.6L302.8,365L303.6,362L303,359.1L302.3,358.6L300.1,353.2L301,350L300.3,347L300.7,344.1L301.9,341.2L303.4,339.2L302.5,338L302.9,337L302.1,331.8L304.7,330.3L305.2,327.1L304.7,326.3L306.6,323.5L310.1,324.2L311.9,326.5L312.6,324L315.6,324.1L316.1,324.8L321.5,329.8L323.7,330.3L327.1,332.6L330,333.8L330.5,335.2L328.6,340L331.3,340.8L334.2,341.3L336.2,340.8L338.3,338.4L338.4,335.6L339.6,335L341.1,336.8L341.3,339.3L339.4,341L337.8,342.3L335.3,345.3Z","CL":"M321.6,418.4L323.9,425L326.4,425L327.8,425L327.4,426.2L325.8,427.1L324.7,427L323.2,426.8L321.3,425.9L318.7,425.5L315.3,423.9L312.3,422.3L307.9,419L310.1,419.6L314,421.6L317.4,422.6L318.1,421.3L318.2,419.3L319.9,418ZM296.4,310.2L297.9,312.3L298.5,314.6L300,315.9L299.5,318.9L301.4,322.4L302.9,326.7L304.7,326.3L305.2,327.1L304.7,330.3L302.1,331.8L302.9,337L302.5,338L303.4,339.2L301.9,341.2L300.7,344.1L300.3,347L301,350L300.1,353.2L302.3,358.6L303,359.1L303.6,362L302.8,365L303.4,367.6L301.9,369.7L302.6,372.5L304.1,375.5L302.9,376.7L302.9,379.4L303.1,382.6L304.5,386.4L303.7,387L305.2,390.5L306.6,391.7L306.2,393L307.5,393.6L308.1,394.7L307.2,395.3L308,397.1L308.3,401.1L307.9,403.7L308.6,405.3L308.5,407.2L307.1,408.5L308.4,411.7L309.6,412.8L311.1,412.6L311.8,414.8L313.4,416.5L319.1,416.9L321.4,417.4L319.4,417.4L318.5,418.1L316.8,419.2L317.4,421.9L316.5,422L313.5,421L310.1,419L306.6,417.3L305.2,415.4L305.3,413.7L303.4,411.7L301.3,406.6L301.3,403.7L303.1,401.3L299.2,400.4L300.6,397.7L299.9,392.7L302.9,393.7L302.4,387.4L300.5,386.6L300.8,390.4L299.2,390L298.7,385.6L298,379.8L298.6,377.7L297.2,374.7L296.1,371.2L297.2,371.1L297.6,366.1L298.2,361.1L298.4,356.5L296.9,351.8L297.2,349.2L296.2,345.4L297.1,341.6L296.6,335.5L296.5,329.1L296.4,322.1L295.6,317L294.6,312.6L295.9,311.8Z","CD":"M558.5,269.7L558.9,272.5L558.6,274.1L559.1,275.9L560.6,277.6L562,281.6L561,281.2L557.4,281.8L556.7,282.1L555.9,284.1L556.4,285.5L555.9,289.1L555.5,292.3L556.2,292.8L558,294L558.7,293.5L558.8,296.8L556.8,296.8L555.8,295.1L554.8,293.7L552.8,293.3L552.3,291.7L550.6,292.7L548.5,292.2L547.6,290.8L545.9,290.5L544.7,290.6L544.6,289.6L543.7,289.6L542.4,289.4L540.8,289.9L539.6,289.8L539,290.1L539.2,286.4L538.3,285.2L538.1,283.3L538.6,281.4L538,280.3L538,278.3L534.8,278.3L535,277.2L533.7,277.2L533.5,277.8L531.8,277.9L531.2,279.7L530.8,280.5L529.3,280L528.4,280.5L526.6,280.7L525.6,279.1L525,278.1L524.3,276.2L523.6,273.9L515.7,273.9L514.8,274.3L514,274.2L512.9,274.6L512.6,273.6L513.2,273.3L513.3,272L513.8,271.2L514.7,270.5L515.4,270.8L516.4,269.7L517.8,269.7L518,270.6L519,271.1L520.6,269.2L522.1,267.7L522.8,266.7L522.7,264.1L523.9,261.1L525.1,259.5L526.9,258L527.2,257L527.3,255.9L527.7,254.8L527.6,253.1L527.9,250.3L528.4,248.4L529.2,246.7L529.4,244.9L529.6,242.7L530.6,241.1L532,240.1L534.3,241.2L536,242.3L537.9,242.6L539.9,243.2L540.7,241.4L541.1,241.1L542.3,241.4L545.3,239.9L546.3,240.6L547.2,240.5L547.6,239.7L548.6,239.4L550.6,239.8L552.3,239.8L553.2,239.5L554.8,242.1L556,242.4L556.7,241.9L558,242.1L559.5,241.5L560.1,242.8L562.5,244.9L562.4,248.5L563.4,248.9L562.6,250L561.5,250.8L560.5,252.4L560,253.9L559.8,256.4L559.2,257.5L559.2,259.9L558.4,260.7L558.3,262.6L557.9,262.8L557.7,264.5L558.3,265.9Z","SO":"M591.3,260.9L589.7,258.4L589.7,247.1L592,243.6L592.7,242.6L594.4,242.6L596.7,240.4L600.2,240.2L607.5,230.9L609.3,228.3L610.4,226.4L610.4,224.8L610.3,221.7L610.2,220.4L610.2,220.4L611.1,220.3L612.3,219.8L613.7,219.5L614.9,218.5L615.9,218.5L616,219.3L615.8,221.1L615.9,222.8L615.4,223.9L614.8,227.2L613.6,230.7L612.1,234.6L609.9,239.2L607.7,242.7L604.6,246.9L601.9,249.4L598,252.5L595.5,254.8L592.5,258.6L591.9,260.2ZM610.2,220.4L610.2,220.4L610.3,221.7L610.4,224.8L610.4,226.4L609.3,228.3L607.5,230.9L605.3,231L596.5,227.3L595.4,226.2L594.4,224.7L593.3,223L593.9,221.9L594.8,220.2L595.7,220.8L596.2,222.1L597.5,223.4L598.8,223.4L601.3,222.6L604.2,222.2L606.5,221.2L607.8,221L608.7,220.5Z","KE":"M584.8,270.2L581,267.1L580.9,265.3L571.2,259L570.7,258.7L570.7,255.4L571.5,254.1L572.8,252.1L573.8,249.8L572.6,246.3L572.2,244.7L570.9,242.6L572.6,240.7L574.3,238.7L575.7,239.2L575.8,240.9L576.7,241.9L578.6,241.9L582,244.6L582.8,244.6L583.4,244.5L584,244.9L585.8,245.1L586.6,243.8L589,242.5L590.1,243.6L592,243.6L589.7,247.1L589.7,258.4L591.3,260.9L589.4,262.2L588.7,263.5L587.7,263.7L587.3,265.9L586.5,267.1L585.9,269.2Z","SD":"M545.6,230.2L543.5,228.9L542.6,228L542.4,227L542.8,225.7L542.7,224.5L541.2,222.5L540.9,221.2L540.9,220.4L539.9,219.5L539.8,217.7L539.2,216.5L538.3,216.7L538.5,215.6L539.2,214.3L538.8,213L539.7,212L539.1,211.3L539.8,209.4L540.9,207.1L543.2,207.3L542.7,195L542.6,193.7L545.7,193.7L545.4,187.5L555.9,187.5L566.1,187.5L576.4,187.5L577.5,190.5L576.9,191.1L577.5,194.3L578.7,198L579.7,198.8L581.3,199.9L580,201.7L578.1,202.2L577.3,203.1L577.2,205.2L576.2,209.8L576.6,211L576.2,213.7L575.3,216.7L573.7,218.3L572.7,220.7L572.4,221.9L571.2,222.8L570.5,226L570.6,228.8L570.5,226.4L570.2,226.3L570.2,224.8L569.8,223.7L568.4,222.5L568,220.3L568.3,218L567,217.8L566.9,218.5L565.3,218.6L565.9,219.5L566.2,221.4L564.8,223.1L563.5,225.3L562.2,225.6L559.9,223.8L558.9,224.5L558.6,225.4L557.3,226L557.2,226.6L554.6,226.6L554.2,226L552.3,225.9L551.3,226.4L550.6,226.1L549.2,224.3L548.7,223.5L546.8,223.9L546.1,225.3L545.4,228.1L544.5,228.7L543.7,229Z","TD":"M542.7,195L543.2,207.3L540.9,207.1L539.8,209.4L539.1,211.3L539.7,212L538.8,213L539.2,214.3L538.5,215.6L538.3,216.7L539.2,216.5L539.8,217.7L539.9,219.5L540.9,220.4L540.9,221.2L539.2,221.7L537.8,223L536,226.4L533.5,227.8L530.9,227.6L530.2,227.9L530.4,229L529.1,230.1L527.9,231.3L524.6,232.5L523.9,231.8L523.5,231.7L523,232.5L520.8,232.7L521.2,231.9L520.3,229.8L520,228.5L518.8,227.9L517.2,226.1L517.8,224.7L519,225L519.7,224.8L521.2,224.8L519.7,222L519.8,219.9L519.6,217.9L518.5,215.9L518.7,214.4L517,214.3L517,212.3L515.9,211.2L517,207.1L520.3,204.2L520.3,200.1L521.2,193.8L521.7,192.5L520.6,191.4L520.6,190.4L519.5,189.6L518.8,184.8L521.4,183.1L532,189Z","HT":"M291.5,194.6L291.6,196.3L291.2,197.5L290.5,198L291.1,198.9L291,199.8L289.3,199.2L288,199.5L286.4,199.2L285.1,199.8L283.8,198.8L284.2,197.8L286.6,198.3L288.5,198.5L289.5,197.8L288.5,196.5L288.6,195.3L287,194.8L287.7,193.9L289.3,194.1Z","DO":"M291,199.8L291.1,198.9L290.5,198L291.2,197.5L291.6,196.3L291.5,194.6L291.9,194L294,194.1L295.4,194.9L296.1,194.8L296.5,195.9L297.9,195.8L297.8,196.8L298.9,196.9L300.1,198L299,199.3L297.8,198.6L296.6,198.7L295.7,198.6L295.2,199.1L294.2,199.3L293.8,198.6L292.9,199L291.6,201.2L291,200.7Z","RU":"M647.4,18L650.8,17.6L655.4,18.6L661.9,20.7L663.5,22.7L659.8,23L654,22.3L650.2,21.5L647.2,19.9L644.3,19.5ZM667.9,21.8L673.9,23.1L674.3,24L664.7,24.9L665.1,21.9L666.4,21.7ZM743.1,29.1L748.2,29.2L756.7,30.5L757.3,32.3L750.2,32.3L747.6,32.8L742,31.2L741.1,29.6ZM763.3,31L768.9,31.7L767.9,32.7L764.5,32.4L759.8,31.5L759.3,30.7ZM752.8,35.9L753.6,34.9L755.8,34.7L759.6,35.7L760.6,36.3L757.6,36.3L753.3,36.1ZM560.6,19L563.9,18.6L566.6,18.5L567.2,19.1L568,18.6L569.5,18.3L572.4,18.7L571.9,19L569.6,19.3L568.1,19.5L568.1,19.8L566.1,20.2L563.9,19.7L564.6,19ZM531.9,88.1L527.7,88.1L524.8,87.8L525.2,86.5L528.3,85.5L530.7,86.1L531.8,86.5L531.6,87.3ZM584,35L587.7,32.8L586.6,31.7L590.3,30.4L595.8,28.8L601.8,28.4L604.5,27.5L608,27.2L609.9,28.1L609.1,28.9L603,30.1L597.8,31.2L593,33.6L591.2,36L589.2,38.5L590.5,40.6L595.2,42.7L594.1,42.9L587.4,42.6L586.4,41.4L582.5,40.7L581.7,39.4L583.5,38.8L582.9,37.4L585.9,35.3ZM807.5,89.9L810.4,92.7L812.4,95.7L815.4,98.7L821.3,104L817.2,103L818.5,107.3L822.7,110.4L823.9,112.6L821,110.7L820.9,113.1L818.9,110.5L817.4,107.6L815,104.3L814.1,102.1L811.6,98.1L808.2,95.1L805.5,91.1L806.7,89.7L804.8,88.4L805.5,88ZM113.8,47.3L113.8,47.3L116.3,49.3L118.5,51.9L116.4,53.6L117,54.3L118.8,52.3L124,52.7L125.2,55.2L121.7,56.4L118,56.7L115,59.3L113.5,59.9L111.6,59.8L111,58.9L109.1,58.1L110,56.9L108.4,56.5L105.6,56.8L105.6,55.9L107.2,54.9L104,55.5L103.4,56.8L100.9,57.9L100.9,57.9L113.8,47.3ZM859.1,57.9L859.1,57.9L857.8,59.1L854.8,58.9L858.4,60.4L862.3,62.7L864.1,63.4L865.6,64.5L865.9,65.3L861.2,64.7L857.4,66.8L855.9,67.1L854.6,69.1L853.2,70.8L853.7,72.1L848.6,70.1L845.1,72.3L843.1,71.3L842.1,72.5L838.8,72.1L839.9,74L839.8,76.7L840.9,77.9L844.1,78.5L847.5,82.7L845.5,82.8L846.7,85.3L848.7,86.5L846,88L847.9,91.4L845.1,92.1L846.7,95.1L845.5,97.9L843.1,95.8L838.8,91.5L832.2,85L829.9,81L830.3,79.2L829.3,77.9L832.2,77.3L832.8,73.7L833.9,70.8L835.6,68.5L833.4,64.6L831,64.8L832,67.1L829.5,70.2L824.4,66.8L819.7,67.7L818.6,72.4L822,74.2L817.8,74.9L814.6,75.2L813,73.1L809.2,72.7L807.7,74.1L800.5,73.6L793.9,74.5L791.2,80L787.6,86.9L791.4,87.3L793.8,89.1L796.5,89.7L796.9,88.3L799.6,88.5L805.2,91.7L807.1,94.2L807.3,97.2L809.5,100.8L811.5,105.6L810.5,109.9L811,112.1L809.7,115.6L808.4,119.1L807.8,120.9L805.5,122.7L804,122.8L801.7,121.3L799.5,123.5L799.7,124.6L799.7,124.6L799.1,124L798.3,122.5L799.5,122.4L798,118.8L796,116.1L797.4,115.1L800.7,115.6L800.6,112.6L799.6,109.3L799.9,108.2L799.5,105.5L796.1,106.4L794.7,107.6L791.1,107.6L788.5,104.7L784.5,102.6L779.8,101.6L777.2,98.7L775.3,96.9L773.6,95.6L770.3,92.6L767.6,91.5L763.6,90.6L760.6,90.7L758.1,91.2L757.1,92.7L758.8,93.4L759.8,95L759.1,96L758.8,99.2L759.5,100.5L757.3,102.4L753.8,101.2L751.2,101.5L749.4,100.5L747.8,100.2L745.5,102.3L742.6,102.8L740.9,103.5L737.6,103L735.5,103.1L733.3,101.5L730.3,100.1L727.7,99.7L725,100.1L723,100.6L719.1,99.4L717.6,97.1L714.4,96.4L712.2,96L709,94.8L708,97.9L709.8,99.6L708.5,101.7L704.7,101L702.3,100.9L700.2,99.5L697.7,99.4L695.3,98.5L692.3,99.9L688.9,102.5L686.7,103L685.8,103.3L683.9,101.4L681,101.8L679.5,100.5L677.6,100L675.8,98.2L674.3,97.7L671.2,98.5L667.4,96.8L666.7,98.3L658.6,90.8L654.8,88.5L655.3,87.6L650.6,90.4L648.5,90.5L648.1,88.9L644.8,87.9L642.7,88.6L640.8,85.6L636.5,85L634.9,86.2L629.6,87.3L628.7,88L620.5,89L619.8,90L622.1,92L620.1,92.8L620.8,93.6L619,95.1L623.3,97.1L623.2,98.5L619.8,98.4L619.4,99.3L616,97.7L612.3,97.8L610.2,99L607.1,97.8L601.4,95.8L597.8,95.8L593.8,99.1L594,101.3L591.2,99.5L590.1,102.8L590.9,103.4L590,105.7L592.4,107.8L594.2,107.7L596.1,109.7L596.2,111.3L597.5,111.8L596.8,113.6L594.6,114.1L592.8,117.2L595.5,120.1L595.7,122.2L599,125.8L597.7,127.1L597.4,127.9L596.3,127.6L594.3,125.8L593.6,125.7L592,125L591,123.7L588.6,123.1L587.2,123.5L586.7,123L583.1,121.5L579.5,121L577.3,120.5L577.1,120.8L573.6,118.2L570.7,117.1L568.3,115.3L570,114.8L571.6,112.3L570.1,111L573.4,109.8L573.2,109.1L571.1,109.6L571,108.3L572.1,107.4L574.3,107.2L574.5,106.2L573.7,104.6L574.4,103L574.2,102.1L570.6,101.1L569.2,101.2L567.5,99.7L565.8,100.2L562.6,99.2L562.6,98.6L561.5,97.3L559.7,97.1L559.3,96.2L559.8,95.6L558,93.9L555.7,94.2L555,94.1L554.5,94.7L553.6,94.6L552.7,92.7L552,91.8L552.4,91.5L554.3,91.6L555.1,90.9L554.3,90.2L552.7,89.6L552.7,89.1L551.7,88.6L550,86.6L550.3,85.9L549.9,84.5L547.6,83.8L546.4,84.1L546,83.4L543.5,82.7L542.5,81L542.1,79.6L540.9,78.9L541.8,78L540.7,75.4L542,73.7L541.6,73.2L543.8,71.7L541.3,70.3L545.3,66.7L547,65.1L547.5,63.7L544,61.8L544.5,60L542.2,58L543.2,55.7L540.2,52.6L541.7,50.6L538.2,48.8L538.1,47L539.7,46.8L542.9,45.7L544.8,44.8L548.5,46.4L554.2,47L562.7,50L564.7,51.3L565.3,53L563.4,54.4L560.1,55.2L550.4,53.1L548.9,53.5L552.8,55.4L553.2,56.7L554,59.5L556.9,60.3L558.7,61L558.7,59.7L557.1,58.5L558.2,57.5L563.7,59.2L565.3,58.5L563.4,56.5L567.5,53.9L569.5,54L571.7,55L572.4,53.1L570.2,51.5L570.7,49.9L568.7,48.3L574.7,49.1L576.3,50.6L573.8,51L574.3,52.4L576.2,53.4L579.2,52.8L579.2,51.1L583.1,49.8L589.4,47.5L591,47.7L589.6,49.3L592.2,49.6L593.3,48.6L597.1,48.6L599.7,47.5L602.7,49.1L604.3,47.3L601.5,45.8L602.2,44.9L608.5,45.7L611.7,46.6L620.5,49.6L621.2,48.2L618.4,46.8L618.1,46.2L615.5,46L615.6,44.7L613.6,42.7L613.1,41.9L615.6,39.6L615.7,37.3L616.9,36.8L622.4,37.4L623.6,38.8L622.9,40.9L624.5,41.7L626.1,43.5L627.5,47.1L630.6,48.7L630.6,50.5L628.4,54.3L631,54.7L631.4,53.7L633.3,53L633.2,51.7L634.3,50.4L632.4,48.9L632.4,47.2L630.1,47L628.8,45.5L629,42.9L625.3,40.8L627.9,39.1L626.4,37.3L627.4,37.2L629.2,38.6L629.8,41.1L632.2,41.6L630.3,39.7L633,38.7L637,38.6L641.5,40L638.5,37.9L636.6,35.2L639.7,34.7L644.4,34.8L648.4,34.5L645.9,33.2L647,31.6L649.2,31.5L652,30.3L656.8,30L656.9,29.3L661.7,29.1L663.7,29.7L666.8,28.4L670.3,28.4L669.9,27.4L670.8,26.4L674.3,25.4L678.2,26.2L676.3,26.8L680.8,27.1L682.5,28.3L683.6,27.7L689.2,27.8L694.6,28.9L697,29.8L697.7,31.1L696.3,31.8L692.5,33.2L691.7,33.9L694.4,34.3L697.8,34.9L699.1,34.4L701.5,36L701.8,35.4L704.6,35L711.2,35.4L712.7,36.6L721.3,36.9L719.5,35L724.1,35.5L727.2,35.4L731.7,36.8L734.2,38.4L734,39.4L738.5,41.5L742.6,42.5L741.9,39.8L746.2,41L748.9,40.3L753.6,41.1L754.3,40.3L757.9,40.7L754,38.3L755.4,37.2L775,38.9L778.4,40.4L785.8,42.4L793.3,41.9L797.8,42.3L800.7,43.4L802.7,45.3L806,46L808.1,45.5L811.6,45.4L816,45.9L819.5,45.6L825.8,48L827.3,47.1L823.7,45.5L823.2,44.3L830.5,45L834.5,44.9L841.9,46.1L846.2,47.3L859.1,57.9ZM839.9,42.4L837.9,42.5L836.4,41.7L837.6,40.6L839.9,42.4ZM122.4,40.6L122.4,40.6L122.4,40.6L122.8,40.5L124.5,40.5L126.4,41.3L125.8,41.6L122.9,42.2L120.1,42.4L120.1,42.4L122.4,40.6ZM560.2,113.1L560.7,112.3L562.5,113L563.3,113.1L563.7,113.7L564.1,113.8L564.1,114.1L565.4,114.8L567.9,114.6L567.5,115.7L565,116.2L562,118L560.5,117.4L560.9,115.9L558.1,115L558.5,114.5L560.6,113.4Z","BS":"M275.8,172.5L277,172.3L278.7,172.4L278.7,173.2L275.7,173.7ZM279,171.8L280.8,173.2L280,175.4L279.6,175L279.9,173.3L278.9,172.1ZM277,177.5L277.7,177.6L278.2,180.2L278,182L277.3,182.1L276.9,180.3L276.1,179.4Z","FK":"M338.1,416.1L340.3,414.3L342.5,415L343.6,413.8L345.8,415.2L345.4,416.2L342.6,417.1L341.2,416.1L339.6,417.4Z","NO":"M507.5,20.9L508.1,20.2L510.7,20.1L513.2,20.9L519.5,22.5L515.1,23.4L514.3,25.1L512.8,25.6L512.2,27.5L509.9,27.6L505.7,26.2L507.3,25.3L504.4,24.7L500.6,22.7L499,21L503.8,20.2L504.9,21ZM542.9,45.7L539.7,46.8L538.1,47L538.6,45.2L535.8,44.1L532.8,45L532.2,46.9L530.5,48.1L528.2,47.5L525.5,47.6L523.1,46.2L521.9,46.9L520.7,47L520.6,48.7L516.7,48.3L516.4,49.8L514.4,49.8L513.3,51.7L511.5,54.6L508.6,58.5L509.5,59.4L508.8,60.5L506.7,60.4L505.5,63L505.9,66.7L507.4,68.1L506.9,71.4L505.2,73.3L504.4,75L502.8,73.2L498.6,76.5L495.7,77.2L492.5,75.7L491.7,72.7L490.8,66.2L492.7,64.4L498.2,62.1L502.3,59.3L505.8,55.5L510.3,50.3L513.6,48.3L518.7,45L523,43.9L526.3,44L529,41.9L532.6,42L536.1,41.5L542.8,43.4L540.4,44.1ZM529.6,20.1L527.2,21.3L522,21.5L516.5,21.2L516.1,20.6L513.5,20.5L511.3,19.5L516.7,18.9L519.5,19.4L521.1,18.8L525.8,19.3ZM526,25.1L522,26L518.6,25.5L519.8,24.9L518.5,24.1L522.2,23.7L523.2,24.5Z","GL":"M398.4,14.8L405,13.7L411,13.7L413.6,13.1L419.8,12.9L433.4,13.1L443.7,14.6L440.2,15.3L433.5,15.4L424,15.6L424.7,16L431,15.8L436.1,16.5L439.7,15.8L441,16.6L438.7,17.8L443.4,17L452.2,16.2L457.4,16.6L458.3,17.5L450.7,19L449.6,19.5L443.8,19.8L448,19.9L445.5,21.5L443.8,23L443.3,25.6L445.3,27.1L442.4,27.2L439.1,27.9L442.4,29.2L442.5,31.3L440.4,31.5L442.6,33.6L438.2,33.8L440.3,34.8L439.5,35.7L436.7,36.1L434,36.1L436.1,37.8L436,38.9L432.3,37.9L431.1,38.6L433.7,39.2L436,40.8L436.4,42.8L432.8,43.3L431.4,42.3L429.2,40.8L429.6,42.6L427,44L432.3,44.1L435,44.2L429.2,46.5L423.3,48.6L417.1,49.5L414.9,49.5L412.5,50.5L409,53.3L404.1,55.2L402.6,55.3L399.7,56L396.5,56.6L394.2,58.3L393.7,60.2L392.2,62L388.1,64.2L388.4,66.4L386.8,68.7L385,71.5L381.9,71.6L379.3,69.3L374.9,69.3L373.3,67.8L372.6,65.1L370,61.6L369.5,59.8L370.1,57.4L368,54.9L369.5,52.9L368.5,52L371.6,48.9L375.1,47.9L376.3,46.8L377.4,44.7L374.8,45.7L373.5,46L371.6,46.4L369.4,45.6L370,43.8L371.3,42.4L373.2,42.4L377,43.1L374.2,41.4L372.8,40.6L370.6,40.9L369.2,40.3L372.4,37.9L371.6,37L370.8,35.2L369.7,32.6L367.7,31.6L368.2,30.6L363.9,29.2L359.9,29L354.8,29.1L350.1,29.3L348.3,28.5L346,27L351.4,26.3L355.2,26.2L347.6,25.6L344.1,24.6L344.9,23.7L352.7,22.6L360.1,21.6L361.4,20.8L357,20L359.3,19.1L366.6,17.6L369.3,17.4L369.3,16.5L373.9,16L379.6,15.6L385,15.6L386.4,16.3L391.9,15.2L395.6,15.9L397.9,16.1L401.2,16.7L397.7,15.6Z","TF":"M643,406.4L644.2,407.4L646.3,407.7L646.2,408.3L645.1,409.7L641.4,409.9L641.9,408.3L642.6,407Z","TL":"M813.3,283.3L813.6,282.5L816,281.8L817.9,281.7L818.7,281.3L819.7,281.7L818.7,282.6L815.8,283.9L813.4,284.8L813.5,283.9Z","ZA":"M522.1,344.5L523.4,342.9L524.3,343.8L524.7,345.1L525.9,345.4L527.5,345.9L528.8,345.7L531.2,344.1L531.7,332.6L532.4,333.1L533.8,336L533.5,337.9L534,339L535.9,338.7L537.2,337.3L538.5,336.4L539.2,334.9L540.5,334.2L541.6,334.5L542.8,335.4L544.9,335.6L546.6,334.8L546.9,333.9L547.4,332.4L548.9,332.1L549.7,331L550.7,328.9L553.2,326.6L557,324.3L558,324.3L559.3,324.8L560.2,324.5L561.6,324.8L562.5,329.2L563.1,331.4L562.4,334.8L562.5,336L561.3,335.4L560.5,335.6L560.2,336.5L559.4,337.7L559.4,338.8L560.8,340.5L562.3,340.1L562.9,338.7L564.9,338.8L564.1,341L563.6,343.6L562.8,345L560.9,346.6L560.4,347.1L559.2,348.6L558.4,350.2L556.7,352.5L553.6,355.7L551.7,357.6L549.6,359L546.9,360.2L545.6,360.4L545.2,361.2L543.7,360.8L542.4,361.4L539.7,360.7L538.1,361.1L537.1,361L534.4,362.2L532.2,362.7L530.6,363.9L529.5,363.9L528.5,362.8L527.6,362.8L526.6,361.4L526.4,361.8L526.2,361L526.3,359.2L525.5,357.1L526.4,356.5L526.4,354.1L524.9,351.2L523.7,348.5L523.7,348.5ZM554.5,345.7L553.4,344.7L552.2,345.3L550.7,346.6L549.2,348.5L551,350.9L551.9,350.6L552.4,349.6L553.9,349.1L554.4,348.1L555.3,346.6Z","LS":"M554.5,345.7L555.3,346.6L554.4,348.1L553.9,349.1L552.4,349.6L551.9,350.6L551,350.9L549.2,348.5L550.7,346.6L552.2,345.3L553.4,344.7Z","MX":"M182.3,154.6L185.3,154.4L188.6,154L188.2,154.6L191.6,156.2L196.7,158.4L201.8,158.3L203.8,158.3L204.2,157L208.6,157L209.2,158.2L210.3,159.1L211.4,160.5L211.8,162.1L212,163.9L213.1,164.8L215,165.7L217.2,163.3L219.3,163.2L220.8,164.5L221.6,166.6L222.1,168.4L223.2,170.2L223.3,172.4L223.7,173.8L225.5,174.8L227.2,175.5L228.2,175.4L226.6,178.1L225.7,180.4L224.8,184.6L224.2,186.1L224.4,187.8L224.9,189.3L225,191.7L226.4,194L226.8,195.8L227.6,197.3L230.2,198.2L231.1,199.5L233.6,198.6L235.6,198.3L237.7,197.7L239.4,197.2L241.3,195.9L242.2,194.1L242.8,191.5L243.3,190.6L245.2,189.8L248.1,189L250.4,189.1L252.1,188.9L252.6,189.5L252.3,191L250.6,192.9L249.7,194.8L250.1,195.3L249.5,196.7L248.6,199.1L248,198.3L247.4,198.4L246.9,198.4L245.7,200.3L245.3,199.9L245,200L244.9,200.5L242.5,200.5L240,200.5L239.8,202.2L238.6,202.2L239.5,203.3L240.3,204L240.6,204.7L241,204.8L240.8,205.9L237.4,205.9L235.8,208.4L236.1,209L235.7,209.8L235.6,210.7L233,207.3L231.7,206.3L229.6,205.5L228.1,205.7L225.9,206.9L224.5,207.2L222.7,206.4L220.8,205.8L218.5,204.4L216.6,203.9L213.8,202.5L211.8,201L211.3,200.2L209.8,200L207.3,199L206.4,197.6L203.9,195.8L202.9,193.8L202.5,192.3L203.5,192L203.3,191.1L204.1,190.3L204.3,189.3L203.7,187.9L203.7,186.6L203.1,185L201.4,182L199.3,179.5L198.5,177.6L196.6,176.3L196.3,175.5L197.1,173.6L196,172.9L194.8,171.4L194.7,169.2L193.4,168.9L192.3,167.3L191.5,165.8L191.7,164.8L191,162.5L190.8,160.1L191.2,158.9L189.7,157.6L188.8,157.8L187.6,156.9L186.8,158.2L186.8,159.7L186.3,162L186.8,163.3L188.1,165.4L188.4,166.2L188.7,166.4L188.7,167.5L189.2,167.4L189.2,169.4L189.8,170.2L190,171.3L191.3,172.9L191.4,175.8L191.9,177.2L192.3,178.7L192,180.3L193.3,180.4L194,181.8L194.7,183.2L194.5,183.8L193.2,184.9L192.7,184.9L192.4,183L191.1,181.2L189.5,179.7L188.4,178.9L189,176.6L189,175L188,174L186.6,172.6L186.1,173L185.7,172.2L184.3,171.4L183.2,169.6L183.5,169.4L184.5,169.6L185.8,168.4L186.2,167L184.9,164.8L183.6,163.9L183.2,162L182.9,159.9L182.5,157.4Z","UY":"M332.5,349.6L334.1,349.3L337,351.7L337.9,351.6L340.8,353.6L343.1,355.3L344.9,357.4L344,358.9L344.9,360.7L344.1,362.6L341.6,364.4L339.6,363.7L338.3,364.1L335.7,362.7L334,362.8L332.2,361.1L332.1,359.1L332.5,358.4L332,355.3L332.2,352.1Z","BR":"M344.9,360.7L344,358.9L344.9,357.4L343.1,355.3L340.8,353.6L337.9,351.6L337,351.7L334.1,349.3L332.5,349.6L335.3,345.3L337.8,342.3L339.4,341L341.3,339.3L341.1,336.8L339.6,335L338.4,335.6L338.7,333.8L338.8,332L338.6,330.3L337.6,329.7L336.7,330.2L335.7,330.1L335.3,328.9L334.7,326L334.1,325.1L332.3,324.2L331.3,324.9L328.5,324.3L328.2,320L327.3,318.3L328,317.7L327.6,315.9L328.2,314.5L328.5,312.1L327.7,310.1L326.2,309.3L325.8,308L326,306.2L321,306.1L319.7,302.5L320.4,302.4L320.3,301.1L319.7,300.2L319.5,298.4L317.9,297.5L316.2,297.5L315.1,296.6L313.2,296L312.1,294.8L309.1,294.3L306,291.6L306.1,289.5L305.7,288.3L305.9,286L302.4,286.5L301.1,287.6L298.8,288.9L298.3,289.8L296.9,289.9L294.9,289.6L293.5,290.2L292.2,289.8L292.1,285.1L290,286.9L287.7,286.9L286.6,285.2L284.8,285L285.3,283.7L283.7,281.8L282.5,279L283.2,278.5L283.1,277.1L284.7,276.2L284.4,274.6L285,273.5L285.1,272.1L288.1,269.9L290.3,269.4L290.7,268.9L293.1,269L294.1,260.5L294.2,259.2L293.8,257.4L292.6,256.3L292.6,254L294.1,253.5L294.6,253.9L294.7,252.7L293.2,252.3L293.2,250.4L298.4,250.5L299.3,249.4L300,250.4L300.5,252.2L301,251.8L302.5,253.5L304.6,253.3L305.1,252.3L307.1,251.6L308.2,251.1L308.5,249.8L310.4,248.9L310.3,248.3L308,248L307.7,246L307.8,244L306.6,243.2L307.1,242.9L309.1,243.3L311.2,244L312,243.3L314,242.8L317,241.7L318,240.5L317.6,239.6L319,239.5L319.6,240.2L319.3,241.6L320.2,242L320.8,243.5L320,244.6L319.5,247.2L320.2,248.8L320.4,250.2L322,251.6L323.3,251.8L323.6,251.2L324.5,251.1L325.7,250.5L326.6,249.7L328,249.9L328.7,249.8L330.1,250.1L330.4,249.5L330,248.8L330.2,247.9L331.3,248.2L332.6,247.9L334.1,248.6L335.3,249.2L336.1,248.4L336.7,248.5L337,249.4L338.3,249.1L339.4,248L340.2,245.7L341.8,242.9L342.8,242.7L343.4,244.4L344.8,249.8L346.3,250.3L346.3,252.5L344.3,255L345.1,256L349.9,256.4L350,259.6L352,257.5L355.4,258.6L359.8,260.5L361.1,262.3L360.7,264.1L363.8,263.1L369,264.7L373,264.6L377,267.2L380.5,270.7L382.5,271.5L384.8,271.7L385.8,272.6L386.8,276.6L387.3,278.5L386.3,283.6L385,285.6L381.4,289.9L379.8,293.4L378,296.1L377.3,296.2L376.7,298.5L377.1,304.3L376.6,309.1L376.5,311.1L375.7,312.3L375.5,316.5L373.1,320.6L372.9,323.8L370.9,325.1L370.4,327L367.6,327L363.6,328.2L361.8,329.6L359,330.5L356.2,333L354.3,336.1L354.2,338.4L354.8,340.1L354.7,343.3L354.2,344.8L352.6,346.5L350.5,352L348.6,354.5L347.1,355.9L346.3,358.9Z","BO":"M294.9,289.6L296.9,289.9L298.3,289.8L298.8,288.9L301.1,287.6L302.4,286.5L305.9,286L305.7,288.3L306.1,289.5L306,291.6L309.1,294.3L312.1,294.8L313.2,296L315.1,296.6L316.2,297.5L317.9,297.5L319.5,298.4L319.7,300.2L320.3,301.1L320.4,302.4L319.7,302.5L321,306.1L326,306.2L325.8,308L326.2,309.3L327.7,310.1L328.5,312.1L328.2,314.5L327.6,315.9L328,317.7L327.3,318.3L327.1,317.3L324.5,315.8L322.1,315.7L317.6,316.6L316.6,319.4L316.7,321L316.1,324.8L315.6,324.1L312.6,324L311.9,326.5L310.1,324.2L306.6,323.5L304.7,326.3L302.9,326.7L301.4,322.4L299.5,318.9L300,315.9L298.5,314.6L297.9,312.3L296.4,310.2L297.8,306.9L296.4,304.3L296.9,303.2L296.3,302.1L297.2,300.5L297.1,297.9L297.1,295.7L297.6,294.6Z","PE":"M293.1,269L290.7,268.9L290.3,269.4L288.1,269.9L285.1,272.1L285,273.5L284.4,274.6L284.7,276.2L283.1,277.1L283.2,278.5L282.5,279L283.7,281.8L285.3,283.7L284.8,285L286.6,285.2L287.7,286.9L290,286.9L292.1,285.1L292.2,289.8L293.5,290.2L294.9,289.6L297.6,294.6L297.1,295.7L297.1,297.9L297.2,300.5L296.3,302.1L296.9,303.2L296.4,304.3L297.8,306.9L296.4,310.2L295.9,311.8L294.6,312.6L291.8,310.8L291.4,309.6L285.9,306.4L280.8,303L278.6,301.1L277.3,298.6L277.6,297.7L275,293.6L272,287.9L269.1,281.7L268,280.3L267,278L264.9,276L262.9,274.7L263.7,273.3L262.3,270.4L263.1,268.2L265.2,266.3L265.5,267.6L264.8,268.3L264.9,269.4L266,269.2L267.1,269.5L268.2,271.1L269.7,269.8L270.2,267.7L271.7,265L274.9,263.8L277.8,260.6L278.6,258.5L278.3,256.2L279,255.9L280.7,257.4L281.6,258.8L282.9,259.6L284.5,262.9L286.5,263.3L287.9,262.4L288.9,263L290.5,262.7L292.6,264.2L290.9,267.3L291.7,267.4Z","CO":"M301,251.8L300.5,252.2L300,250.4L299.3,249.4L298.4,250.5L293.2,250.4L293.2,252.3L294.7,252.7L294.6,253.9L294.1,253.5L292.6,254L292.6,256.3L293.8,257.4L294.2,259.2L294.1,260.5L293.1,269L291.7,267.4L290.9,267.3L292.6,264.2L290.5,262.7L288.9,263L287.9,262.4L286.5,263.3L284.5,262.9L282.9,259.6L281.6,258.8L280.7,257.4L279,255.9L278.3,256.2L277.1,255.5L275.8,254.4L275,254.9L272.8,254.5L272.1,253.2L271.6,253.2L268.9,251.4L268.6,250.5L269.6,250.3L269.5,248.7L270.1,247.6L271.5,247.4L272.6,245.4L273.7,243.8L272.7,243.1L273.3,241.3L272.8,238.4L273.4,237.6L273.1,235L272,233.3L272.5,231.8L273.3,232.1L273.8,231.1L273.3,229.3L273.7,228.9L275,229L277.2,226.8L278.3,226.5L278.4,225.4L279,222.8L280.6,221.4L282.3,221.3L282.6,220.7L284.6,220.9L286.8,219.4L287.9,218.7L289.3,217.2L290.2,217.4L290.9,218.2L290.3,219.2L288.6,219.8L287.8,221.3L286.7,222.2L285.8,223.3L285.4,225.6L284.6,227.4L285.9,227.6L286.2,229L286.7,229.7L286.9,230.9L286.5,232.1L286.6,232.7L287.2,233L287.8,234.1L291.3,233.8L292.8,234.2L294.6,236.8L295.7,236.5L297.6,236.7L299.1,236.3L300.1,236.8L299.5,238.5L298.9,239.6L298.6,241.8L299.1,243.8L299.9,244.7L299.9,245.4L298.6,247L299.5,247.7L300.2,248.8Z","PA":"M273.7,228.9L273.3,229.3L273.8,231.1L273.3,232.1L272.5,231.8L272,233.3L271.2,232.5L270.7,230.8L271.4,230L270.7,229.7L270.3,228.7L269,227.9L267.8,228.1L267.2,229.1L266.1,229.9L265.5,230L265.2,230.7L266.4,232.3L265.7,232.7L265.3,233.2L264,233.4L263.6,231.5L263.3,232L262.4,231.9L261.9,230.6L260.8,230.4L260.2,230L259,230L258.9,230.7L258.6,230.2L258.8,229.6L259.1,229L259,228.4L259.4,228.1L258.9,227.6L258.9,226.4L260,226.1L260.9,227.2L260.8,227.9L261.8,228L262.1,227.7L262.8,228.5L264.1,228.3L265.3,227.5L267,226.9L267.9,225.9L269.4,226.1L269.3,226.4L270.7,226.5L271.9,227.1L272.7,228Z","CR":"M260,226.1L258.9,226.4L258.9,227.6L259.4,228.1L259,228.4L259.1,229L258.8,229.6L258.6,230.2L257.2,229.6L256.7,228.9L257.1,228.4L257,227.7L256.3,226.9L255.3,226.3L254.4,225.9L254.3,225L253.6,224.5L253.7,225.4L253.2,226.1L252.6,225.3L251.8,225L251.4,224.3L251.5,223.4L251.9,222.4L251.2,222L251.9,221.4L252.3,221L254,221.8L254.6,221.4L255.5,221.6L255.9,222.3L256.6,222.5L257.3,221.8L257.9,223.5L258.8,224.8Z","NI":"M257.3,221.8L256.6,222.5L255.9,222.3L255.5,221.6L254.6,221.4L254,221.8L252.3,221L251.9,221.4L251,220.4L249.9,219.1L249.4,218.1L248.4,217.1L247.2,215.7L247.5,215.2L247.9,215.7L248.1,215.5L248.9,215.4L249.3,214.6L249.7,214.6L249.8,213.1L250.5,213L251,213L251.7,212.2L252.4,212.8L252.7,212.5L253.2,212.1L254.2,211.2L254.3,210.6L254.6,210.6L255,209.9L255.3,209.8L255.7,210.3L256.2,210.4L256.8,210L257.5,210L258.5,209.6L258.9,209.2L259.8,209.2L259.5,209.5L259.3,210.2L259.5,211.4L258.8,212.4L258.4,213.7L258.2,215L258.2,215.8L258.2,217.2L257.7,217.5L257.4,218.9L257.5,219.7L256.9,220.5L257,221.3Z","HN":"M259.8,209.2L258.9,209.2L258.5,209.6L257.5,210L256.8,210L256.2,210.4L255.7,210.3L255.3,209.8L255,209.9L254.6,210.6L254.3,210.6L254.2,211.2L253.2,212.1L252.7,212.5L252.4,212.8L251.7,212.2L251,213L250.5,213L249.8,213.1L249.7,214.6L249.3,214.6L248.9,215.4L248.1,215.5L247.7,214.5L247,214.2L247.3,213L246.9,212.7L246.4,212.4L245.2,212.8L245.2,212.4L244.4,211.9L243.9,211.3L243.1,211L243.8,210.2L243.6,209.6L243.9,209L245.2,208.2L246.6,207L246.8,207.1L247.5,206.5L248.2,206.5L248.5,206.8L248.9,206.6L250.1,206.9L251.3,206.8L252.2,206.5L252.5,206.1L253.4,206.3L254,206.5L254.7,206.4L255.2,206.1L256.4,206.6L256.8,206.6L257.6,207.2L258.2,207.9L259.2,208.4Z","SV":"M243.1,211L243.9,211.3L244.4,211.9L245.2,212.4L245.2,212.8L246.4,212.4L246.9,212.7L247.3,213L247,214.2L246.6,215L245.1,214.9L244.1,214.6L243.1,214L241.6,213.8L241,213.2L241.1,212.7L242.1,211.9L242.6,211.6L242.5,211.2Z","GT":"M235.6,210.7L235.7,209.8L236.1,209L235.8,208.4L237.4,205.9L240.8,205.9L241,204.8L240.6,204.7L240.3,204L239.5,203.3L238.6,202.2L239.8,202.2L240,200.5L242.5,200.5L244.9,200.5L244.6,203L244,206.5L244.8,206.5L245.6,207L245.8,206.6L246.6,207L245.2,208.2L243.9,209L243.6,209.6L243.8,210.2L243.1,211L242.5,211.2L242.6,211.6L242.1,211.9L241.1,212.7L241,213.2L239.7,212.6L238,212.6L236.9,211.9Z","BZ":"M244.9,200.5L245,200L245.3,199.9L245.7,200.3L246.9,198.4L247.4,198.4L247.4,198.8L247.9,198.8L247.7,199.7L247.1,201L247.3,201.5L246.9,202.6L247,202.9L246.5,204.5L245.9,205.3L245.4,205.4L244.8,206.5L244,206.5L244.6,203Z","VE":"M317.6,239.6L318,240.5L317,241.7L314,242.8L312,243.3L311.2,244L309.1,243.3L307.1,242.9L306.6,243.2L307.8,244L307.7,246L308,248L310.3,248.3L310.4,248.9L308.5,249.8L308.2,251.1L307.1,251.6L305.1,252.3L304.6,253.3L302.5,253.5L301,251.8L300.2,248.8L299.5,247.7L298.6,247L299.9,245.4L299.9,244.7L299.1,243.8L298.6,241.8L298.9,239.6L299.5,238.5L300.1,236.8L299.1,236.3L297.6,236.7L295.7,236.5L294.6,236.8L292.8,234.2L291.3,233.8L287.8,234.1L287.2,233L286.6,232.7L286.5,232.1L286.9,230.9L286.7,229.7L286.2,229L285.9,227.6L284.6,227.4L285.4,225.6L285.8,223.3L286.7,222.2L287.8,221.3L288.6,219.8L290.3,219.2L290.2,220L288.6,220.3L289.4,221.7L289.2,223.4L288,225.2L288.8,227.6L290,227.4L290.7,225.2L289.9,224.1L290,221.7L293.3,220.5L293.1,219L294.1,218L294.9,220.2L296.8,220.3L298.4,222L298.4,223L300.8,223.1L303.7,222.7L305.1,224.1L307.1,224.5L308.7,223.5L308.8,222.8L312.1,222.6L315.3,222.5L312.9,223.4L313.8,224.9L315.9,225.1L317.8,226.7L318.2,229.1L319.6,229.1L320.6,229.8L318.4,231.6L318.1,232.8L319,233.9L318.3,234.5L316.6,235L316.6,236.4L315.9,237.3Z","GY":"M328.7,249.8L328,249.9L326.6,249.7L325.7,250.5L324.5,251.1L323.6,251.2L323.3,251.8L322,251.6L320.4,250.2L320.2,248.8L319.5,247.2L320,244.6L320.8,243.5L320.2,242L319.3,241.6L319.6,240.2L319,239.5L317.6,239.6L315.9,237.3L316.6,236.4L316.6,235L318.3,234.5L319,233.9L318.1,232.8L318.4,231.6L320.6,229.8L322.3,230.9L323.9,233L323.9,234.6L324.9,234.6L326.3,236.1L327.3,237.2L326.8,240L325.1,240.8L325.3,241.5L324.8,243.1L325.9,245.4L326.8,245.4L327.1,247.1Z","SR":"M334.1,248.6L332.6,247.9L331.3,248.2L330.2,247.9L330,248.8L330.4,249.5L330.1,250.1L328.7,249.8L327.1,247.1L326.8,245.4L325.9,245.4L324.8,243.1L325.3,241.5L325.1,240.8L326.8,240L327.3,237.2L330.5,237.8L330.8,237.3L332.9,237.1L335.8,237.9L334.3,240.6L334.5,242.7L335.5,244.5L335,245.8L334.8,247.3Z","FR":"M341.8,242.9L340.2,245.7L339.4,248L338.3,249.1L337,249.4L336.7,248.5L336.1,248.4L335.3,249.2L334.1,248.6L334.8,247.3L335,245.8L335.5,244.5L334.5,242.7L334.3,240.6L335.8,237.9L336.7,238.2L338.6,239L341.4,241.6ZM494.6,102.5L495.7,103.3L499.1,103.9L498,105.9L497.8,108.1L497.1,108.6L496,108.3L496.1,109.1L494.4,110.8L494.4,112.2L495.6,111.7L496.4,113L496.3,113.9L497.1,115L496.3,116L497,118.3L498.3,118.7L498,120L495.9,121.8L491.1,120.9L487.5,121.9L487.3,123.8L484.5,124.2L481.7,122.8L480.8,123.5L476.3,122.1L475.4,120.9L476.6,119L477.1,112.9L474.7,109.8L472.9,108.2L469.3,107.1L469.1,104.9L472.2,104.2L476.2,105L475.5,101.6L477.7,102.9L483.1,100.5L483.8,98.1L485.9,97.5L486.2,98.5L487.3,98.6L488.4,99.8L490.1,101.2L491.3,100.9L493.3,102.3L493.9,102.6ZM501.3,123.3L502.9,122.1L503.4,124.8L502.6,127.2L501.5,126.5L500.9,124.5Z","EC":"M278.3,256.2L278.6,258.5L277.8,260.6L274.9,263.8L271.7,265L270.2,267.7L269.7,269.8L268.2,271.1L267.1,269.5L266,269.2L264.9,269.4L264.8,268.3L265.5,267.6L265.2,266.3L266.6,263.9L266,262.6L265,264L263.3,262.7L263.9,261.8L263.4,259L264.3,258.5L264.8,256.6L265.8,254.6L265.6,253.3L267.1,252.7L268.9,251.4L271.6,253.2L272.1,253.2L272.8,254.5L275,254.9L275.8,254.4L277.1,255.5Z","PR":"M305.4,198.3L306.7,198.6L307.2,199.2L306.4,200L304.4,200L302.9,200.1L302.9,198.7L303.3,198.3Z","JM":"M275.7,198.4L277.4,198.7L278.7,199.4L279.1,200.3L277.2,200.3L276.4,200.8L274.9,200.3L273.6,199.2L274,198.5L275.1,198.3Z","CU":"M265.4,183.8L267.6,184L269.6,184L271.9,185.1L272.8,186.2L275.3,185.9L276.1,186.6L278,188.5L279.5,189.9L280.4,189.9L281.8,190.5L281.5,191.4L283.5,191.5L285.3,192.8L284.9,193.5L283.1,193.9L281.3,194.1L279.5,193.8L275.7,194.1L277.7,192.4L276.7,191.6L275.1,191.4L274.3,190.5L273.9,188.7L272.4,188.8L270.1,188L269.4,187.3L266.1,186.9L265.2,186.3L266.3,185.5L263.8,185.3L261.7,186.9L260.6,187L260.1,187.7L258.7,188.1L257.7,187.8L259.2,186.8L259.9,185.7L261.2,185L262.7,184.4L264.7,184.1Z","ZW":"M561.6,324.8L560.2,324.5L559.3,324.8L558,324.3L557,324.3L555.4,322.9L553.4,322.4L552.7,320.4L552.8,319.3L551.6,319L548.8,315.6L548.1,313.8L547.5,313.2L546.6,310.7L549.6,311.1L550.4,311.4L551.3,311.3L552.8,309.3L555.2,306.8L556.2,306.5L556.5,305.5L558.1,304.2L560.1,303.8L560.3,304.9L562.5,304.9L563.7,305.5L564.2,306.3L565.4,306.5L566.8,307.5L566.6,311.5L566,313.6L565.7,315.9L566.1,316.9L565.7,318.7L565.3,319L564.5,321.2Z","BW":"M557,324.3L553.2,326.6L550.7,328.9L549.7,331L548.9,332.1L547.4,332.4L546.9,333.9L546.6,334.8L544.9,335.6L542.8,335.4L541.6,334.5L540.5,334.2L539.2,334.9L538.5,336.4L537.2,337.3L535.9,338.7L534,339L533.5,337.9L533.8,336L532.4,333.1L531.7,332.6L532.1,323.5L534.6,323.4L535.1,312.3L537.1,312.2L541.2,311.1L542.1,312.4L543.8,311.2L544.7,311.2L546.2,310.5L546.6,310.7L547.5,313.2L548.1,313.8L548.8,315.6L551.6,319L552.8,319.3L552.7,320.4L553.4,322.4L555.4,322.9Z","NA":"M531.7,332.6L531.2,344.1L528.8,345.7L527.5,345.9L525.9,345.4L524.7,345.1L524.3,343.8L523.4,342.9L522.1,344.5L520.2,342.1L519.3,339.8L518.8,336.8L518.3,334.6L517.5,329.8L517.6,326L517.3,324.3L516.3,323L515,320.5L513.7,316.7L513.2,314.8L511.1,311.7L511,309.4L512.3,308.8L513.8,308.2L515.5,308.3L517.1,309.7L517.5,309.5L528.2,309.4L530,310.9L536.4,311.3L541.2,310L543.4,309.3L545.1,309.5L546.2,310.2L546.2,310.5L544.7,311.2L543.8,311.2L542.1,312.4L541.2,311.1L537.1,312.2L535.1,312.3L534.6,323.4L532.1,323.5Z","SN":"M435.6,213.6L434.6,211.2L433.3,210.1L434.5,209.5L435.8,207.3L436.5,205.7L437.4,204.7L438.7,205L440,204.3L441.5,204.3L442.7,205.2L444.5,206L446,208.3L447.7,210.4L447.8,212.3L448.3,214.1L449.3,215L449.5,216.2L449.4,217.2L449,217.3L447.6,217.1L447.4,217.4L446.8,217.5L444.9,216.8L443.6,216.7L438.7,216.6L438,216.9L437.1,216.8L435.7,217.3L435.3,215L437.7,215L438.3,214.6L438.8,214.6L439.8,213.9L440.9,214.5L442.1,214.6L443.3,213.9L442.7,213L441.9,213.5L441,213.5L440,212.7L439.2,212.8L438.5,213.5Z","ML":"M449.4,217.2L449.5,216.2L449.3,215L448.3,214.1L447.8,212.3L447.7,210.4L448.6,209.9L449.1,208L450,208L451.8,208.8L453.3,208.2L454.3,208.4L454.7,207.7L465.3,207.7L465.9,205.5L465.5,205.1L464.3,191.7L463.2,178.2L467.2,178.2L476,185L484.8,191.8L485.4,193.2L487.1,194.1L488.3,194.6L488.3,196.6L491.2,196.3L491.3,203.5L489.8,205.5L489.6,207.5L487.3,208L483.7,208.2L482.7,209.3L481,209.4L479.3,209.5L478.6,208.9L477.2,209.3L474.7,210.6L474.2,211.6L472.1,213L471.8,213.8L470.6,214.4L469.4,214L468.6,214.7L468.2,216.9L466.1,219.4L466.2,220.5L465.4,221.8L465.6,223.6L464.5,224.1L463.9,224.4L463.5,223.1L462.7,223.5L462.2,223.4L461.8,224.3L459.7,224.3L459,223.8L458.6,224.1L457.8,223.2L458,222.3L457.6,221.9L457.1,222.2L457.2,221.2L457.7,220.4L456.6,219.1L456.3,218.3L455.7,217.6L455.2,217.5L454.6,217.9L453.7,218.4L453,219L451.8,218.8L451.1,218L450.7,217.9L450,218.3L449.5,218.3Z","MR":"M435.3,190.6L435.9,189.5L446.1,189.6L445.7,185.1L446.4,183.5L448.9,183.2L449,175.2L457.5,175.4L457.6,170.6L467.2,178.2L463.2,178.2L464.3,191.7L465.5,205.1L465.9,205.5L465.3,207.7L454.7,207.7L454.3,208.4L453.3,208.2L451.8,208.8L450,208L449.1,208L448.6,209.9L447.7,210.4L446,208.3L444.5,206L442.7,205.2L441.5,204.3L440,204.3L438.7,205L437.4,204.7L436.5,205.7L436.3,204L437,202.5L437.4,199.6L437.2,196.5L436.9,194.9L437.3,193.4L436.6,191.9Z","BJ":"M487.2,236.3L485,236.7L484.3,234.6L484.4,227.4L483.9,226.8L483.8,225.3L482.9,224.2L482.1,223.3L482.4,221.7L483.3,221.3L483.8,219.9L485.1,219.7L485.7,218.7L486.6,217.8L487.6,217.8L489.6,219.6L489.5,220.6L490.1,222.5L489.6,223.7L489.9,224.5L488.6,226.5L487.8,227.4L487.3,229.4L487.3,231.3Z","NE":"M518.8,184.8L519.5,189.6L520.6,190.4L520.6,191.4L521.7,192.5L521.2,193.8L520.3,200.1L520.3,204.2L517,207.1L515.9,211.2L517,212.3L517,214.3L518.7,214.4L518.5,215.9L517.8,216.1L517.7,217L517.2,217.1L515.3,213.7L514.7,213.6L512.7,215.3L510.6,214.4L509.2,214.2L508.4,214.7L506.9,214.6L505.3,215.9L503.9,216L500.7,214.4L499.5,215.1L498.1,215.1L497.1,213.9L494.4,212.7L491.6,213.1L490.9,213.8L490.5,215.6L489.8,216.8L489.6,219.6L487.6,217.8L486.6,217.8L485.7,218.7L485.8,216.6L482.7,215.9L482.6,214.4L481.1,212.4L480.8,211L481,209.4L482.7,209.3L483.7,208.2L487.3,208L489.6,207.5L489.8,205.5L491.3,203.5L491.2,196.3L494.9,194.9L502.4,188.8L511.3,182.9L515.4,184.2L517,185.9Z","NG":"M487.2,236.3L487.3,231.3L487.3,229.4L487.8,227.4L488.6,226.5L489.9,224.5L489.6,223.7L490.1,222.5L489.5,220.6L489.6,219.6L489.8,216.8L490.5,215.6L490.9,213.8L491.6,213.1L494.4,212.7L497.1,213.9L498.1,215.1L499.5,215.1L500.7,214.4L503.9,216L505.3,215.9L506.9,214.6L508.4,214.7L509.2,214.2L510.6,214.4L512.7,215.3L514.7,213.6L515.3,213.7L517.2,217.1L517.7,217L518.8,218.3L518.5,218.8L518.3,219.9L516.1,222.3L515.4,224.2L515.1,225.9L514.5,226.5L514,228.7L512.6,230L512.2,231.6L511.6,232.8L511.4,234.1L509.5,235.1L508,233.9L507,233.9L505.4,235.7L504.7,235.8L503.4,238.8L502.7,240.9L500,242.1L498.9,241.9L497.9,242.6L495.8,242.5L494.3,240.6L493.5,238.3L491.6,236.3L489.5,236.3Z","CM":"M518.5,215.9L519.6,217.9L519.8,219.9L519.7,222L521.2,224.8L519.7,224.8L519,225L517.8,224.7L517.2,226.1L518.8,227.9L520,228.5L520.3,229.8L521.2,231.9L520.8,232.7L519.5,235.9L518.8,236.4L518.6,238.8L518.9,240.1L518.7,241.1L520,242.7L520.2,243.8L521.2,245.4L522.4,246.4L522.6,247.8L522.8,248.7L522.7,250.4L520.5,249.6L518.4,248.8L515,248.7L514.7,248.5L513.1,248.9L511.4,248.5L510.2,248.7L505.8,248.6L506.2,246.2L505.2,244.2L503.9,243.6L503.4,242.2L502.7,241.8L502.7,240.9L503.4,238.8L504.7,235.8L505.4,235.7L507,233.9L508,233.9L509.5,235.1L511.4,234.1L511.6,232.8L512.2,231.6L512.6,230L514,228.7L514.5,226.5L515.1,225.9L515.4,224.2L516.1,222.3L518.3,219.9L518.5,218.8L518.8,218.3L517.7,217L517.8,216.1Z","TG":"M482.4,221.7L482.1,223.3L482.9,224.2L483.8,225.3L483.9,226.8L484.4,227.4L484.3,234.6L485,236.7L482.8,237.4L482.2,236.3L481.5,234.3L481.3,232.8L481.9,230L481.2,228.8L481,226.4L481,224.1L479.9,222.5L480.1,221.6Z","GH":"M480.1,221.6L479.9,222.5L481,224.1L481,226.4L481.2,228.8L481.9,230L481.3,232.8L481.5,234.3L482.2,236.3L482.8,237.4L478.6,239.2L477.2,240.2L474.7,241.1L472.4,240.3L472.5,239L471.3,236.4L472,232.9L473.2,230.3L472.5,225.8L472.1,223.5L472.2,221.8L476.8,221.6L478,221.8L478.8,221.3Z","CI":"M458.6,224.1L459,223.8L459.7,224.3L461.8,224.3L462.2,223.4L462.7,223.5L463.5,223.1L463.9,224.4L464.5,224.1L465.6,223.6L466.8,224.3L467.3,225.3L468.5,225.9L469.4,225.2L470.6,225.1L472.5,225.8L473.2,230.3L472,232.9L471.3,236.4L472.5,239L472.4,240.3L471.1,240.3L469.3,239.7L467.6,239.7L464.4,240.3L462.5,241.1L459.9,242.3L459.4,242.2L459.6,239.7L459.8,239.3L459.8,238L458.6,236.7L457.8,236.5L457,235.7L457.6,234.3L457.3,232.8L457.5,231.9L457.9,231.9L458.1,230.6L457.9,230L458.1,229.5L459.1,229.2L458.5,226.7L457.9,225.4L458.1,224.3Z","GN":"M443.6,216.7L444.9,216.8L446.8,217.5L447.4,217.4L447.6,217.1L449,217.3L449.4,217.2L449.5,218.3L450,218.3L450.7,217.9L451.1,218L451.8,218.8L453,219L453.7,218.4L454.6,217.9L455.2,217.5L455.7,217.6L456.3,218.3L456.6,219.1L457.7,220.4L457.2,221.2L457.1,222.2L457.6,221.9L458,222.3L457.8,223.2L458.6,224.1L458.1,224.3L457.9,225.4L458.5,226.7L459.1,229.2L458.1,229.5L457.9,230L458.1,230.6L457.9,231.9L457.5,231.9L456.7,231.8L456.2,233.1L455.4,233.1L454.9,232.4L455.1,231.2L454,229.3L453.3,229.6L452.7,229.7L452,229.9L452,228.7L451.6,227.9L451.7,227L451.1,225.7L450.4,224.6L448.2,224.6L447.6,225.2L446.9,225.3L446.4,225.9L446.1,226.8L444.7,228.1L443.5,226.3L442.5,225.1L441.8,224.7L441.2,224.1L440.9,222.7L440.5,222L439.7,221.5L440.9,220L441.7,220.1L442.4,219.5L443,219.5L443.5,219.1L443.2,218.1L443.5,217.8Z","GW":"M435.7,217.3L437.1,216.8L438,216.9L438.7,216.6L443.6,216.7L443.5,217.8L443.2,218.1L443.5,219.1L443,219.5L442.4,219.5L441.7,220.1L440.9,220L439.7,221.5L438.3,220.2L437.2,220L436.6,219.1L436.6,218.7L435.8,218Z","LR":"M457.5,231.9L457.3,232.8L457.6,234.3L457,235.7L457.8,236.5L458.6,236.7L459.8,238L459.8,239.3L459.6,239.7L459.4,242.2L458.7,242.2L455.9,240.8L453.5,238.4L451.2,236.7L449.4,234.7L450.1,233.7L450.2,232.8L451.5,231.1L452.7,229.7L453.3,229.6L454,229.3L455.1,231.2L454.9,232.4L455.4,233.1L456.2,233.1L456.7,231.8Z","SL":"M444.7,228.1L446.1,226.8L446.4,225.9L446.9,225.3L447.6,225.2L448.2,224.6L450.4,224.6L451.1,225.7L451.7,227L451.6,227.9L452,228.7L452,229.9L452.7,229.7L451.5,231.1L450.2,232.8L450.1,233.7L449.4,234.7L448.7,234.5L446.8,233.2L445.4,231.6L445,230.4Z","BF":"M465.6,223.6L465.4,221.8L466.2,220.5L466.1,219.4L468.2,216.9L468.6,214.7L469.4,214L470.6,214.4L471.8,213.8L472.1,213L474.2,211.6L474.7,210.6L477.2,209.3L478.6,208.9L479.3,209.5L481,209.4L480.8,211L481.1,212.4L482.6,214.4L482.7,215.9L485.8,216.6L485.7,218.7L485.1,219.7L483.8,219.9L483.3,221.3L482.4,221.7L480.1,221.6L478.8,221.3L478,221.8L476.8,221.6L472.2,221.8L472.1,223.5L472.5,225.8L470.6,225.1L469.4,225.2L468.5,225.9L467.3,225.3L466.8,224.3Z","CF":"M553.2,239.5L552.3,239.8L550.6,239.8L548.6,239.4L547.6,239.7L547.2,240.5L546.3,240.6L545.3,239.9L542.3,241.4L541.1,241.1L540.7,241.4L539.9,243.2L537.9,242.6L536,242.3L534.3,241.2L532,240.1L530.6,241.1L529.6,242.7L529.4,244.9L527.6,244.7L525.8,244.2L524.2,245.8L522.8,248.7L522.6,247.8L522.4,246.4L521.2,245.4L520.2,243.8L520,242.7L518.7,241.1L518.9,240.1L518.6,238.8L518.8,236.4L519.5,235.9L520.8,232.7L523,232.5L523.5,231.7L523.9,231.8L524.6,232.5L527.9,231.3L529.1,230.1L530.4,229L530.2,227.9L530.9,227.6L533.5,227.8L536,226.4L537.8,223L539.2,221.7L540.9,221.2L541.2,222.5L542.7,224.5L542.8,225.7L542.4,227L542.6,228L543.5,228.9L545.6,230.2L547,231.5L547.1,232.5L548.9,234.1L550,235.4L550.7,237.3L552.7,238.5Z","CG":"M529.4,244.9L529.2,246.7L528.4,248.4L527.9,250.3L527.6,253.1L527.7,254.8L527.3,255.9L527.2,257L526.9,258L525.1,259.5L523.9,261.1L522.7,264.1L522.8,266.7L522.1,267.7L520.6,269.2L519,271.1L518,270.6L517.8,269.7L516.4,269.7L515.4,270.8L514.7,270.5L513.7,269.5L512.9,270L511.9,271.3L509.7,268L511.7,266.3L510.7,264.3L511.6,263.5L513.4,263.1L513.7,261.8L515.1,263.2L517.4,263.4L518.3,261.9L518.6,259.8L518.3,257.4L517.1,255.6L518.2,252L517.5,251.4L515.5,251.7L514.8,250.1L515,248.7L518.4,248.8L520.5,249.6L522.7,250.4L522.8,248.7L524.2,245.8L525.8,244.2L527.6,244.7Z","GA":"M510.2,248.7L511.4,248.5L513.1,248.9L514.7,248.5L515,248.7L514.8,250.1L515.5,251.7L517.5,251.4L518.2,252L517.1,255.6L518.3,257.4L518.6,259.8L518.3,261.9L517.4,263.4L515.1,263.2L513.7,261.8L513.4,263.1L511.6,263.5L510.7,264.3L511.7,266.3L509.7,268L506.9,264.9L505.2,262.4L503.5,259.2L503.6,258.1L504.2,257.1L504.9,254.9L505.4,252.6L506.3,252.4L510.2,252.4Z","GQ":"M505.8,248.6L510.2,248.7L510.2,252.4L506.3,252.4L505.4,252.6L504.9,252.1Z","ZM":"M562,281.6L563.1,282.3L564.2,282.9L565.9,283.4L567.3,284.3L568.6,285.7L569.2,288.3L568.7,289.2L568.1,291.7L568.5,294.3L567.6,295.3L566.7,298.2L568.1,299L560,301.6L560.1,303.8L558.1,304.2L556.5,305.5L556.2,306.5L555.2,306.8L552.8,309.3L551.3,311.3L550.4,311.4L549.6,311.1L546.6,310.7L546.2,310.5L546.2,310.2L545.1,309.5L543.4,309.3L541.2,310L539.6,308.1L537.9,305.6L538.3,295.7L543.8,295.7L543.6,294.7L544,293.5L543.6,292L543.9,290.5L543.7,289.6L544.6,289.6L544.7,290.6L545.9,290.5L547.6,290.8L548.5,292.2L550.6,292.7L552.3,291.7L552.8,293.3L554.8,293.7L555.8,295.1L556.8,296.8L558.8,296.8L558.7,293.5L558,294L556.2,292.8L555.5,292.3L555.9,289.1L556.4,285.5L555.9,284.1L556.7,282.1L557.4,281.8L561,281.2Z","MW":"M567.3,284.3L569.9,284.9L570.4,285.7L571.3,287.2L571.9,291.4L571.1,293.8L571.7,297.8L572.6,297.8L573.6,298.8L574.6,301L574.6,305L573.4,305.7L572.5,307.8L570.9,305.9L570.8,303.7L571.4,302.3L571.3,301L570.3,300.2L569.6,300.5L568.1,299L566.7,298.2L567.6,295.3L568.5,294.3L568.1,291.7L568.7,289.2L569.2,288.3L568.6,285.7Z","MZ":"M571.9,291.4L573.9,291.2L577.1,292L577.8,291.6L579.7,291.6L580.7,290.6L582.3,290.7L585.2,289.5L587.4,287.7L587.8,289.1L587.5,292.2L587.8,294.9L587.7,299.7L588,301.3L587.1,303.5L586,305.6L584.2,307.6L581.7,308.7L578.7,310.2L575.5,313.6L574.5,314.2L572.5,316.4L571.4,317.1L571.1,319.3L572.2,321.7L572.6,323.5L572.5,324.4L573,324.3L572.7,327.3L572.2,328.8L572.8,329.3L572.3,330.6L571.1,331.7L568.9,332.8L565.7,334.4L564.5,335.6L564.6,336.9L565.2,337.1L564.9,338.8L562.9,338.7L562.8,337.4L562.5,336L562.4,334.8L563.1,331.4L562.5,329.2L561.6,324.8L564.5,321.2L565.3,319L565.7,318.7L566.1,316.9L565.7,315.9L566,313.6L566.6,311.5L566.8,307.5L565.4,306.5L564.2,306.3L563.7,305.5L562.5,304.9L560.3,304.9L560.1,303.8L560,301.6L568.1,299L569.6,300.5L570.3,300.2L571.3,301L571.4,302.3L570.8,303.7L570.9,305.9L572.5,307.8L573.4,305.7L574.6,305L574.6,301L573.6,298.8L572.6,297.8L571.7,297.8L571.1,293.8Z","SZ":"M562.9,338.7L562.3,340.1L560.8,340.5L559.4,338.8L559.4,337.7L560.2,336.5L560.5,335.6L561.3,335.4L562.5,336L562.8,337.4Z","AO":"M514.7,270.5L513.8,271.2L513.3,272L513.2,273.3L512.6,273.6L511.9,271.3L512.9,270L513.7,269.5ZM512.9,274.6L514,274.2L514.8,274.3L515.7,273.9L523.6,273.9L524.3,276.2L525,278.1L525.6,279.1L526.6,280.7L528.4,280.5L529.3,280L530.8,280.5L531.2,279.7L531.8,277.9L533.5,277.8L533.7,277.2L535,277.2L534.8,278.3L538,278.3L538,280.3L538.6,281.4L538.1,283.3L538.3,285.2L539.2,286.4L539,290.1L539.6,289.8L540.8,289.9L542.4,289.4L543.7,289.6L543.9,290.5L543.6,292L544,293.5L543.6,294.7L543.8,295.7L538.3,295.7L537.9,305.6L539.6,308.1L541.2,310L536.4,311.3L530,310.9L528.2,309.4L517.5,309.5L517.1,309.7L515.5,308.3L513.8,308.2L512.3,308.8L511,309.4L510.8,307.4L511.2,304.7L512.1,301.8L512.3,300.5L513.2,297.7L513.8,296.4L515.4,294.4L516.3,293L516.6,290.7L516.4,289L515.7,287.9L515,286L514.3,284.1L514.5,283.5L515.3,282.2L514.5,279.2L514,277.2L512.7,275.2Z","BI":"M561.5,263.2L561.7,264.4L562.3,265.1L562.3,266.1L561.6,266.8L560.5,268.4L559.6,269.5L558.5,269.7L558.3,265.9L557.7,264.5L559.3,264.8L560.1,263Z","IL":"M570.7,154.1L570.4,155.1L569.4,154.6L569.1,156.7L569.8,157L569.1,157.5L569.1,158.3L570.3,157.9L570.4,159.1L569.6,164.1L569.3,163.3L567.5,158.7L568.1,157.7L567.9,157.5L568.5,156.1L568.7,153.7L569,152.9L569.1,152.9L570,152.9L570.1,152.3L570.8,152.3L571,153.6L570.7,154.1Z","LB":"M570.8,152.3L570.1,152.3L570,152.9L569.1,152.9L569.8,150.3L570.8,148.2L570.8,148L572,148.2L572.5,149.4L571.3,150.6Z","MG":"M611.6,294.4L612.3,295.7L612.8,297.7L613.1,301.5L613.7,302.9L613.3,304.4L612.8,305.3L612,303.5L611.4,304.4L611.8,306.7L611.5,308L610.7,308.8L610.3,311.4L609,315L607.4,319.3L605.3,325.2L603.9,329.5L602.4,333.1L600.2,333.9L597.8,335.2L596.4,334.4L594.4,333.3L593.8,331.6L593.9,328.9L593.2,326.4L593.1,324.2L593.8,321.9L595,321.4L595.1,320.3L596.5,318L596.9,316L596.4,314.5L596,312.6L596,309.7L597,308L597.5,306L598.8,305.9L600.3,305.2L601.4,304.7L602.5,304.6L604.1,302.9L606.4,301L607.3,299.4L607,298.1L608.1,298.4L609.7,296.3L609.8,294.4L610.8,293Z","PS":"M570.3,157.9L569.1,158.3L569.1,157.5L569.8,157L569.1,156.7L569.4,154.6L570.4,155.1L570.6,157Z","GM":"M435.6,213.6L438.5,213.5L439.2,212.8L440,212.7L441,213.5L441.9,213.5L442.7,213L443.3,213.9L442.1,214.6L440.9,214.5L439.8,213.9L438.8,214.6L438.3,214.6L437.7,215L435.3,215Z","TN":"M504.3,161.6L503,156L501.5,154.7L501.4,154L499.3,152.1L499,149.7L500.5,148L501.1,145.4L500.6,142.5L501.1,140.9L503.7,139.6L505.5,140L505.5,141.6L507.6,140.4L507.8,141L506.6,142.6L506.6,144L507.5,144.8L507.2,147.5L505.6,149L506.2,150.7L507.5,150.8L508.2,152.3L509.1,152.7L509.1,155.1L507.9,156L507.1,157L505.4,158.2L505.7,159.5L505.5,160.8Z","DZ":"M457.6,170.6L457.6,170L457.6,169.8L457.7,166.1L461.9,163.8L464.5,163.4L466.6,162.5L467.6,161L470.6,159.7L470.7,157.4L472.2,157.1L473.3,156L476.7,155.5L477.1,154.3L476.5,153.6L475.6,150.3L475.5,148.4L474.5,146.4L477,144.7L479.7,144.2L481.3,142.9L483.7,141.9L487.9,141.4L492,141.1L493.3,141.6L495.6,140.4L498.3,140.3L499.4,141.1L501.1,140.9L500.6,142.5L501.1,145.4L500.5,148L499,149.7L499.3,152.1L501.4,154L501.5,154.7L503,156L504.3,161.6L505.2,164.3L505.3,165.8L504.9,168.3L505.2,169.7L504.9,171.4L505.1,173.4L504.1,174.7L505.7,177L505.8,178.3L506.8,180L508,179.5L510.1,180.9L511.3,182.9L502.4,188.8L494.9,194.9L491.2,196.3L488.3,196.6L488.3,194.6L487.1,194.1L485.4,193.2L484.8,191.8L476,185L467.2,178.2Z","JO":"M570.4,155.1L570.7,154.1L573.7,155.3L578.3,152L579.7,155.8L579.3,156.3L574.4,157.8L577.2,160.9L576.4,161.5L576.1,162.5L574.2,162.9L573.7,164.1L572.6,165L569.7,164.5L569.6,164.1L570.4,159.1L570.3,157.9L570.6,157Z","AE":"M614.2,180.5L614.7,180.3L614.9,181.2L616.9,180.7L619,180.8L620.6,180.9L622.2,178.7L623.9,176.7L625.3,174.8L625.9,175.9L626.5,178.3L625.2,178.4L625.2,180.4L625.7,180.8L624.6,181.4L624.8,182.7L624.1,184L624.2,185.3L623.7,185.9L615.7,184.3L614.4,181.2Z","QA":"M612.1,178.9L611.7,176.6L612.2,175L612.9,174.6L613.8,175.6L614,177.4L613.6,179.3L612.9,179.5Z","KW":"M602.9,162.6L603.6,164L603.5,164.7L604.6,167L602.8,167.1L602,165.6L599.6,165.3L601.2,162.3Z","IQ":"M579.7,155.8L578.3,152L583.5,148.7L584,145L583.5,142.7L584.8,141.9L585.8,140L586.8,139.5L589.8,139.9L590.7,140.7L591.9,140.2L594,143.9L595.8,144.8L596.2,146.6L595.1,147.7L594.8,150.1L597,153.1L600.3,154.8L601.9,157.2L601.8,159.4L602.6,159.4L602.9,161.1L604.5,162.7L602.9,162.6L601.2,162.3L599.6,165.3L594.8,165.1L586.9,158.8L582.9,156.6Z","OM":"M624.2,185.3L624.1,184L624.8,182.7L624.6,181.4L625.7,180.8L625.2,180.4L625.2,178.4L626.5,178.3L627.9,180.5L629.5,181.6L631.5,182L633.1,182.6L634.5,184.4L635.3,185.4L636.3,185.8L636.3,186.5L635.6,188.3L635.3,189.2L634.3,190.2L633.5,192.3L632.3,192.2L631.8,192.9L631.5,194.5L632.1,196.6L631.8,197L630.6,197L629.1,198.1L629,199.6L628.4,200.3L626.8,200.3L625.8,201.1L625.9,202.3L624.7,203.2L623.2,202.9L621.5,203.9L620.3,204.1L619.3,201.9L616.8,196.8L624.5,193.7L625.6,187.5ZM625.9,175.9L625.3,174.8L625.9,173.8L626.3,174L626.2,175.3Z","VU":"M922.3,305L923.6,306.8L922.6,307.2L922,305.8ZM921.3,304.3L921.1,303.4L921.6,301.1L922.6,302L922.6,304.5L921.9,304.1Z","KH":"M752.7,218L751.7,214.2L753.1,211.6L756.4,211L759,211.5L761.3,212.7L762.2,210.6L764.7,211.7L765.6,213.8L765.7,217.5L761.5,219.9L762.8,221.8L760,222L757.8,223.2L755.6,222.8L754.3,221.2Z","TH":"M759,211.5L756.4,211L753.1,211.6L751.7,214.2L752.7,218L750.2,216.5L747.9,216.6L748,214.2L745.7,214.2L745.8,217.6L744.8,222.1L744.2,224.9L744.5,227.1L746.3,227.2L747.6,230L748.2,232.7L749.8,234.5L751.4,234.8L752.9,236.4L752.1,237.7L750.3,238.1L750.1,236.5L747.8,235.1L747.4,235.7L746.3,234.5L745.7,233L744.2,231.2L742.8,229.8L742.5,231.6L741.9,229.9L742,227.9L742.6,225L743.6,221.8L744.8,218.9L743.5,216L743.4,214.6L742.9,212.9L740.8,210.4L740,208.8L740.9,208.3L741.5,205.6L740.2,203.5L738.2,201.3L736.5,198.5L737.5,198L738.2,194.6L740,194.5L741.4,193.1L742.7,192.4L744,193.3L744.5,195.2L746.3,195.4L746.2,198.6L746.6,201.4L749.1,199.6L750,200.1L751.5,200L751.9,198.9L753.9,199.2L756.3,201.7L756.9,204.7L759.4,207.5L759.7,210.1Z","LA":"M764.7,211.7L762.2,210.6L761.3,212.7L759,211.5L759.7,210.1L759.4,207.5L756.9,204.7L756.3,201.7L753.9,199.2L751.9,198.9L751.5,200L750,200.1L749.1,199.6L746.6,201.4L746.2,198.6L746.3,195.4L744.5,195.2L744,193.3L742.7,192.4L743.1,191.2L745,189.2L745.4,189.9L746.8,190L745.7,186.5L747,186L749,188.5L750.7,191.3L753.9,191.3L755.4,194L753.8,194.9L753.3,196L756.7,197.8L759.5,201.5L761.5,204.2L763.8,206.4L764.8,208.6Z","MM":"M742.7,192.4L741.4,193.1L740,194.5L738.2,194.6L737.5,198L736.5,198.5L738.2,201.3L740.2,203.5L741.5,205.6L740.9,208.3L740,208.8L740.8,210.4L742.9,212.9L743.4,214.6L743.5,216L744.8,218.9L743.6,221.8L742.6,225L742.1,222.6L742.8,220.3L741.7,218.4L741.6,215.1L740.3,213.4L739,209.7L738.1,205.8L736.6,203.2L735.1,204.8L732.3,207L730.8,206.7L729.1,206L729.5,202.2L728.6,199.2L726,195.7L726.1,194.5L724.5,194.1L722.3,191.6L721.7,189.1L722.7,189.6L722.4,187.3L723.6,186.6L723.1,185.3L723.5,184.2L723,181L725.2,181.7L725.8,179.1L725.7,177.6L726.6,175L726.1,173.2L729,171.1L731,171.6L730.3,169.7L731.1,169.1L730.7,167.9L732.1,167.7L733.4,169.5L734.7,170.3L735.3,172.7L735.7,175.2L733.8,177.8L734.2,181.5L736.9,181L738.1,183.9L739.8,184.5L739.5,187.1L741.7,188.3L742.9,188.8L744.7,187.9L745,189.2L743.1,191.2Z","VN":"M757.8,223.2L760,222L762.8,221.8L761.5,219.9L765.7,217.5L765.6,213.8L764.7,211.7L764.8,208.6L763.8,206.4L761.5,204.2L759.5,201.5L756.7,197.8L753.3,196L753.8,194.9L755.4,194L753.9,191.3L750.7,191.3L749,188.5L747,186L748.3,185.2L750.3,185.3L752.8,184.9L754.7,183.2L756.2,184.4L758.7,185L758.6,186.8L760.1,188L762.9,188.9L759.9,191.5L758.2,194.5L758,196.6L760.6,199.9L763.6,204L766.3,205.9L768.3,208.4L770.2,214.1L770.4,219.6L768.4,221.6L765.6,223.6L763.6,226.2L760.5,229.1L759.4,227.1L760,225Z","KP":"M799.7,124.6L799.7,124.6L799.7,124.6ZM799.1,124L799.7,124.6L798.6,124.4L798.1,125.4L797.9,126.5L799,128.7L798,129.4L797.9,129.9L797.3,130.8L795.9,131.3L795.2,132.2L795.7,133.5L795.6,133.8L796.8,134.4L798.8,135.7L798.8,136.5L797.8,136.7L796.1,136.8L795.7,138.2L794.5,138.1L794.5,138.4L793.1,137.8L793,138.4L792.4,138.6L792,138.1L791.3,137.8L790.4,137.3L790.5,135.9L791,135.5L790.5,135L790.4,133.3L790,132.8L788.4,132.5L786.9,131.6L788.1,129.7L790,128L790.7,125.8L792.3,126.8L794.5,126.9L793.3,125.3L796.5,123.9L796.6,122.2Z","KR":"M794.5,138.4L794.5,138.1L795.7,138.2L796.1,136.8L797.8,136.7L798.8,136.5L798.8,135.7L802.5,139.4L803.9,141.4L805.4,145L805.1,146.7L803.1,147.3L801.5,148.6L799.4,148.8L798.5,147.1L798,144.8L795.7,141.6L797.3,141Z","MN":"M686.7,103L688.9,102.5L692.3,99.9L695.3,98.5L697.7,99.4L700.2,99.5L702.3,100.9L704.7,101L708.5,101.7L709.8,99.6L708,97.9L709,94.8L712.2,96L714.4,96.4L717.6,97.1L719.1,99.4L723,100.6L725,100.1L727.7,99.7L730.3,100.1L733.3,101.5L735.5,103.1L737.6,103L740.9,103.5L742.6,102.8L745.5,102.3L747.8,100.2L749.4,100.5L751.2,101.5L753.8,101.2L753.9,103.5L753.8,106.5L755,107.7L756.2,107.4L758.8,107.8L760,106.7L762.4,107.7L765.7,109.8L766,110.9L763.9,110.5L760.6,110.9L759.4,111.8L758.6,113.8L755.5,115L753.8,116.6L751.1,116L749.6,115.7L749.2,117.7L750.5,118.9L751.3,119.9L750.1,120.9L749,122.6L746.6,123.6L743,123.8L739.5,124.8L737.3,126.5L735.9,125.5L732.9,125.5L728.6,123.7L726,123.2L722.9,123.6L717.6,122.9L714.9,123L712.8,121.2L710.7,118.4L709.1,118L705.4,116.1L702,115.7L699,115.2L697.6,113.8L697.2,110.3L694.6,107.8L690.7,106.7L688.1,105.1Z","IN":"M730.7,167.9L731.1,169.1L730.3,169.7L731,171.6L729,171.1L726.1,173.2L726.6,175L725.7,177.6L725.8,179.1L725.2,181.7L723,181L723.5,184.2L723.1,185.3L723.6,186.6L722.4,187.3L720.2,182.4L719.5,182.4L719.4,184.4L717.7,182.8L718.2,181L719.3,180.8L720,178.2L718.4,177.7L716,177.7L713.4,177.3L712.8,175.1L711.5,174.9L709.2,173.6L708.7,175.7L710.9,177.4L709.5,178.5L709.1,179.7L710.9,180.5L710.7,182.4L712,184.7L712.9,187.3L712.7,188.4L710.9,188.4L707.8,189L708.3,191.4L707.1,193.2L703.6,195.3L701.2,199L699.4,200.9L697,203L697.2,204.4L696,205.2L693.7,206.3L692.5,206.4L691.9,208.8L692.8,212.8L693.2,215.4L692.3,218.4L692.7,223.6L691.3,223.8L690.3,226.1L691.1,227.2L688.7,228.1L688,230.2L686.9,231L684.3,228.2L682.8,223.8L681.5,220.7L680.5,219.2L678.9,216.2L677.9,212.4L677.3,210.4L674.5,206.2L672.8,200.1L671.6,196.2L671.1,192.4L670.2,189.5L666.7,191.3L664.8,191L660.9,187.2L662,186.1L661.1,184.8L657.7,182.2L659.1,180.1L664.9,180.1L663.9,177.4L662.2,175.9L661.6,173.5L659.7,172.1L662,168.8L665,169L667.2,165.8L668.2,162.6L670.1,159.5L669.6,157.2L671.4,155.4L669.1,153.9L667.7,151.8L666.3,149.1L667.2,147.7L671.2,148.5L673.9,148L675.7,145.4L679.3,149L679.6,151.6L681,153.2L681.3,154.8L679.3,154.4L680.8,157.8L683.7,159.8L687.7,161.9L686.4,163.4L685.9,166.3L688.7,167.5L691.4,169L695.1,170.7L698.7,171.1L700.5,172.7L702.5,173L705.8,173.8L707.9,173.7L708,172.5L707.3,170.5L707.2,169.1L708.6,168.5L709.3,170.9L709.5,171.6L712.1,172.8L713.6,172.3L715.9,172.5L718,172.4L717.7,170.5L716.5,169.5L718.5,169.1L720.3,166.8L722.8,164.8L725.2,165.5L726.7,164.2L728.3,166.2L727.8,167.5Z","BD":"M722.4,187.3L722.7,189.6L721.7,189.1L722.3,191.6L721.3,190L720.9,188.4L720.1,186.9L718.7,185.1L716.3,185L716.8,186.2L716.2,188L715,187.3L714.7,187.9L713.9,187.6L712.9,187.3L712,184.7L710.7,182.4L710.9,180.5L709.1,179.7L709.5,178.5L710.9,177.4L708.7,175.7L709.2,173.6L711.5,174.9L712.8,175.1L713.4,177.3L716,177.7L718.4,177.7L720,178.2L719.3,180.8L718.2,181L717.7,182.8L719.4,184.4L719.5,182.4L720.2,182.4Z","BT":"M716.5,169.5L717.7,170.5L718,172.4L715.9,172.5L713.6,172.3L712.1,172.8L709.5,171.6L709.3,170.9L710.6,168.6L711.8,167.8L713.8,168.6L715.2,168.6Z","NP":"M707.2,169.1L707.3,170.5L708,172.5L707.9,173.7L705.8,173.8L702.5,173L700.5,172.7L698.7,171.1L695.1,170.7L691.4,169L688.7,167.5L685.9,166.3L686.4,163.4L687.7,161.9L688.6,161.2L690.9,162.2L693.9,164.2L695.4,164.6L696.6,166.1L698.7,166.8L701.1,168.1L704.1,168.8Z","PK":"M675.7,145.4L673.9,148L671.2,148.5L667.2,147.7L666.3,149.1L667.7,151.8L669.1,153.9L671.4,155.4L669.6,157.2L670.1,159.5L668.2,162.6L667.2,165.8L665,169L662,168.8L659.7,172.1L661.6,173.5L662.2,175.9L663.9,177.4L664.9,180.1L659.1,180.1L657.7,182.2L655.7,181.4L654.6,179.2L652.2,176.8L647.5,177.4L643.3,177.4L639.7,177.9L640.2,174.2L643.7,172.6L643.3,171.2L642,170.7L641.6,167.9L638.9,166.6L637.6,164.7L636.1,163.1L640.6,164.6L643.1,164.2L644.7,164.6L645.1,163.9L646.9,164.2L650.1,162.9L649.7,160.2L650.8,158.5L652.7,158.5L652.8,157.6L654.7,157.2L655.7,157.5L656.5,156.6L656,154.7L656.8,152.8L658.2,152L656.8,150L659.2,150.1L659.7,149L659.3,147.8L660.3,146.5L659.7,144.9L658.8,143.6L660,142.2L662.5,141.6L665.3,141.2L666.4,140.7L667.8,140.3L670,141.8L671.3,144.1Z","AF":"M646.1,139.6L647.5,139.6L649.5,140.3L650.3,140.6L651.9,139.7L652.9,140.2L653.4,138.8L654.9,138.9L655.2,138.4L655.1,137.2L656,136.1L657.5,136.8L657.4,137.8L658.2,137.9L658.6,140.5L659.8,141.5L660.5,140.9L661.6,140.6L662.8,139.2L664.6,139.4L667.1,139.4L667.8,140.3L666.4,140.7L665.3,141.2L662.5,141.6L660,142.2L658.8,143.6L659.7,144.9L660.3,146.5L659.3,147.8L659.7,149L659.2,150.1L656.8,150L658.2,152L656.8,152.8L656,154.7L656.5,156.6L655.7,157.5L654.7,157.2L652.8,157.6L652.7,158.5L650.8,158.5L649.7,160.2L650.1,162.9L646.9,164.2L645.1,163.9L644.7,164.6L643.1,164.2L640.6,164.6L636.1,163.1L637.9,160.2L637.4,158.2L635.4,157.7L634.9,155.7L633.6,153.2L634.4,151.5L633.2,151.1L633.5,148.8L633.8,144.9L636.6,146.1L638.4,145.7L638.7,144.3L640.6,143.8L641.8,142.9L641.8,140.4L643.8,139.8L643.9,138.7L645.3,139.5Z","TJ":"M649.5,140.3L650.2,137.1L649.1,134.8L647.1,134.1L647.5,132.7L649.6,132.9L650.3,131.2L650.6,129.2L653.7,128.4L653.6,129.9L654.2,130.7L655.1,130.7L654.5,131.6L651.7,131.1L651.9,132.9L654.5,132.6L657.8,133.6L662.4,133.2L663.7,136L664.4,135.7L666.1,136.4L666.3,137.6L667.1,139.4L664.6,139.4L662.8,139.2L661.6,140.6L660.5,140.9L659.8,141.5L658.6,140.5L658.2,137.9L657.4,137.8L657.5,136.8L656,136.1L655.1,137.2L655.2,138.4L654.9,138.9L653.4,138.8L652.9,140.2L651.9,139.7L650.3,140.6Z","KG":"M653.4,124.4L653.6,123.1L655.1,122.6L659.4,123.7L659.3,121.9L660.5,121.3L664.3,122.5L665.1,122.2L669.1,122.3L672.9,122.6L674.4,123.7L676.1,124.2L675.9,124.9L672.6,126.5L672,127.8L669,128.1L668.6,130.1L665.9,129.7L664.3,130.3L662.4,131.7L662.9,132.5L662.4,133.2L657.8,133.6L654.5,132.6L651.9,132.9L651.7,131.1L654.5,131.6L655.1,130.7L657.1,131L659.7,128.7L656.3,127.1L654.8,127.9L652.7,126.7L654.2,124.7Z","TM":"M608.6,125.9L609.5,124.9L612.1,124.2L613.9,125.1L616.2,127.5L617.4,127.4L620.1,127.3L619.4,125.8L621.3,124.7L622.9,122.9L626.6,124.6L627.4,127L628.5,127.6L631.1,127.5L632.1,128.1L634,131.3L637.3,133.4L639.2,134.8L642.1,136.4L645.7,137.7L646.1,139.6L645.3,139.5L643.9,138.7L643.8,139.8L641.8,140.4L641.8,142.9L640.6,143.8L638.7,144.3L638.4,145.7L636.6,146.1L633.8,144.9L633.1,142.3L631.2,142.2L627.8,139.4L625.8,139.1L622.7,137.5L620.9,137.2L619.9,137.8L618.2,137.7L616.8,139.5L614.7,140.1L613.9,137.9L613.6,134.7L611.5,133.6L611.8,131.5L610.1,131.3L610.1,128.7L612.6,129.5L614.6,128.5L612.4,126.6L611.4,124.9L609.6,125.7L609.7,127.9Z","IR":"M604.5,162.7L602.9,161.1L602.6,159.4L601.8,159.4L601.9,157.2L600.3,154.8L597,153.1L594.8,150.1L595.1,147.7L596.2,146.6L595.8,144.8L594,143.9L591.9,140.2L590.1,137.7L590.5,136.7L589.2,133.2L590.7,132.3L591.3,133.5L592.8,134.9L594.5,135.3L595.4,135.2L598,132.9L598.9,132.7L599.8,133.6L599.2,135.2L601,136.8L601.6,136.6L602.7,138.9L605.2,139.6L607.2,141.1L610.8,141.6L614.6,140.8L614.7,140.1L616.8,139.5L618.2,137.7L619.9,137.8L620.9,137.2L622.7,137.5L625.8,139.1L627.8,139.4L631.2,142.2L633.1,142.3L633.8,144.9L633.5,148.8L633.2,151.1L634.4,151.5L633.6,153.2L634.9,155.7L635.4,157.7L637.4,158.2L637.9,160.2L636.1,163.1L637.6,164.7L638.9,166.6L641.6,167.9L642,170.7L643.3,171.2L643.7,172.6L640.2,174.2L639.7,177.9L634.7,176.9L631.8,176.2L628.8,175.8L627.3,172L625.9,171.4L624,172L621.6,173.5L618.3,172.5L615.4,170.1L612.8,169.2L610.8,166.2L608.3,162.1L607,162.6L605.3,161.5Z","SY":"M570.7,154.1L570.7,154.1L571,153.6L570.8,152.3L571.3,150.6L572.5,149.4L572,148.2L570.8,148L570.3,145.7L570.8,144.4L571.4,143.7L572,143L571.9,141.3L572.8,141.9L575.5,141L576.9,141.6L578.9,141.6L581.7,140.4L583,140.5L585.8,140L584.8,141.9L583.5,142.7L584,145L583.5,148.7L578.3,152L573.7,155.3Z","AM":"M595.4,135.2L594.5,135.3L593.3,133.5L593.2,133L592.1,133.1L591.2,132.2L590.7,132.3L589.6,131.4L587.7,130.6L587.7,129.1L587.1,128L590.4,127.6L591.1,128.4L592.1,128.9L591.7,129.7L593.2,130.7L592.7,131.7L593.8,132.6L595,133.1Z","SE":"M504.4,75L505.2,73.3L506.9,71.4L507.4,68.1L505.9,66.7L505.5,63L506.7,60.4L508.8,60.5L509.5,59.4L508.6,58.5L511.5,54.6L513.3,51.7L514.4,49.8L516.4,49.8L516.7,48.3L520.6,48.7L520.7,47L521.9,46.9L524.9,48.2L528.3,50L529,54.1L529.9,55.1L526.4,55.9L524.7,57.8L525.2,59.5L522.1,61.7L518.3,64L517.1,68L518.9,69.9L521.2,71.5L519.5,74.7L517.2,75.4L516.8,80.2L515.8,82.9L513.1,82.6L511.9,84.9L509.3,85L508.4,82.3L506.3,79Z","BY":"M543.5,82.7L546,83.4L546.4,84.1L547.6,83.8L549.9,84.5L550.3,85.9L550,86.6L551.7,88.6L552.7,89.1L552.7,89.6L554.3,90.2L555.1,90.9L554.3,91.6L552.4,91.5L552,91.8L552.7,92.7L553.6,94.6L551.6,94.8L551,95.5L551.1,97L550.1,96.7L548,96.8L547.3,96.1L546.5,96.6L545.6,96.2L543.8,96.1L541.1,95.4L538.7,95.2L536.9,95.3L535.8,96.1L534.7,96.2L534.5,94.9L533.6,93.5L534.9,92.9L534.8,91.7L534,90.6L533.7,89.3L536,89.3L538.3,88.2L538.6,86.6L540.3,85.6L539.9,84.3L541.2,83.8Z","UA":"M553.6,94.6L554.5,94.7L555,94.1L555.7,94.2L558,93.9L559.8,95.6L559.3,96.2L559.7,97.1L561.5,97.3L562.6,98.6L562.6,99.2L565.8,100.2L567.5,99.7L569.2,101.2L570.6,101.1L574.2,102.1L574.4,103L573.7,104.6L574.5,106.2L574.3,107.2L572.1,107.4L571,108.3L571.1,109.6L569.3,109.9L567.8,110.9L565.6,111L563.7,112.2L564.1,113.8L563.7,113.7L563.3,113.1L562.5,113L560.7,112.3L560.2,113.1L559.8,112.7L556,112L555.7,110.8L553.5,111.2L552.9,112.9L551.3,115.1L550.1,114.6L549,115.1L547.9,114.5L548.5,114.2L548.8,113.2L549.3,112.2L549.1,111.7L549.5,111.4L549.8,111.8L551.2,111.9L551.9,111.7L551.4,111.4L551.5,110.9L550.5,110.2L550,108.9L549.1,108.4L549.2,107.4L548,106.6L547,106.4L545.1,105.5L543.6,105.8L543.1,106.2L542.1,106.2L541.6,107L539.8,107.2L539.1,107.7L537.9,107L536.4,107L534.9,106.6L533.9,107.3L533.7,106.5L532.3,105.6L532.6,104.4L533.2,103.6L533.7,103.8L533,102.5L534.8,100L536,99.6L536.1,98.8L534.7,96.2L535.8,96.1L536.9,95.3L538.7,95.2L541.1,95.4L543.8,96.1L545.6,96.2L546.5,96.6L547.3,96.1L548,96.8L550.1,96.7L551.1,97L551,95.5L551.6,94.8Z","PL":"M533.7,89.3L534,90.6L534.8,91.7L534.9,92.9L533.6,93.5L534.5,94.9L534.7,96.2L536.1,98.8L536,99.6L534.8,100L533,102.5L533.7,103.8L533.2,103.6L530.8,102.5L529.2,102.9L528,102.6L526.7,103.2L525.4,102.2L524.5,102.6L524.3,102.4L523.1,100.9L521.4,100.7L521.1,99.8L519.4,99.5L519.2,100.3L517.8,99.6L517.9,98.8L516.2,98.6L515,97.6L513.9,95.7L514,94.7L513.3,93.1L512.4,92L513,91.2L512.3,89.7L513.8,88.9L517.3,87.5L520.1,86.5L522.4,87L522.6,87.7L524.8,87.8L527.7,88.1L531.9,88.1L533.1,88.4Z","AT":"M520.3,106.5L520.2,107.8L518.8,107.8L519.3,108.4L518.7,110.4L518.3,110.9L516.2,111L515,111.7L513,111.4L509.6,110.7L509,109.6L506.6,110.1L506.4,110.7L504.9,110.3L503.7,110.2L502.6,109.6L502.9,108.9L502.8,108.4L503.5,108.2L504.8,109L505.1,108.2L507.2,108.4L508.9,107.8L510,107.9L510.8,108.5L511,108L510.5,106L511.3,105.7L512.1,104.3L513.9,105.2L515.2,104L516,103.8L517.9,104.7L519,104.5L520.1,105.1L519.9,105.5Z","HU":"M532.3,105.6L533.7,106.5L533.9,107.3L532.5,107.9L531.6,110L530.3,112L528.5,112.6L527,112.5L525.2,113.3L524.3,113.7L522.3,113.1L520.4,111.8L519.6,111.5L519.1,110.4L518.7,110.4L519.3,108.4L518.8,107.8L520.2,107.8L520.3,106.5L521.5,107.3L522.4,107.7L524.4,107.3L524.5,106.7L525.5,106.6L526.6,106.1L526.8,106.3L527.9,105.9L528.4,105.2L529.2,105L531.8,106Z","MD":"M543.1,106.2L543.6,105.8L545.1,105.5L547,106.4L548,106.6L549.2,107.4L549.1,108.4L550,108.9L550.5,110.2L551.5,110.9L551.4,111.4L551.9,111.7L551.2,111.9L549.8,111.8L549.5,111.4L549.1,111.7L549.3,112.2L548.8,113.2L548.5,114.2L547.9,114.5L547.3,113.2L547.4,111.9L547.2,110.5L545.6,108.7L544.7,107.4L543.8,106.5Z","RO":"M547.9,114.5L549,115.1L550.1,114.6L551.3,115.1L551.4,115.9L550.3,116.6L549.6,116.3L549.3,120L547.8,119.7L546,118.6L543.2,119.3L542.1,120.1L538.5,119.9L536.6,119.4L535.7,119.6L534.8,118.4L534.3,117.8L534.9,117.3L534.2,116.9L533.5,117.6L532,116.7L531.7,115.5L530.2,114.8L529.9,113.8L528.5,112.6L530.3,112L531.6,110L532.5,107.9L533.9,107.3L534.9,106.6L536.4,107L537.9,107L539.1,107.7L539.8,107.2L541.6,107L542.1,106.2L543.1,106.2L543.8,106.5L544.7,107.4L545.6,108.7L547.2,110.5L547.4,111.9L547.3,113.2Z","LT":"M539.9,84.3L540.3,85.6L538.6,86.6L538.3,88.2L536,89.3L533.7,89.3L533.1,88.4L531.9,88.1L531.6,87.3L531.8,86.5L530.7,86.1L528.3,85.5L527.5,83.1L530,82.2L533.8,82.4L536,82.1L536.3,82.7L537.6,82.9Z","LV":"M540.9,78.9L542.1,79.6L542.5,81L543.5,82.7L541.2,83.8L539.9,84.3L537.6,82.9L536.3,82.7L536,82.1L533.8,82.4L530,82.2L527.5,83.1L527.3,80.9L528.2,79.1L530.2,78.1L532.2,80.3L534,80.2L534.2,78L536,77.5L537,77.9L539.1,78.9Z","EE":"M541.6,73.2L542,73.7L540.7,75.4L541.8,78L540.9,78.9L539.1,78.9L537,77.9L536,77.5L534.2,78L534.2,76.3L533.4,76.7L531.9,75.7L531.5,74L534.1,73.3L536.9,72.8L539.3,73.3Z","DE":"M512.3,89.7L513,91.2L512.4,92L513.3,93.1L514,94.7L513.9,95.7L515,97.6L514,97.9L513.3,97.6L512.8,98.1L511.1,98.7L510.3,99.4L508.7,100.1L509.1,101L509.4,102.3L510.7,103L512.1,104.3L511.3,105.7L510.5,106L511,108L510.8,108.5L510,107.9L508.9,107.8L507.2,108.4L505.1,108.2L504.8,109L503.5,108.2L502.8,108.4L500.2,107.4L499.8,108.1L497.8,108.1L498,105.9L499.1,103.9L495.7,103.3L494.6,102.5L494.7,101.2L494.2,100.5L494.4,98.5L493.9,95.4L495.3,95.4L495.8,94.3L496.3,91.5L495.9,90.6L496.3,89.9L498.2,89.8L498.6,90.4L500.1,89L499.6,87.9L499.4,86.2L501.1,86.6L502.5,86.1L502.6,87.3L505,88L505,89L507.3,88.5L508.5,87.6L511.2,88.8Z","BG":"M534.8,118.4L535.7,119.6L536.6,119.4L538.5,119.9L542.1,120.1L543.2,119.3L546,118.6L547.8,119.7L549.3,120L548.2,121.3L547.5,123.5L548.5,125.2L546.4,124.8L544,125.8L544.1,127.3L541.9,127.6L540,126.5L538.2,127.4L536.3,127.3L536,125.2L534.7,124.3L535,123.8L534.7,123.5L535.1,122.5L535.9,121.5L534.6,120.2L534.3,119.1Z","GR":"M546.2,146L545.9,146.9L542.3,147.2L542.3,146.7L539.2,146.1L539.6,144.7L541,145.8L542.9,145.6L544.8,145.8L544.8,146.4ZM536.3,127.3L538.2,127.4L540,126.5L541.9,127.6L544.1,127.3L544,125.8L545.2,126.6L544.6,128.5L544.1,128.9L542.6,128.8L541.3,128.5L538.4,129.3L540.2,131L539,131.5L537.6,131.5L536.2,129.9L535.8,130.6L536.5,132.5L537.9,133.9L537,134.6L538.5,136L539.8,136.9L539.9,138.7L537.6,137.9L538.4,139.4L536.9,139.8L538,142.5L536.4,142.6L534.2,141.2L533.1,138.7L532.5,136.7L531.5,135.2L530.1,133.5L529.8,132.6L530.9,131.1L530.9,130.1L531.7,129.6L531.7,128.8L533.3,128.5L534.2,127.9L535.5,127.9L535.9,127.4Z","TR":"M591.9,140.2L590.7,140.7L589.8,139.9L586.8,139.5L585.8,140L583,140.5L581.7,140.4L578.9,141.6L576.9,141.6L575.5,141L572.8,141.9L571.9,141.3L572,143L571.4,143.7L570.8,144.4L569.7,143L570.5,141.8L569,142.1L566.9,141.4L565.3,143.1L561.6,143.5L559.4,141.8L556.7,141.7L556.2,143L554.5,143.4L551.9,141.7L549.2,141.8L547.5,138.7L545.5,137L546.5,134.6L544.8,133.1L547.2,130.1L551,130L551.8,127.6L556.5,128.1L559.2,126.1L562,125.2L566,125.1L570.6,127.3L574.3,128.5L577.1,128L579.2,128.3L581.9,126.7L584.5,126.5L587.1,128L587.7,129.1L587.7,130.6L589.6,131.4L590.7,132.3L589.2,133.2L590.5,136.7L590.1,137.7ZM544,125.8L546.4,124.8L548.5,125.2L548.9,126.4L551.2,127.4L550.8,128.2L547.9,128.3L546.9,129.3L545,130.9L544.1,129.5L544.1,128.9L544.6,128.5L545.2,126.6Z","AL":"M531.7,128.8L531.7,129.6L530.9,130.1L530.9,131.1L529.8,132.6L529.4,132.4L529.3,131.7L527.9,130.6L527.5,129.2L527.6,127.1L527.9,126.1L527.4,125.6L527.2,124.6L528.1,123.1L528.3,123.7L529,123.4L529.6,124.3L530.2,124.6L530.4,125.7L530.2,126.7L530.6,128.1Z","HR":"M519.6,111.5L520.4,111.8L522.3,113.1L524.3,113.7L525.2,113.3L525.9,114.4L526.7,115.3L525.9,116.5L524.7,115.8L523,115.8L520.9,115.3L519.8,115.4L519.3,116L518.4,115.3L518,116.6L519.3,118L519.9,119L521.1,120.1L522,120.8L523,122.1L525.3,123.2L525,123.8L522.7,122.6L521.2,121.5L518.9,120.6L516.7,118.4L517.2,118.1L516,116.8L515.9,115.8L514.3,115.3L513.7,116.6L512.9,115.6L512.9,114.6L513,114.5L514.7,114.6L515.1,114.1L515.9,114.6L516.9,114.7L516.8,113.8L517.6,113.5L517.8,112.3Z","CH":"M502.8,108.4L502.9,108.9L502.6,109.6L503.7,110.2L504.9,110.3L504.8,111.5L503.8,112L502,111.6L501.5,112.9L500.4,113L499.9,112.5L498.6,113.5L497.5,113.7L496.4,113L495.6,111.7L494.4,112.2L494.4,110.8L496.1,109.1L496,108.3L497.1,108.6L497.8,108.1L499.8,108.1L500.2,107.4Z","LU":"M494.2,100.5L494.7,101.2L494.6,102.5L493.9,102.6L493.3,102.3L493.6,100.6Z","BE":"M494.4,98.5L494.2,100.5L493.6,100.6L493.3,102.3L491.3,100.9L490.1,101.2L488.4,99.8L487.3,98.6L486.2,98.5L485.9,97.5L487.7,96.9L489.4,97.1L491.6,96.5L493.1,97.8Z","NL":"M495.9,90.6L496.3,91.5L495.8,94.3L495.3,95.4L493.9,95.4L494.4,98.5L493.1,97.8L491.6,96.5L489.4,97.1L487.7,96.9L488.9,96.1L490.8,91.7L493.9,90.5Z","PT":"M457.9,125.6L458.8,124.8L459.8,124.4L460.4,125.9L461.8,125.9L462.2,125.5L463.7,125.6L464.3,127.1L463.2,128L463.1,130.4L462.7,130.8L462.5,132.3L461.5,132.6L462.4,134.4L461.7,136.5L462.5,137.4L462.1,138.2L461.2,139.4L461.4,140.4L460.3,141.2L459,140.8L457.7,141.1L458.2,138.7L458,136.8L456.9,136.5L456.3,135.3L456.6,133.3L457.6,132.2L457.9,130.9L458.4,129.1L458.4,127.8L458,126.7Z","ES":"M461.4,140.4L461.2,139.4L462.1,138.2L462.5,137.4L461.7,136.5L462.4,134.4L461.5,132.6L462.5,132.3L462.7,130.8L463.1,130.4L463.2,128L464.3,127.1L463.7,125.6L462.2,125.5L461.8,125.9L460.4,125.9L459.8,124.4L458.8,124.8L457.9,125.6L458.1,123.4L457.1,122.1L460.6,119.9L463.6,120.4L466.9,120.4L469.4,120.9L471.4,120.8L475.4,120.9L476.3,122.1L480.8,123.5L481.7,122.8L484.5,124.2L487.3,123.8L487.4,125.6L485.1,127.6L482,128.3L481.8,129.3L480.3,131L479.3,133.6L480.3,135.3L478.8,136.7L478.3,138.7L476.4,139.3L474.6,141.7L471.5,141.8L469.1,141.7L467.5,142.8L466.5,144L465.3,143.7L464.4,142.7L463.7,140.9Z","IE":"M465.8,89.4L466.1,91.5L464.3,94.2L460.1,95.9L456.9,95.5L458.9,92.4L457.8,89.4L461,87.1L462.8,85.7L463.2,87.3L462.7,88.9L464.1,88.8Z","NC":"M914.5,321.1L916.1,323L917,324.5L915.8,325.2L914.6,324.4L913.2,323L911.9,321.3L910.8,319.1L910.7,318.1L911.9,318.1L913,319.2L913.9,320.2Z","SB":"M911.7,288.2L912.3,289.3L910.5,289.2L909.7,287.3L911.2,288.1ZM910.9,285.5L910.4,286L908.8,283.3L908.4,281.5L909.3,281.5L910,284ZM908.6,286.3L907.5,286.4L906,286.1L905.5,285.6L905.8,284.3L907.5,284.8L908.3,285.5ZM906,280.6L906.5,281.5L906.6,282.2L904.6,280.8L903.3,279.7L902.4,278.7L902.8,278.4L904,279.1ZM899.6,277.5L900.6,278.5L900.1,278.7L899,277.9L898,276.7L898.2,276.2Z","NZ":"M916.6,380.2L914.6,381.9L912.1,384L909.4,385.2L909.5,384.4L908.8,384L911.8,381.4L912,379.7L910.1,378.5L910.8,377.4L913.3,376.3L915.1,373.9L916.1,371.9L916.3,369.8L916.6,369.3L916.1,368L915.6,365.2L915.7,363L916.8,362.8L917.2,364.5L918.8,365.3L918,368.1L918,371.4L919.2,369.3L919.9,370.1L918.9,372.4L920.4,373.5L921.9,373.7L924,372.5L925.1,372.9L922.9,375.6L921,377.4L919.2,377.4L917.9,378.3L917.3,379.7ZM892.1,391L895.2,389.4L897.7,387.8L900.3,385.5L901.7,384.7L903.1,383L905.7,381.5L905.5,382.9L905.2,384.1L907.7,382.9L907.6,384.2L906.8,385.5L905,386.9L901.9,389.2L899.8,390.4L899.7,391.9L897.8,391.9L895,393.1L892.9,395.1L889.4,398.2L886.6,399.5L884.8,400.4L882.6,400.3L881.8,399.3L879.3,399.1L879.7,398L882.5,395.7L887.6,392.7L889.5,392.1Z","AU":"M843.3,382.5L844.7,382.7L842.9,386.4L841.5,387.4L839.8,389.9L839.5,389.1L836.5,391.2L836.1,391.1L834.7,391L834.7,388.3L835.5,386.3L835.5,383.6L836.3,382.2L837.7,382.5L839.6,383.5L841.1,383.1ZM800.9,355.8L797.7,357.4L795.2,358.2L794.2,359.8L792.8,361L790.6,361.1L788.9,361.4L786.9,360.8L785,361.2L783.2,361.3L781.1,363L780.4,362.8L778.8,363.7L777.3,364.7L775.5,364.6L773.8,364.6L771.8,362.6L770.6,362L771.3,360.2L772.7,359.8L773.4,359.1L773.6,358L774.6,355.8L774.9,354L774.5,350.8L774.6,349L775.2,347.2L774.8,345.2L775,344.3L774.2,343L774.5,340.6L773.6,338.1L773.6,336.8L774.4,338.2L774.2,335.3L775.3,336.2L775.8,337.4L776.1,335.8L775.4,333.3L775.4,332.3L775,331.4L775.7,329.6L776.4,328.8L777.1,327.3L777.2,325.5L778.8,323.2L778.5,325.6L780,323.5L782.3,322.4L783.9,321.1L786.1,319.9L787.4,319.7L788,320.1L790.3,318.9L792,318.6L792.5,317.9L793.3,317.6L794.7,317.7L797.6,316.8L799.3,315.4L800.3,313.7L802.1,312.1L802.5,310.9L802.8,309.2L805.1,306.6L805.8,309.3L807,308.6L806.3,307.2L807.4,305.7L808.5,306.3L809.2,304L810.8,302.4L811.7,301.2L813.1,300.7L813.2,299.8L814.4,300.2L814.5,299.4L815.7,299L817.1,298.5L818.8,300L820,301.8L821.7,301.8L823.3,302.1L823,300.4L824.7,297.9L826,297.1L825.7,296.3L827.1,294.6L828.8,293.5L830.1,293.8L832.4,293.3L832.6,291.7L830.8,290.6L832.2,290.2L833.9,291L835.2,292.2L837.3,293L838.1,292.7L839.6,293.7L841.3,292.8L842.3,293.1L843,292.5L844,294L843,295.7L841.8,296.9L840.9,297L841,298.3L840,299.8L838.8,301.3L838.9,302.2L840.7,303.9L842.6,304.9L843.7,306L845.3,307.8L846.1,307.8L847.3,308.6L847.5,309.6L849.8,310.6L851.8,309.6L852.6,307.9L853.4,306.5L854,304.8L855.3,302.3L855.2,300.8L855.5,299.9L855.5,298.2L856.2,295.8L856.8,295.2L856.5,294.2L857.4,292.5L858.1,290.8L858.3,289.9L859.4,288.8L860,290.3L859.9,292.2L860.6,292.6L860.5,293.9L861.2,295.5L861.1,297.2L860.9,298.4L861.4,300.8L863.3,299.6L864,301L865,302.2L864.5,303.5L864.6,306.2L864.7,307.8L865.3,308.1L865.5,310.8L864.9,312.4L865.2,314.5L867.7,316.1L869.2,317.6L870.7,319L870.1,319.7L871.1,321.7L871.2,325L872.5,324.4L873.2,325.7L873.9,325.2L873.5,328.5L874.7,330.4L875.6,331.6L876.8,334.2L876.7,336.7L876.2,338.4L875.4,340.4L875.7,343L874.5,345.8L873.5,347.2L871.8,350L871.1,351.8L869.7,354L867.4,356.9L864.9,358.4L862.9,360.8L861.4,362.4L859.5,365L857.8,366.6L856.1,368.9L854.7,371.1L854.4,372L852.4,373.1L849.6,373.2L846.7,374.5L844.9,375.7L842.8,377L841.4,375.7L840.1,375.1L841.3,373.5L839.7,374.1L836.4,376.3L834.7,375.5L833.5,375L832.2,374.8L830.2,373.9L829.4,372L830,369.6L830.1,368L829.4,366.8L827.2,366.4L828.6,364.9L829,362.6L826.9,364.7L824.4,365.3L826.4,363.6L827.5,361.8L829.1,360.3L829.8,358L826.7,360.6L824.7,361.7L822.7,364.2L821.3,362.9L822,361.2L821.3,359L820.4,357.8L821.1,357.1L818.6,355.2L816.8,355.1L814.9,353.6L810.2,353.9L806.6,355L803.3,356Z","LK":"M698.3,232.4L698.1,235.6L697,236.5L694.7,237.2L693.3,234.8L692.7,230.3L693.6,225.3L695.5,227L696.9,229.2Z","CN":"M768.5,199.3L766.2,198.3L765.7,195.6L766.7,194.2L769.4,193.4L770.9,193.4L771.7,194.6L770.8,196L770.5,197.8ZM676.1,124.2L675.3,122.4L676.8,121.6L672.9,116.3L677.3,115.1L678.3,114.4L678.1,108.9L683.2,109.9L684,108.6L683,105.5L684.8,105.3L685.8,103.3L686.7,103L688.1,105.1L690.7,106.7L694.6,107.8L697.2,110.3L697.6,113.8L699,115.2L702,115.7L705.4,116.1L709.1,118L710.7,118.4L712.8,121.2L714.9,123L717.6,122.9L722.9,123.6L726,123.2L728.6,123.7L732.9,125.5L735.9,125.5L737.3,126.5L739.5,124.8L743,123.8L746.6,123.6L749,122.6L750.1,120.9L751.3,119.9L750.5,118.9L749.2,117.7L749.6,115.7L751.1,116L753.8,116.6L755.5,115L758.6,113.8L759.4,111.8L760.6,110.9L763.9,110.5L766,110.9L765.7,109.8L762.4,107.7L760,106.7L758.8,107.8L756.2,107.4L755,107.7L753.8,106.5L753.9,103.5L753.8,101.2L757.3,102.4L759.5,100.5L758.8,99.2L759.1,96L759.8,95L758.8,93.4L757.1,92.7L758.1,91.2L760.6,90.7L763.6,90.6L767.6,91.5L770.3,92.6L773.6,95.6L775.3,96.9L777.2,98.7L779.8,101.6L784.5,102.6L788.5,104.7L791.1,107.6L794.7,107.6L796.1,106.4L799.5,105.5L799.9,108.2L799.6,109.3L800.6,112.6L800.7,115.6L797.4,115.1L796,116.1L798,118.8L799.5,122.4L798.3,122.5L799.1,124L796.6,122.2L796.5,123.9L793.3,125.3L794.5,126.9L792.3,126.8L790.7,125.8L790,128L788.1,129.7L786.9,131.6L783.8,132.5L782.6,134L780.3,134.8L781,133.4L780,132.2L781.1,130.1L779.1,128.5L777.4,129.6L775.5,131.7L774.8,133.7L772.5,133.9L771.8,135.3L773.9,137.4L776.1,137.9L776.8,139.3L779.1,140.2L781,138L783.7,139.2L785.4,139.3L786.4,140.9L783.2,141.8L782.7,143.5L780.8,145L780.3,147.2L783.6,148.9L785.7,152L788.2,154.8L790.7,157.2L791.4,159.6L790.1,160.4L791.2,162.1L793,163L793.4,165.6L793.4,168.1L792.1,168.3L791.1,171.7L790.1,175.8L788.6,179.5L785.7,182.4L782.6,185L779.8,185.4L778.5,186.8L777.3,185.8L776.2,187.3L772.8,188.9L770.2,189.3L769.9,192.6L768.5,192.8L767.4,190.5L767.8,189.3L764.1,188.3L762.9,188.9L760.1,188L758.6,186.8L758.7,185L756.2,184.4L754.7,183.2L752.8,184.9L750.3,185.3L748.3,185.2L747,186L745.7,186.5L746.8,190L745.4,189.9L745,189.2L744.7,187.9L742.9,188.8L741.7,188.3L739.5,187.1L739.8,184.5L738.1,183.9L736.9,181L734.2,181.5L733.8,177.8L735.7,175.2L735.3,172.7L734.7,170.3L733.4,169.5L732.1,167.7L730.7,167.9L727.8,167.5L728.3,166.2L726.7,164.2L725.2,165.5L722.8,164.8L720.3,166.8L718.5,169.1L716.5,169.5L715.2,168.6L713.8,168.6L711.8,167.8L710.6,168.6L709.3,170.9L708.6,168.5L707.2,169.1L704.1,168.8L701.1,168.1L698.7,166.8L696.6,166.1L695.4,164.6L693.9,164.2L690.9,162.2L688.6,161.2L687.7,161.9L683.7,159.8L680.8,157.8L679.3,154.4L681.3,154.8L681,153.2L679.6,151.6L679.3,149L675.7,145.4L671.3,144.1L670,141.8L667.8,140.3L667.1,139.4L666.3,137.6L666.1,136.4L664.4,135.7L663.7,136L662.4,133.2L662.9,132.5L662.4,131.7L664.3,130.3L665.9,129.7L668.6,130.1L669,128.1L672,127.8L672.6,126.5L675.9,124.9Z","TW":"M796.8,180L796.4,185L795.9,187.6L793.9,184.9L793.1,182.6L793.9,179.5L795.4,177.2L796.8,178.1Z","IT":"M504.9,110.3L506.4,110.7L506.6,110.1L509,109.6L509.6,110.7L513,111.4L512.8,112.9L513.5,114.2L511.6,113.8L509.7,114.9L509.9,116.4L509.6,117.3L510.5,118.8L512.8,120.4L514.2,122.9L517.1,125.4L519,125.4L519.6,126L519,126.7L521.2,127.8L523.1,128.7L525.3,130.3L525.6,130.9L525.2,132L523.7,130.6L521.6,130L520.7,132L522.5,133.2L522.3,134.8L521.3,135L520.1,137.7L519.1,137.9L519,136.9L519.5,135.3L520,134.6L518.9,132.8L518,131.3L517,130.9L516.2,129.5L514.6,129L513.5,127.7L511.6,127.5L509.7,126.2L507.3,124.1L505.6,122.4L504.7,119.3L503.5,119L501.5,118L500.4,118.4L499,119.8L498,120L498.3,118.7L497,118.3L496.3,116L497.1,115L496.3,113.9L496.4,113L497.5,113.7L498.6,113.5L499.9,112.5L500.4,113L501.5,112.9L502,111.6L503.8,112L504.8,111.5ZM516.7,137.2L518.6,136.9L517.8,139.3L518.3,140.3L517.8,141.9L515.8,140.7L514.6,140.4L511,138.8L511.3,137.2L514.2,137.5ZM501.4,128.6L502.6,127.7L504.2,129.9L504,134L502.8,133.8L501.8,134.8L500.9,134L500.7,130.2L500.1,128.5Z","DK":"M502.5,86.1L501.1,86.6L499.4,86.2L498.4,84.6L498.2,81.6L498.5,80.8L499.1,80L501.1,79.8L501.8,79L503.6,78.2L503.6,79.7L503,80.6L503.3,81.4L504.5,81.9L504.1,83L503.4,82.6L501.9,84.7ZM507.9,82.9L508.7,84.3L507.5,86.7L505,85L504.6,83.8Z","GB":"M465.8,89.4L464.1,88.8L462.7,88.9L463.2,87.3L462.8,85.7L464.7,85.6L467.1,87.4ZM472.9,90.8L472.9,90.8L473.3,89.1L471.8,87.3L471.7,87.2L469,86.7L468.5,85.9L469.3,84.6L468.6,83.8L467.3,85.2L467.3,82.4L466.2,80.9L467.1,77.9L468.9,75.6L470.7,75.9L473.3,75.6L470.9,78.7L473.2,78.3L475.6,78.3L475,80.7L473,83.3L475.3,83.5L475.5,83.8L477.5,87.2L479,87.7L480.4,91L481.1,92.2L483.9,92.7L483.6,94.6L482.4,95.5L483.4,97L481.3,98.6L478.2,98.6L474.2,99.4L473.1,98.8L471.5,100.2L469.4,99.9L467.7,101L466.5,100.4L470,97.3L472.1,96.6L472,96.6L468.4,96.1L467.8,95L470.2,94L469,92.4L469.5,90.5Z","IS":"M449.8,53.9L449.2,55.7L451.4,57.5L448.4,59.6L442.1,61.5L440.2,62L437.5,61.6L431.6,60.7L433.9,59.5L429.5,58.2L433.3,57.6L433.3,56.8L429,56.2L430.7,54.5L433.9,54.1L436.9,55.9L440.3,54.4L442.8,55.2L446.4,53.7Z","AZ":"M593.6,125.7L594.3,125.8L596.3,127.6L597.4,127.9L597.7,127.1L599,125.8L600.6,127.5L602.2,129.6L603.4,129.8L604.3,130.6L602.3,130.9L602.3,133.3L602,134.4L601.2,135.1L601.6,136.6L601,136.8L599.2,135.2L599.8,133.6L598.9,132.7L598,132.9L595.4,135.2L595,133.1L593.8,132.6L592.7,131.7L593.2,130.7L591.7,129.7L592.1,128.9L591.1,128.4L590.4,127.6L590.9,127.1L592.9,127.9L594.3,128.1L594.5,127.8L593.1,126.1ZM594.5,135.3L592.8,134.9L591.3,133.5L590.7,132.3L591.2,132.2L592.1,133.1L593.2,133L593.3,133.5Z","GE":"M577.1,120.8L577.3,120.5L579.5,121L583.1,121.5L586.7,123L587.2,123.5L588.6,123.1L591,123.7L592,125L593.6,125.7L593.1,126.1L594.5,127.8L594.3,128.1L592.9,127.9L590.9,127.1L590.4,127.6L587.1,128L584.5,126.5L581.9,126.7L582.1,125.4L581.1,123.3L579.5,122.1L578.1,121.8Z","PH":"M801,216.4L799.3,214L801.6,214.1L802.7,215.2L802.3,217.9ZM806.6,224.8L807.2,223.9L807.3,222L808.7,221.8L808.5,223.9L810.2,220.9L810.2,223.9L809.4,224.9L808.7,226.9L808,227.8L806.1,225.6ZM817.2,229.7L817.6,231.7L817.9,233.5L817.2,236.3L816,233.1L814.8,234.7L815.8,237L815.2,238.4L811.9,236.6L811,234.4L811.7,232.9L809.9,231.5L809.2,232.7L807.9,232.6L806.1,234.4L805.6,233.4L806.4,230.8L808,230L809.4,228.8L810.4,230.2L812.4,229.3L812.7,228L814.6,227.9L814.2,225.5L816.5,227L816.9,228.5ZM795.9,226.9L792.6,229.8L793.7,227.6L795.5,225.7L796.9,223.6L798,220.5L798.7,223L797.1,224.7ZM802.4,199.2L802.2,200.5L803.5,202.7L803.2,205.3L801.8,206.3L801.8,208.8L802.7,211.3L804.2,211.7L805.3,211.3L808.8,213L808.8,214.7L809.8,215.4L809.7,216.9L807.4,215.3L806.2,213.7L805.7,214.9L803.8,213L801.4,213.5L800,212.8L800,211.5L800.7,210.7L799.8,210L799.6,211.1L798,209.3L797.4,208L796.9,205L798.1,206L797.6,201.2L797.9,198.3L799.5,198.3L801.3,199.2L802,198.4ZM804.7,220.4L804.1,218.9L805.8,219.8L807.5,219.8L807.6,221.1L806.5,222.4L804.9,223.4L804.7,221.9ZM813.6,218L814.8,221.5L812.6,220.7L812.8,221.7L813.6,223.6L812.5,224.3L812.1,222.1L811.3,222L810.7,220.1L812.3,220.4L812.1,219.2L810.2,216.8L812.7,216.9Z","MY":"M747.4,235.7L747.8,235.1L750.1,236.5L750.3,238.1L752.1,237.7L752.9,236.4L753.5,236.7L755.2,238.6L756.4,240.7L756.6,242.8L756.4,244.2L756.7,245.2L756.9,247.1L757.9,247.9L759,250.7L759,251.7L757.1,251.9L754.5,249.6L751.3,247.2L750.9,245.6L749.3,243.5L748.9,241L747.8,239.3L748,237ZM795.3,242.9L792.9,242.4L789.9,242.4L789.1,245.9L788.1,247L786.8,251.3L784.6,251.9L782,251.1L780.8,251.4L779.2,252.9L777.5,252.7L775.8,253.3L774,251.6L773.5,249.5L775.5,250.6L777.5,250L778,247.4L779.1,246.8L782.3,246.1L784.2,243.7L785.4,241.7L786.7,243.3L787.2,242.3L788.5,242.4L788.5,240.4L788.6,238.9L790.5,236.7L791.7,234.3L792.8,234.3L794.3,235.8L794.5,237.2L796.3,238L798.6,239L798.4,240.2L796.7,240.3L797.2,241.9Z","BN":"M788.6,238.9L788.5,240.4L788.5,242.4L787.2,242.3L786.7,243.3L785.4,241.7L786.4,240.5Z","SI":"M513,111.4L515,111.7L516.2,111L518.3,110.9L518.7,110.4L519.1,110.4L519.6,111.5L517.8,112.3L517.6,113.5L516.8,113.8L516.9,114.7L515.9,114.6L515.1,114.1L514.7,114.6L513,114.5L513.5,114.2L512.8,112.9Z","FI":"M538.1,47L538.2,48.8L541.7,50.6L540.2,52.6L543.2,55.7L542.2,58L544.5,60L544,61.8L547.5,63.7L547,65.1L545.3,66.7L541.3,70.3L537.4,70.5L533.7,71.6L530.2,72.2L528.7,70.6L526.5,69.7L526.6,67L525.2,64.4L526,62.8L527.7,61.1L532.1,58.1L533.4,57.6L533,56.4L529.9,55.1L529,54.1L528.3,50L524.9,48.2L521.9,46.9L523.1,46.2L525.5,47.6L528.2,47.5L530.5,48.1L532.2,46.9L532.8,45L535.8,44.1L538.6,45.2Z","SK":"M533.2,103.6L532.6,104.4L532.3,105.6L531.8,106L529.2,105L528.4,105.2L527.9,105.9L526.8,106.3L526.6,106.1L525.5,106.6L524.5,106.7L524.4,107.3L522.4,107.7L521.5,107.3L520.3,106.5L519.9,105.5L520.1,105.1L520.4,104.5L521.4,104.5L522.2,104.2L522.3,103.9L522.7,103.8L522.8,103.1L523.3,103L523.6,102.4L524.3,102.4L524.5,102.6L525.4,102.2L526.7,103.2L528,102.6L529.2,102.9L530.8,102.5Z","CZ":"M515,97.6L516.2,98.6L517.9,98.8L517.8,99.6L519.2,100.3L519.4,99.5L521.1,99.8L521.4,100.7L523.1,100.9L524.3,102.4L523.6,102.4L523.3,103L522.8,103.1L522.7,103.8L522.3,103.9L522.2,104.2L521.4,104.5L520.4,104.5L520.1,105.1L519,104.5L517.9,104.7L516,103.8L515.2,104L513.9,105.2L512.1,104.3L510.7,103L509.4,102.3L509.1,101L508.7,100.1L510.3,99.4L511.1,98.7L512.8,98.1L513.3,97.6L514,97.9Z","ER":"M576.6,211L576.2,209.8L577.2,205.2L577.3,203.1L578.1,202.2L580,201.7L581.3,199.9L583,203.5L583.9,206.4L585.4,207.9L589.1,210.8L590.7,212.6L592.2,214.4L593.1,215.4L594.4,216.4L593.7,217.1L592.5,216.9L591.6,215.9L590.4,214L589.2,213L588.5,212L586.1,210.7L584.3,210.7L583.6,210L582.1,210.8L580.4,209.4L579.7,211.7Z","JP":"M831.6,133.9L830.8,137.1L832.3,140.3L832.4,142.8L833.5,144.3L833.2,146.5L830.6,148L826.2,148.2L824,151.7L821.8,150.5L820.8,148.2L816.7,148.9L814.3,150.3L811.3,150.4L814.8,152.7L815,158L813.8,159.3L812.1,158.1L811.8,155.3L809.8,154.4L808,152.2L810.1,151.3L810.7,149.3L812.6,147.7L813.6,145.6L818.2,144.7L821.1,145.3L821.4,139.8L823.7,141.3L826,138.1L826.9,136.9L826.6,133.2L824.5,129.7L824.6,127.7L826.9,127.2L830.4,131.4ZM830.5,119.2L831.5,117.9L834,121.4L830.8,122.2L830.3,125.3L825.4,123.2L825.8,126.5L823.1,126.6L821.2,123.5L821.1,121.1L823.6,121L822,116.7L821.3,114.4L826,117.5L828.4,118.6ZM815.3,151.7L816,149.9L817.6,150.2L818.1,148.9L820.3,149.6L821,150.7L820.3,152.5L818.9,151.5L817.8,152.3L817.9,154.1L815.9,153.2Z","PY":"M327.3,318.3L328.2,320L328.5,324.3L331.3,324.9L332.3,324.2L334.1,325.1L334.7,326L335.3,328.9L335.7,330.1L336.7,330.2L337.6,329.7L338.6,330.3L338.8,332L338.7,333.8L338.4,335.6L338.3,338.4L336.2,340.8L334.2,341.3L331.3,340.8L328.6,340L330.5,335.2L330,333.8L327.1,332.6L323.7,330.3L321.5,329.8L316.1,324.8L316.7,321L316.6,319.4L317.6,316.6L322.1,315.7L324.5,315.8L327.1,317.3Z","YE":"M616.8,196.8L619.3,201.9L620.3,204.1L618.5,204.9L618,206.3L618.1,207.4L615.5,208.7L611.4,210.1L609.1,212.3L607.9,212.5L607.1,212.3L605.7,213.6L604,214.2L601.8,214.4L601.1,214.5L600.6,215.4L599.9,215.6L599.5,216.4L598.2,216.3L597.4,216.7L595.5,216.6L594.8,214.8L594.8,213.1L594.3,212.1L593.6,209.8L592.8,208.6L593.3,208.4L593,207L593.3,206.4L593.1,205L594.2,204L593.8,202.7L594.4,201.2L595.6,202L596.3,201.7L599.3,201.7L599.8,202L602.4,202.3L603.4,202.1L604.1,203.2L605.3,202.6L607,199.4L609.3,198Z","SA":"M569.7,164.5L572.6,165L573.7,164.1L574.2,162.9L576.1,162.5L576.4,161.5L577.2,160.9L574.4,157.8L579.3,156.3L579.7,155.8L582.9,156.6L586.9,158.8L594.8,165.1L599.6,165.3L602,165.6L602.8,167.1L604.6,167L605.9,169.7L607.3,170.4L607.8,171.5L609.7,172.8L610,174.1L609.9,175.2L610.3,176.2L611.2,177.1L611.6,178.1L612.1,178.9L612.9,179.5L613.6,179.3L614.2,180.5L614.4,181.2L615.7,184.3L623.7,185.9L624.2,185.3L625.6,187.5L624.5,193.7L616.8,196.8L609.3,198L607,199.4L605.3,202.6L604.1,203.2L603.4,202.1L602.4,202.3L599.8,202L599.3,201.7L596.3,201.7L595.6,202L594.4,201.2L593.8,202.7L594.2,204L593.1,205L592.7,203.7L591.8,202.8L591.5,201.5L590.1,200.4L588.5,197.8L587.6,195.3L585.7,193.1L584.5,192.6L582.5,189.7L582.1,187.5L582.1,185.7L580.3,182.2L579,181L577.6,180.3L576.6,178.6L576.6,177.8L575.8,176.2L575,175.5L573.8,173.2L572,170.7L570.5,168.6L569.2,168.6L569.5,166.9L569.5,165.8Z","CY":"M562.4,146.5L562.6,146.5L562.9,145.7L564.7,145.8L566.9,144.8L565.3,146.2L565.6,146.8L565.3,146.6L564.8,146.9L564.5,146.8L564.3,146.9L564.3,146.6L564.1,146.4L563.6,146.4L562.9,146.7ZM562.4,146.5L562.9,146.7L563.6,146.4L564.1,146.4L564.3,146.6L564.3,146.9L564.5,146.8L564.8,146.9L565.3,146.6L565.6,146.8L565.7,147L563.2,148.3L561.9,147.9L561.2,146.6Z","MA":"M474.5,146.4L475.5,148.4L475.6,150.3L476.5,153.6L477.1,154.3L476.7,155.5L473.3,156L472.2,157.1L470.7,157.4L470.6,159.7L467.6,161L466.6,162.5L464.5,163.4L461.9,163.8L457.7,166.1L457.6,169.8L457.3,169.8L457.3,171.5L455.7,171.6L454.8,172.3L453.7,172.3L452.7,171.9L450.5,172.2L449.6,174.7L448.8,174.9L447.5,178.8L443.8,182.2L442.8,186.5L441.7,187.9L441.4,189L435.5,189.3L435.4,189.3L435.6,187.8L436.6,187L437.5,185.3L437.4,184.3L438.4,182.1L439.9,180.1L440.8,179.6L441.5,177.8L441.6,176.1L442.6,174.2L444.4,173.1L446.1,169.9L446.2,169.8L447.5,168.6L449.9,168.3L452,166.2L453.3,165.3L455.5,162.7L454.9,158.8L456,156.2L456.4,154.5L458.1,152.4L460.6,151L462.5,149.7L464.3,146.5L465.1,144.6L467,144.6L468.4,145.9L470.8,145.7L473.4,146.4Z","EG":"M576.4,187.5L566.1,187.5L555.9,187.5L545.4,187.5L544.8,176L544.2,164.9L543.3,162.4L543.8,160.5L543.3,159.1L544.2,157.6L547.5,157.6L550.1,158.4L552.7,159.3L553.9,159.8L555.8,158.8L556.8,157.9L559,157.7L560.8,158.1L561.6,159.6L562.2,158.6L564.3,159.3L566.3,159.5L567.5,158.7L569.3,163.3L569.6,164.1L569,165.3L568.6,167.7L568.1,169.3L567.5,169.9L566.6,168.8L565.3,167.5L563.1,163L562.9,163.3L564.2,166.6L566,169.7L568.3,174.6L569.4,176.2L570.4,178L573,181.5L572.5,182L572.7,184L575.9,186.8Z","LY":"M545.4,187.5L545.7,193.7L542.6,193.7L542.7,195L532,189L521.4,183.1L518.8,184.8L517,185.9L515.4,184.2L511.3,182.9L510.1,180.9L508,179.5L506.8,180L505.8,178.3L505.7,177L504.1,174.7L505.1,173.4L504.9,171.4L505.2,169.7L504.9,168.3L505.3,165.8L505.2,164.3L504.3,161.6L505.5,160.8L505.7,159.5L505.4,158.2L507.1,157L507.9,156L509.1,155.1L509.1,152.7L512.2,153.8L513.2,153.5L515.4,154.1L518.8,155.5L520.1,158.2L522.4,158.8L526.1,160.1L528.9,161.7L530.1,160.9L531.2,159.4L530.5,157.1L531.2,155.5L533,154.1L534.7,153.7L538.2,154.3L539.1,155.7L540.1,155.7L540.9,156.2L543.5,156.6L544.2,157.6L543.3,159.1L543.8,160.5L543.3,162.4L544.2,164.9L544.8,176Z","ET":"M607.5,230.9L600.2,240.2L596.7,240.4L594.4,242.6L592.7,242.6L592,243.6L590.1,243.6L589,242.5L586.6,243.8L585.8,245.1L584,244.9L583.4,244.5L582.8,244.6L582,244.6L578.6,241.9L576.7,241.9L575.8,240.9L575.7,239.2L574.3,238.7L572.7,235.3L571.5,234.6L571,233.3L569.6,231.8L568,231.6L568.8,229.8L570.2,229.8L570.6,228.8L570.5,226L571.2,222.8L572.4,221.9L572.7,220.7L573.7,218.3L575.3,216.7L576.2,213.7L576.6,211L579.7,211.7L580.4,209.4L582.1,210.8L583.6,210L584.3,210.7L586.1,210.7L588.5,212L589.2,213L590.4,214L591.6,215.9L592.5,216.9L591.7,218.2L590.8,219.7L591.1,220.5L591.1,221.5L592.6,221.5L593.2,221.3L593.9,221.9L593.3,223L594.4,224.7L595.4,226.2L596.5,227.3L605.3,231Z","DJ":"M592.5,216.9L593.7,217.1L594.4,216.4L595.1,217.3L595.1,218.6L593.6,219.4L594.8,220.2L593.9,221.9L593.2,221.3L592.6,221.5L591.1,221.5L591.1,220.5L590.8,219.7L591.7,218.2Z","UG":"M570.7,258.7L565.3,258.9L562.4,258.9L561.4,259.2L559.8,260.2L559.2,259.9L559.2,257.5L559.8,256.4L560,253.9L560.5,252.4L561.5,250.8L562.6,250L563.4,248.9L562.4,248.5L562.5,244.9L563.6,244L565.3,244.7L567.4,244L569.3,244L570.9,242.6L572.2,244.7L572.6,246.3L573.8,249.8L572.8,252.1L571.5,254.1L570.7,255.4Z","RW":"M561.4,259.2L562.5,261L562.3,262.8L561.5,263.2L560.1,263L559.3,264.8L557.7,264.5L557.9,262.8L558.3,262.6L558.4,260.7L559.2,259.9L559.8,260.2Z","BA":"M525.3,123.2L523,122.1L522,120.8L521.1,120.1L519.9,119L519.3,118L518,116.6L518.4,115.3L519.3,116L519.8,115.4L520.9,115.3L523,115.8L524.7,115.8L525.9,116.5L526.7,116.5L526.2,117.8L527.5,119L527.2,120.4L526.7,120.6L526.2,120.8L525.5,121.6Z","MK":"M534.7,124.3L536,125.2L536.3,127.3L535.9,127.4L535.5,127.9L534.2,127.9L533.3,128.5L531.7,128.8L530.6,128.1L530.2,126.7L530.4,125.7L530.7,125.7L530.8,125.1L532.2,124.6L532.7,124.5L533.6,124.3Z","RS":"M525.2,113.3L527,112.5L528.5,112.6L529.9,113.8L530.2,114.8L531.7,115.5L532,116.7L533.5,117.6L534.2,116.9L534.9,117.3L534.3,117.8L534.8,118.4L534.3,119.1L534.6,120.2L535.9,121.5L535.1,122.5L534.7,123.5L535,123.8L534.7,124.3L533.6,124.3L532.7,124.5L532.6,124.3L532.9,123.9L533.1,123.1L532.8,123.2L532.2,122.6L531.8,122.4L531.5,122L531,121.8L530.6,121.3L530.2,121.5L529.9,122.5L529.4,122.7L529.6,122.5L528.6,121.8L527.8,121.5L527.4,121.1L526.7,120.6L527.2,120.4L527.5,119L526.2,117.8L526.7,116.5L525.9,116.5L526.7,115.3L525.9,114.4Z","ME":"M529,123.4L528.3,123.7L528.1,123.1L527.2,124.6L527.4,125.6L526.9,125.4L526.1,124.4L525,123.8L525.3,123.2L525.5,121.6L526.2,120.8L526.7,120.6L527.4,121.1L527.8,121.5L528.6,121.8L529.6,122.5L529.4,122.7Z","XK":"M530.4,125.7L530.2,124.6L529.6,124.3L529,123.4L529.4,122.7L529.9,122.5L530.2,121.5L530.6,121.3L531,121.8L531.5,122L531.8,122.4L532.2,122.6L532.8,123.2L533.1,123.1L532.9,123.9L532.6,124.3L532.7,124.5L532.2,124.6L530.8,125.1L530.7,125.7Z","TT":"M315.8,222.4L317.3,222L317.9,222.1L317.7,224.4L315.4,224.7L315,224.5L315.8,223.6Z","SS":"M562.5,244.9L560.1,242.8L559.5,241.5L558,242.1L556.7,241.9L556,242.4L554.8,242.1L553.2,239.5L552.7,238.5L550.7,237.3L550,235.4L548.9,234.1L547.1,232.5L547,231.5L545.6,230.2L543.7,229L544.5,228.7L545.4,228.1L546.1,225.3L546.8,223.9L548.7,223.5L549.2,224.3L550.6,226.1L551.3,226.4L552.3,225.9L554.2,226L554.6,226.6L557.2,226.6L557.3,226L558.6,225.4L558.9,224.5L559.9,223.8L562.2,225.6L563.5,225.3L564.8,223.1L566.2,221.4L565.9,219.5L565.3,218.6L566.9,218.5L567,217.8L568.3,218L568,220.3L568.4,222.5L569.8,223.7L570.2,224.8L570.2,226.3L570.5,226.4L570.6,228.8L570.2,229.8L568.8,229.8L568,231.6L569.6,231.8L571,233.3L571.5,234.6L572.7,235.3L574.3,238.7L572.6,240.7L570.9,242.6L569.3,244L567.4,244L565.3,244.7L563.6,244Z"}}, CNAMES = {"afghanistan":"AF","albania":"AL","algeria":"DZ","american samoa":"AS","andorra":"AD","angola":"AO","anguilla":"AI","antarctica":"AQ","antigua and barbuda":"AG","argentina":"AR","armenia":"AM","aruba":"AW","australia":"AU","austria":"AT","azerbaijan":"AZ","bahamas":"BS","bahrain":"BH","bangladesh":"BD","barbados":"BB","belarus":"BY","belgium":"BE","belize":"BZ","benin":"BJ","bermuda":"BM","bhutan":"BT","bolivia":"BO","bosnia and herzegovina":"BA","botswana":"BW","bouvet island":"BV","brazil":"BR","british indian ocean territory":"IO","brunei darussalam":"BN","bulgaria":"BG","burkina faso":"BF","burundi":"BI","cambodia":"KH","cameroon":"CM","canada":"CA","cape verde":"CV","cayman islands":"KY","central african republic":"CF","chad":"TD","chile":"CL","people's republic of china":"CN","china":"CN","christmas island":"CX","cocos (keeling) islands":"CC","colombia":"CO","comoros":"KM","republic of the congo":"CG","congo":"CD","democratic republic of the congo":"CD","cook islands":"CK","costa rica":"CR","cote d'ivoire":"CI","côte d'ivoire":"CI","ivory coast":"CI","croatia":"HR","cuba":"CU","cyprus":"CY","czech republic":"CZ","czechia":"CZ","denmark":"DK","djibouti":"DJ","dominica":"DM","dominican republic":"DO","ecuador":"EC","egypt":"EG","el salvador":"SV","equatorial guinea":"GQ","eritrea":"ER","estonia":"EE","ethiopia":"ET","falkland islands (malvinas)":"FK","faroe islands":"FO","fiji":"FJ","finland":"FI","france":"FR","french guiana":"GF","french polynesia":"PF","french southern territories":"TF","gabon":"GA","republic of the gambia":"GM","the gambia":"GM","gambia":"GM","georgia":"GE","germany":"DE","ghana":"GH","gibraltar":"GI","greece":"GR","greenland":"GL","grenada":"GD","guadeloupe":"GP","guam":"GU","guatemala":"GT","guinea":"GN","guinea-bissau":"GW","guyana":"GY","haiti":"HT","heard island and mcdonald islands":"HM","holy see (vatican city state)":"VA","honduras":"HN","hong kong":"HK","hungary":"HU","iceland":"IS","india":"IN","indonesia":"ID","islamic republic of iran":"IR","iran":"IR","iraq":"IQ","ireland":"IE","israel":"IL","italy":"IT","jamaica":"JM","japan":"JP","jordan":"JO","kazakhstan":"KZ","kenya":"KE","kiribati":"KI","north korea":"KP","south korea":"KR","korea, republic of":"KR","republic of korea":"KR","kuwait":"KW","kyrgyzstan":"KG","lao people's democratic republic":"LA","latvia":"LV","lebanon":"LB","lesotho":"LS","liberia":"LR","libya":"LY","liechtenstein":"LI","lithuania":"LT","luxembourg":"LU","macao":"MO","madagascar":"MG","malawi":"MW","malaysia":"MY","maldives":"MV","mali":"ML","malta":"MT","marshall islands":"MH","martinique":"MQ","mauritania":"MR","mauritius":"MU","mayotte":"YT","mexico":"MX","micronesia, federated states of":"FM","moldova, republic of":"MD","monaco":"MC","mongolia":"MN","montserrat":"MS","morocco":"MA","mozambique":"MZ","myanmar":"MM","namibia":"NA","nauru":"NR","nepal":"NP","netherlands":"NL","the netherlands":"NL","netherlands (kingdom of the)":"NL","new caledonia":"NC","new zealand":"NZ","nicaragua":"NI","niger":"NE","nigeria":"NG","niue":"NU","norfolk island":"NF","the republic of north macedonia":"MK","north macedonia":"MK","northern mariana islands":"MP","norway":"NO","oman":"OM","pakistan":"PK","palau":"PW","state of palestine":"PS","palestine":"PS","panama":"PA","papua new guinea":"PG","paraguay":"PY","peru":"PE","philippines":"PH","pitcairn":"PN","pitcairn islands":"PN","poland":"PL","portugal":"PT","puerto rico":"PR","qatar":"QA","reunion":"RE","romania":"RO","russian federation":"RU","russia":"RU","rwanda":"RW","saint helena":"SH","saint kitts and nevis":"KN","saint lucia":"LC","saint pierre and miquelon":"PM","saint vincent and the grenadines":"VC","samoa":"WS","san marino":"SM","sao tome and principe":"ST","saudi arabia":"SA","senegal":"SN","seychelles":"SC","sierra leone":"SL","singapore":"SG","slovakia":"SK","slovenia":"SI","solomon islands":"SB","somalia":"SO","south africa":"ZA","south georgia and the south sandwich islands":"GS","spain":"ES","sri lanka":"LK","sudan":"SD","suriname":"SR","svalbard and jan mayen":"SJ","eswatini":"SZ","sweden":"SE","switzerland":"CH","syrian arab republic":"SY","taiwan, province of china":"TW","taiwan":"TW","tajikistan":"TJ","united republic of tanzania":"TZ","tanzania":"TZ","thailand":"TH","timor-leste":"TL","togo":"TG","tokelau":"TK","tonga":"TO","trinidad and tobago":"TT","tunisia":"TN","türkiye":"TR","turkey":"TR","turkmenistan":"TM","turks and caicos islands":"TC","tuvalu":"TV","uganda":"UG","ukraine":"UA","united arab emirates":"AE","uae":"AE","united kingdom":"GB","uk":"GB","great britain":"GB","united states of america":"US","united states":"US","usa":"US","u.s.a.":"US","us":"US","u.s.":"US","united states minor outlying islands":"UM","uruguay":"UY","uzbekistan":"UZ","vanuatu":"VU","venezuela":"VE","vietnam":"VN","virgin islands, british":"VG","virgin islands, u.s.":"VI","wallis and futuna":"WF","western sahara":"EH","yemen":"YE","zambia":"ZM","zimbabwe":"ZW","åland islands":"AX","aland islands":"AX","bonaire, sint eustatius and saba":"BQ","curaçao":"CW","guernsey":"GG","isle of man":"IM","jersey":"JE","montenegro":"ME","saint barthélemy":"BL","saint martin (french part)":"MF","serbia":"RS","sint maarten (dutch part)":"SX","south sudan":"SS","kosovo":"XK","syria":"SY","laos":"LA","moldova":"MD"};
  function ccode(loc) {
    var id = String(loc.id || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(id)) return id;
    var m = /^([A-Z]{2})-/.exec(id); if (m) return m[1];
    return CNAMES[String(loc.name || '').toLowerCase()] || '';
  }
  function heat(t) {
    // dark blue to bright cyan-green, by share of the busiest country (log scale so small countries still show)
    var stops = [[18, 40, 92], [36, 99, 235], [56, 189, 248], [61, 220, 132]];
    var x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i, a = stops[i], b = stops[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }
  function worldMap(boxId, locs, unit) {
    var box = $(boxId); if (!box) return;
    var by = {}, max = 0, total = 0;
    (locs || []).forEach(function (l) { var c = ccode(l); if (!c || !(l.count > 0)) return; by[c] = { n: (by[c] ? by[c].n : 0) + l.count, name: l.name }; total += l.count; });
    Object.keys(by).forEach(function (c) { if (by[c].n > max) max = by[c].n; });
    var blk = box.closest('.blk'); if (blk) blk.classList.toggle('hidden', !max);
    if (!max) { box.innerHTML = ''; return; }
    var lm = Math.log(max + 1), h = '<svg viewBox="0 0 ' + WORLD.w + ' ' + WORLD.h + '" role="img" aria-label="Map of ' + unit + ' by country">';
    Object.keys(WORLD.p).forEach(function (c) {
      var v = by[c], fill = v ? heat(Math.log(v.n + 1) / lm) : '#141b2a';
      h += '<path d="' + WORLD.p[c] + '" fill="' + fill + '" data-c="' + c + '"' + (v ? ' class="hot"' : '') + '><title>' + esc((v ? v.name : c) + (v ? ': ' + fmt(v.n) + ' ' + unit : '')) + '</title></path>';
    });
    h += '</svg><div class="maptip" hidden></div><div class="maplegend"><span>1</span><i></i><span>' + fmt(max) + ' ' + esc(unit) + '</span></div>';
    box.innerHTML = h;
    var tip = box.querySelector('.maptip');
    function show(e) {
      var p = e.target.closest && e.target.closest('path[data-c]'); if (!p) { tip.hidden = true; return; }
      var c = p.getAttribute('data-c'), v = by[c];
      tip.innerHTML = '<b>' + esc(v ? v.name : (CNAMES_REV[c] || c)) + '</b>' + (v ? fmt(v.n) + ' ' + esc(unit) + ' · ' + Math.round(v.n / total * 100) + '%' : 'no ' + esc(unit));
      var r = box.getBoundingClientRect(), x = (e.clientX || 0) - r.left, y = (e.clientY || 0) - r.top;
      tip.style.left = Math.min(r.width - 150, Math.max(4, x + 12)) + 'px'; tip.style.top = Math.max(4, y - 44) + 'px'; tip.hidden = false;
    }
    box.onpointermove = show; box.onpointerdown = show; box.onpointerleave = function () { tip.hidden = true; };
  }
  var CNAMES_REV = {}; Object.keys(CNAMES).forEach(function (n) { var c = CNAMES[n]; if (!CNAMES_REV[c] || n.length < CNAMES_REV[c].length) CNAMES_REV[c] = n.replace(/\\b\\w/g, function (x) { return x.toUpperCase(); }); });

  // ---- small helpers for a calmer page ----
  // A card or block with nothing to show is hidden instead of showing a dash or an empty box.
  function hideEmptyCards(secId) {
    Array.prototype.forEach.call(document.querySelectorAll('section[data-sec="' + secId + '"] .card'), function (c) {
      if (c.hasAttribute('data-keep')) return;
      var v = c.querySelector('.value'); if (!v) return;
      var t = v.textContent.trim(); c.classList.toggle('hidden', t === '' || t === '-' || t === '0' || t === '0%');
    });
  }
  function spark(id, vals, color) {
    var el = $(id); if (!el) return;
    if (!vals || vals.length < 2) { el.innerHTML = ''; return; }
    var w = 120, h = 34, max = Math.max.apply(null, vals.concat([1])), n = vals.length;
    var pts = vals.map(function (v, i) { return (i * (w - 2) / (n - 1) + 1).toFixed(1) + ',' + (h - 2 - v / max * (h - 6)).toFixed(1); });
    el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="1,' + h + ' ' + pts.join(' ') + ' ' + (w - 1) + ',' + h + '" fill="' + color + '" opacity=".14"/><polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
  }
  // Hover or tap the chart to read a day's number.
  function chartHover(svg, days, X, Y, unit, d) {
    var box = svg.parentNode, tip = box.querySelector('.ctip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'ctip'; tip.hidden = true; box.appendChild(tip); }
    var mark = svg.querySelector('.cmark');
    function at(e) {
      var r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, x = ((e.clientX || 0) - r.left) / r.width * vb.width, best = 0, bd = 1e9;
      days.forEach(function (_, i) { var dx = Math.abs(X(i) - x); if (dx < bd) { bd = dx; best = i; } });
      var p = days[best]; if (!p) return;
      if (mark) { mark.setAttribute('x1', X(best)); mark.setAttribute('x2', X(best)); mark.style.display = ''; }
      var lab = d.range === 'today' ? (p.h % 12 || 12) + (p.h < 12 ? ' AM' : ' PM') + ' UTC' : dshort(p.day);
      tip.innerHTML = '<b>' + fmt(p.n) + '</b> ' + esc(unit) + '<span>' + esc(lab) + (p.built != null ? ' · ' + fmt(p.built) + ' built' : '') + '</span>';
      var px = X(best) / vb.width * r.width;
      tip.style.left = Math.max(4, Math.min(r.width - 140, px - 60)) + 'px'; tip.hidden = false;
    }
    svg.onpointermove = at; svg.onpointerdown = at;
    svg.onpointerleave = function () { tip.hidden = true; if (mark) mark.style.display = 'none'; };
  }
  // ---- plain names for where people come from ----
  // utm_source (where a tagged link was posted) and utm_campaign (which link) as you set them up.
  var SRC_NAMES = {
    'beatleader': 'Your BeatLeader profile', 'reesaber-studio': 'ReeSaber Studio', 'playlist-studio': 'Playlist Studio', 'hsv-generator': 'HSV Config Generator',
    'chesters-escape': 'Chester’s Escape', 'chester': 'Chester’s Escape', 'github': 'GitHub', 'share-link': 'Shared links', 'share': 'Shared links',
    'pwa': 'Installed Studio app', 'studio-sync': 'Studio Sync', 'review': 'Review visits (testing)', 'bplist': 'Playlist files', 'discord': 'Discord',
    'reddit': 'Reddit', 'youtube': 'YouTube', 'twitch': 'Twitch', 'x': 'X (Twitter)', 'twitter': 'X (Twitter)', 'bsmg': 'BSMG', 'goatcounter': 'GoatCounter'
  };
  var CAMP_NAMES = {
    'profile-bio': 'Link in your BeatLeader profile bio', 'cross-link': 'Links between your tools', 'site': 'Chester’s Escape footer links',
    'readme': 'README link', 'readme-playlist-studio': 'Playlist Studio README', 'readme-reesaber-studio': 'ReeSaber Studio README', 'readme-hsv-generator': 'HSV Config Generator README',
    'studio-sync-readme': 'Studio Sync README', 'studio-sync-launch': 'Studio Sync launch post', 'second-device': 'Studio Sync on another device (QR code)',
    'preset-share': 'Shared ReeSaber preset', 'playlist-share': 'Shared playlist link', 'stats-share': 'Shared Stats card', 'config-share': 'Shared HSV config',
    'installed': 'Opened from the installed app', 'open-file': 'Opened a .bplist in the app', 'playlist-credit': 'Credit in exported playlists',
    'get-the-maps': 'Chester’s Escape: Get the maps', 'get-the-maps-sync': 'Chester’s Escape: Get the maps with Studio Sync', 'bsr-link': 'Chester’s Escape: BSR link',
    'self-review-oct26': 'Review visit (Oct 26, testing)', 'newbie-review-oct26': 'New player review (Oct 26, testing)', 'launch': 'Launch post'
  };
  function campName(c) {
    c = String(c || '').toLowerCase();
    if (CAMP_NAMES[c]) return CAMP_NAMES[c];
    var m = /^footer-(.+)$/.exec(c); if (m) return 'Footer link on ' + (SRC_NAMES[m[1]] || m[1].replace(/-/g, ' '));
    m = /^readme-(.+)$/.exec(c); if (m) return (SRC_NAMES[m[1]] || m[1].replace(/-/g, ' ')) + ' README';
    return c ? c.replace(/[-_]+/g, ' ').replace(/^./, function (x) { return x.toUpperCase(); }) : '(no name)';
  }
  // Referring sites: [pattern, name, kind]. kind: search, ai, social, beat (Beat Saber sites), mine (your own pages), app
  var REF_RULES = [
    [/^gemini\\.google\\./, 'Gemini', 'ai'], [/^bard\\.google\\./, 'Gemini', 'ai'], [/(^|\\.)chatgpt\\.com$|^chat\\.openai\\.com$/, 'ChatGPT', 'ai'], [/(^|\\.)perplexity\\.ai$/, 'Perplexity', 'ai'],
    [/(^|\\.)claude\\.ai$/, 'Claude', 'ai'], [/^copilot\\.microsoft\\.com$/, 'Microsoft Copilot', 'ai'], [/(^|\\.)grok\\.com$/, 'Grok', 'ai'], [/(^|\\.)deepseek\\.com$/, 'DeepSeek', 'ai'],
    [/^news\\.google\\./, 'Google News', 'social'], [/^(www\\.)?google\\.|^google$/, 'Google search', 'search'], [/(^|\\.)bing\\.com$|^bing$/, 'Bing', 'search'], [/duckduckgo/, 'DuckDuckGo', 'search'],
    [/(^|\\.)yahoo\\./, 'Yahoo', 'search'], [/(^|\\.)yandex\\./, 'Yandex', 'search'], [/(^|\\.)ecosia\\./, 'Ecosia', 'search'], [/search\\.brave\\.com|^brave$/, 'Brave Search', 'search'],
    [/(^|\\.)startpage\\./, 'Startpage', 'search'], [/(^|\\.)baidu\\./, 'Baidu', 'search'], [/(^|\\.)qwant\\./, 'Qwant', 'search'], [/(^|\\.)naver\\./, 'Naver', 'search'],
    [/(^|\\.)reddit\\.com$|redd\\.it$|com\\.reddit\\.frontpage/, 'Reddit', 'social'], [/discord(app)?\\.(com|gg)$|com\\.discord/, 'Discord', 'social'], [/(^|\\.)youtube\\.com$|youtu\\.be$/, 'YouTube', 'social'],
    [/(^|\\.)twitch\\.tv$/, 'Twitch', 'social'], [/(^|\\.)(x|twitter)\\.com$|^t\\.co$/, 'X (Twitter)', 'social'], [/(^|\\.)facebook\\.com$|^fb\\./, 'Facebook', 'social'], [/(^|\\.)instagram\\.com$/, 'Instagram', 'social'],
    [/(^|\\.)tiktok\\.com$/, 'TikTok', 'social'], [/(^|\\.)bsky\\.app$/, 'Bluesky', 'social'], [/com\\.google\\.android\\.gm/, 'Gmail app', 'app'], [/(^|\\.)mail\\.google\\.com$/, 'Gmail', 'app'],
    [/(^|\\.)beatleader\\.(com|xyz|net)$/, 'BeatLeader', 'beat'], [/(^|\\.)beatsaver\\.com$/, 'BeatSaver', 'beat'], [/(^|\\.)scoresaber\\.com$/, 'ScoreSaber', 'beat'], [/(^|\\.)accsaber\\.com$/, 'AccSaber', 'beat'],
    [/(^|\\.)bsmg\\.wiki$/, 'BSMG wiki', 'beat'], [/(^|\\.)givemepp\\.com$/, 'givemepp', 'beat'], [/(^|\\.)github\\.com$/, 'GitHub', 'social'], [/spanky3651\\.github\\.io/, 'Your other tools', 'mine'],
    [/(^|\\.)mickool\\.net$/, 'mickool.net', 'mine'], [/^(localhost|127\\.0\\.0\\.1)/, 'Local testing', 'mine'], [/workers\\.dev$/, 'Your Worker', 'mine']
  ];
  function refInfo(r) {
    var raw = String((r && r.name) || ''), host = raw.replace(/^[a-z-]+:\\/\\//i, '').replace(/\\/.*$/, '').toLowerCase();
    if (r && r.scheme === 'c') return { label: SRC_NAMES[host] || raw.replace(/[-_]+/g, ' '), kind: 'link', raw: raw };
    for (var i = 0; i < REF_RULES.length; i++) if (REF_RULES[i][0].test(host)) return { label: REF_RULES[i][1], kind: REF_RULES[i][2], raw: raw };
    return { label: host.replace(/^www\\./, '') || 'Unknown', kind: 'other', raw: raw };
  }
  function nameRow(label, raw, cls, n) {
    return ['<span class="fl"><b>' + esc(label) + '</b>' + (raw && String(raw).toLowerCase() !== String(label).toLowerCase() ? '<span class="fd"><code>' + esc(raw) + '</code></span>' : '') + '</span>', n, cls || ''];
  }
  function campRow(c) { return nameRow(campName(c.name), c.name, 'g', c.count); }
  function pageRow(p, home) { var x = p.path || '/', nm = pageName(x, home); return nm === x ? ['<span class="mono">' + esc(x) + '</span>', p.count] : nameRow(nm, x, '', p.count); }
  function refSum(refs, test) { return refs.reduce(function (a, r) { return a + (test(refInfo(r).kind) ? r.count : 0); }, 0); }
  function refRow(r, cls) {
    var f = refInfo(r);
    return ['<span class="fl"><b>' + esc(f.label) + '</b>' + (f.raw && f.raw.toLowerCase() !== f.label.toLowerCase() ? '<span class="fd"><code>' + esc(f.raw) + '</code></span>' : '') + '</span>', r.count, cls || ''];
  }
  // Pages people land on in Studio.
  function pageName(p, home) {
    var x = String(p || '').replace(/^\\/(playlist-studio|reesaber-studio|hsv-config-generator)(?=\\/|\\?|#|$)/i, '') || '/';
    if (x === '/' || x === '' || /^\\/(index\\.html)?(\\?|$)/.test(x) && !/stats=|#p=|bsr=|cfg=|preset=/.test(x)) return home || 'Playlist Studio home';
    if (/^\\/gallery/.test(x)) return 'Saber gallery';
    if (/^\\/docs/.test(x)) { var t = x.replace(/^\\/docs\\/?/, '').replace(/\\.html$/, '').replace(/[-_\\/]+/g, ' ').trim(); return t ? 'Docs: ' + t : 'Docs'; }
    if (/stats=/.test(x)) return 'A shared Stats card';
    if (/#p=|[?&]p=/.test(x)) return 'A shared playlist link';
    if (/studio-sync/.test(x)) return 'Studio Sync setup';
    if (/bsr=/.test(x)) return 'A map link (BSR code)';
    if (/gallery/.test(x)) return 'Playlist gallery';
    return x;
  }

  // ---- your other tools (more GoatCounter sites under the same key) ----
  // Events shared by the tools: Quest over USB, share links, footer links, page errors.
  var TOOL_COMMON = {
    'quest-open': ['Quest', 'Opened Send to Quest', 'Opened the Quest over USB panel'],
    'quest-connect': ['Quest', 'Connected a Quest', 'Connected their headset over USB'],
    'quest-auth-wait': ['Quest', 'Allow USB on headset', 'Had to allow USB debugging inside the headset'],
    'quest-picker-cancel': ['Quest', 'Closed the USB picker', 'Closed the device picker without choosing a headset'],
    'quest-diag': ['Quest', 'USB help', 'Opened the USB troubleshooting help'],
    'quest-load': ['Quest', 'Loaded from Quest', 'Loaded what was already on the headset'],
    'quest-push': ['Quest', 'Sent to Quest', 'Sent their work straight to the headset'],
    'quest-cancel': ['Quest', 'Cancelled a Quest send', 'Backed out of sending to the headset'],
    'quest-no-answer': ['Problems', 'Quest didn’t answer', 'The headset didn’t answer over USB'],
    'quest-error-load': ['Problems', 'Couldn’t load from Quest', 'Reading from the headset failed'],
    'quest-error-push': ['Problems', 'Couldn’t send to Quest', 'Writing to the headset failed'],
    'quest-error-no-folder': ['Problems', 'Mod folder missing', 'The mod’s folder wasn’t on the headset yet'],
    'share-link': ['Sharing', 'Made a share link', 'Copied a link to their work'],
    'share-open': ['Sharing', 'Opened a share link', 'Opened something someone shared with them'],
    'github-click': ['Links', 'GitHub link', 'Clicked through to the source on GitHub'],
    'kofi-click': ['Links', 'Support me link', 'Clicked the Support me (Ko-fi) button'],
    'js-error': ['Problems', 'Page error', 'A script error on the page'],
    'js-error-promise': ['Problems', 'Page error (async)', 'A script error from a background task'],
    'whatsnew-shown': ['Start', 'Saw What’s New', 'The What’s New note popped up'],
    'whatsnew-close': ['Start', 'Closed What’s New', 'Closed the What’s New note']
  };
  var HSV_FEAT = {
    'welcome-start': ['Start', 'Started from welcome', 'Clicked start on the welcome screen'],
    'template-*': ['Start', 'Started from a template', 'Loaded a starter template'],
    'export': ['Export', 'Exported a config', 'Downloaded the config as a .json file'],
    'export-hsv': ['Export', 'Exported as .hsv', 'Downloaded the config as a .hsv file'],
    'export-steps-off': ['Export', 'Skipped export steps', 'Turned off the how-to steps after exporting'],
    'copy-json': ['Export', 'Copied JSON', 'Copied the config JSON to the clipboard'],
    'export-with-errors': ['Problems', 'Exported with errors', 'Exported even though the checker found problems'],
    'import': ['Import', 'Imported a config', 'Opened a config file with Import'],
    'drop-import': ['Import', 'Dropped a config', 'Dragged a config file onto the page'],
    'apply-json': ['Import', 'Applied pasted JSON', 'Pasted config JSON and applied it'],
    'reset': ['Editing', 'Loaded the HSV default', 'Reset to the official HSV default config'],
    'redo': ['Editing', 'Used redo', 'Used redo (counted once a visit)'],
    'tier-style': ['Editing', 'Styled a tier', 'Changed how a judgment tier looks (once a visit)'],
    'token-insert': ['Editing', 'Inserted a text token', 'Added a token like %s or %n to judgment text'],
    'assume-max': ['Editing', 'Assume max post swing', 'Turned on assume max post swing'],
    'chains-on': ['Editing', 'Chain head judgments', 'Turned on separate judgments for chain heads'],
    'chain-link-on': ['Editing', 'Chain link display', 'Turned on a display for chain links'],
    'compact-view': ['Layout', 'Compact view', 'Switched to the compact editor view'],
    'stream': ['Preview', 'Played the preview', 'Played the live stream of judgments'],
    'vision-*': ['Preview', 'Color vision preview', 'Previewed the config with a color vision filter'],
    'compare': ['Compare', 'Compared configs', 'Pinned a version or loaded a second config to compare'],
    'replay-analyze': ['Replays', 'Analyzed a replay', 'Loaded a BeatLeader replay to fit tiers to their swings'],
    'drop-replay': ['Replays', 'Dropped a replay', 'Dragged a .bsor replay onto the page'],
    'replay-even': ['Replays', 'Even tiers from replay', 'Spread the tiers evenly across their replay scores'],
    'replay-even-preview': ['Replays', 'Previewed even tiers', 'Previewed evenly spread tiers on the stream'],
    'share-link': ['Sharing', 'Made a share link', 'Copied a link to their config'],
    'share-open': ['Sharing', 'Opened a shared config', 'Opened a config someone shared']
  };
  var RS_FEAT = {
    'starter-*': ['Start', 'Started from a starter', 'Picked a starter saber'],
    'starter-drivers': ['Start', 'Starter with drivers', 'Picked a starter that uses drivers'],
    'guide-open': ['Start', 'Opened the guide', 'Opened the built-in guide'],
    'guide-from-*': ['Start', 'Guide opened from', 'Opened the guide from another spot'],
    'explain': ['Start', 'Explain this', 'Asked the editor to explain a setting'],
    'new-preset': ['Editing', 'New preset', 'Started a new saber preset'],
    'module-*': ['Editing', 'Added a module', 'Added a module to the saber'],
    'add-menu-open': ['Editing', 'Opened Add menu', 'Opened the Add menu'],
    'snippet-*': ['Editing', 'Used a snippet', 'Inserted a ready-made snippet'],
    'scheme-*': ['Editing', 'Color scheme', 'Changed the color scheme'],
    'gradient-edit': ['Editing', 'Edited a gradient', 'Edited a color gradient'],
    'curve-edit': ['Editing', 'Edited a curve', 'Edited an animation curve'],
    'driver-add': ['Editing', 'Added a driver', 'Added a driver to animate a value'],
    'driver-delete': ['Editing', 'Removed a driver', 'Deleted a driver'],
    'driver-scrub': ['Editing', 'Scrubbed a driver', 'Dragged through a driver’s values'],
    'layer-copy': ['Layers', 'Copied a layer', 'Copied a layer'],
    'layer-paste': ['Layers', 'Pasted a layer', 'Pasted a layer'],
    'layer-duplicate': ['Layers', 'Duplicated a layer', 'Duplicated a layer'],
    'layer-drag': ['Layers', 'Dragged a layer', 'Reordered layers by dragging'],
    'layer-move-in': ['Layers', 'Moved into a group', 'Moved a layer into a group'],
    'layer-move-out': ['Layers', 'Moved out of a group', 'Moved a layer out of a group'],
    'layer-solo': ['Layers', 'Solo layer', 'Showed one layer on its own'],
    'texture-make': ['Textures', 'Made a texture', 'Generated a texture'],
    'texture-resize': ['Textures', 'Resized a texture', 'Resized a texture'],
    'sprite-sheet': ['Textures', 'Sprite sheet', 'Built a sprite sheet'],
    'asset-upload-*': ['Textures', 'Uploaded an asset', 'Uploaded an image or other asset'],
    'assets': ['Textures', 'Opened assets', 'Opened the assets panel'],
    'undo': ['Editing', 'Used undo', 'Used undo'],
    'redo': ['Editing', 'Used redo', 'Used redo'],
    'history-open': ['Editing', 'Opened history', 'Opened the edit history'],
    'checkpoint-save': ['Editing', 'Saved a checkpoint', 'Saved a checkpoint to come back to'],
    'checkpoint-restore': ['Editing', 'Restored a checkpoint', 'Went back to a saved checkpoint'],
    'validate-jump': ['Editing', 'Jumped to a problem', 'Clicked a checker warning to jump to it'],
    'perf-target-*': ['Editing', 'Performance target', 'Picked a performance target'],
    'preview-*': ['Preview', 'Preview setting', 'Changed a preview setting'],
    'preview-combine': ['Preview', 'Combined preview', 'Previewed both sabers together'],
    'preview-expand': ['Preview', 'Expanded preview', 'Made the preview bigger'],
    'preview-frame': ['Preview', 'Preview frame', 'Stepped the preview by a frame'],
    'preview-left-preset': ['Preview', 'Left saber preset', 'Picked a different preset for the left saber'],
    'preview-resize': ['Preview', 'Resized preview', 'Resized the preview'],
    'backdrop-*': ['Preview', 'Preview backdrop', 'Changed the preview backdrop'],
    'capture-open': ['Preview', 'Opened capture', 'Opened the capture tools'],
    'compare-open': ['Compare', 'Opened compare', 'Opened compare'],
    'compare-pin': ['Compare', 'Pinned a version', 'Pinned a version to compare'],
    'compare-preview': ['Compare', 'Previewed compare', 'Previewed the compared version'],
    'compare-revert': ['Compare', 'Reverted to pinned', 'Went back to the pinned version'],
    'view-*': ['Layout', 'Switched view', 'Switched editor view'],
    'view-menu-open': ['Layout', 'Opened View menu', 'Opened the View menu'],
    'tab-*': ['Layout', 'Switched tab', 'Switched panel tab'],
    'export': ['Export', 'Opened Export', 'Clicked the Export button'],
    'export-more-open': ['Export', 'More export options', 'Opened the extra export options'],
    'export-reesaber': ['Export', 'Exported for ReeSaber', 'Downloaded the saber for the ReeSaber mod'],
    'export-json': ['Export', 'Exported JSON', 'Downloaded the saber as JSON'],
    'export-project': ['Export', 'Exported a project', 'Downloaded the whole project'],
    'export-all-zip': ['Export', 'Exported everything (zip)', 'Downloaded every preset in a zip'],
    'export-png': ['Export', 'Exported a picture', 'Saved a PNG of the saber'],
    'export-gif': ['Export', 'Exported a GIF', 'Saved an animated GIF of the saber'],
    'export-thumb': ['Export', 'Exported a thumbnail', 'Saved a thumbnail picture'],
    'export-quest': ['Export', 'Export to Quest', 'Picked the Quest export'],
    'copy-json': ['Export', 'Copied JSON', 'Copied the saber JSON'],
    'folder-save': ['Export', 'Saved to a folder', 'Saved into a folder on their computer'],
    'folder-sync-on': ['Export', 'Folder sync on', 'Turned on syncing with a folder'],
    'import': ['Import', 'Opened Import', 'Clicked the Import button'],
    'import-preset': ['Import', 'Imported a preset', 'Imported a saber preset'],
    'import-project-*': ['Import', 'Imported a project', 'Imported a whole project'],
    'import-reesaber': ['Import', 'Imported a ReeSaber file', 'Imported a saber made for the ReeSaber mod'],
    'drop-import': ['Import', 'Dropped a file', 'Dragged a file onto the page'],
    'drop-saber-file': ['Import', 'Dropped a saber file', 'Dragged a saber file onto the page'],
    'open-src': ['Import', 'Opened a source', 'Opened the source of a saber'],
    'gallery-browse': ['Gallery', 'Browsed the gallery', 'Browsed the saber gallery'],
    'gallery-open': ['Gallery', 'Opened a gallery saber', 'Opened a saber from the gallery'],
    'gallery-submit-link': ['Gallery', 'Submit to gallery', 'Clicked the link to submit a saber'],
    'share-link': ['Sharing', 'Made a share link', 'Copied a link to their saber'],
    'share-open': ['Sharing', 'Opened a shared saber', 'Opened a saber someone shared']
  };
  var TOOLS = {
    hsv: { p: 'h', code: 'hsv-generator', name: 'HSV Config Generator', home: 'HSV Config Generator home', feat: HSV_FEAT },
    rs: { p: 'r', code: 'reesaberstudio', name: 'ReeSaber Studio', home: 'ReeSaber Studio home', feat: RS_FEAT }
  };
  var TPROB = /(^js-error|error|fail|no-answer)/;
  function toolFeat(t, name) {
    var tab = Object.assign({}, TOOL_COMMON, TOOLS[t].feat), x = tab[name], rest = '';
    if (!x) { var best = ''; Object.keys(tab).forEach(function (k) { if (k.slice(-1) === '*' && name.indexOf(k.slice(0, -1)) === 0 && k.length > best.length) best = k; }); if (best) { x = tab[best]; rest = name.slice(best.length - 1).replace(/^-/, ''); } }
    if (!x) return { area: TPROB.test(name) ? 'Problems' : 'Other', label: name.replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }), desc: '', name: name };
    return { area: x[0], label: x[1] + (rest ? ': ' + rest.replace(/-/g, ' ') : ''), desc: x[2], name: name };
  }
  function toolFeatRow(t, e, cls) {
    var f = toolFeat(t, e.name);
    return ['<span class="fl"><b>' + esc(f.label) + '</b><span class="fd">' + esc(f.desc ? f.desc : f.area) + '<span class="fdc"> · <code>' + esc(e.name) + '</code></span></span></span>', e.count, cls || ''];
  }
  function isTool(t) { return !!TOOLS[t]; }
  function ownTab(t) { return t === 'bl' || t === 'sync' || isTool(t); }
  var toolData = {}, toolBusy = {}, toolTok = {};
  function toolIds(t) { var p = TOOLS[t].p; return { svg: p + '-chart', head: p + '-charth', what: 'Visitors', dots: false }; }
  function toolMsg(t, h) { var el = $(TOOLS[t].p + '-msg'); el.innerHTML = h; el.classList.toggle('hidden', !h); }
  function loadTool(t, fresh) {
    var key = getKey(); if (!key || !TOOLS[t]) return;
    var tok = toolTok[t] = (toolTok[t] || 0) + 1, want = range, T = TOOLS[t];
    toolBusy[t] = true; if (!toolData[t]) toolMsg(t, 'Loading ' + esc(T.name) + '...'); busyUi();
    fetch('/admin/gc?site=' + t + '&range=' + encodeURIComponent(want) + (fresh ? '&fresh=1' : ''), { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      if (tok !== toolTok[t]) return;
      toolBusy[t] = false; busyUi();
      if (!res.ok) {
        if (res.status === 401) { setKey(''); signedIn(false); say(res.j.error || 'Wrong key', true); return; }
        toolMsg(t, res.j.setup ? '<b>GoatCounter isn’t connected yet.</b> Add GC_TOKEN to the Worker first (see the Visitors tab).' : esc(res.j.error || 'Couldn’t load ' + T.name + '.'));
        return;
      }
      toolData[t] = res.j; toolMsg(t, ''); renderTool(t);
    }).catch(function () { if (tok !== toolTok[t]) return; toolBusy[t] = false; busyUi(); toolMsg(t, 'Couldn’t reach the Worker.'); });
  }
  function renderTool(t) {
    var d = toolData[t], T = TOOLS[t], p = T.p; if (!d) return;
    function id(x) { return p + '-' + x; }
    txt(id('vis'), fmt(d.visitors));
    if (d.prevVisitors != null && d.prevVisitors > 0) { var ch = Math.round((d.visitors - d.prevVisitors) / d.prevVisitors * 100); $(id('visn')).innerHTML = '<span class="' + (ch >= 0 ? 'up' : 'down') + '">' + (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch) + '%</span> vs the ' + ({ today: 'day', '7d': '7 days', '30d': '30 days', '90d': '90 days' }[d.range] || 'period') + ' before'; }
    else txt(id('visn'), d.range === 'all' ? 'since ' + dshort(d.start) : d.range === 'today' ? 'so far today' : dshort(d.start) + ' to ' + dshort(d.end));
    var last = d.days.length ? d.days[d.days.length - 1] : null, best = null;
    d.days.forEach(function (x) { if (!best || x.n > best.n) best = x; });
    txt(id('best'), best && best.n ? fmt(best.n) : '-'); txt(id('bestn'), best && best.n ? dshort(best.day) : 'no visitors yet');
    var evs = (d.events || []).filter(function (e) { return e.count > 0; }).sort(function (a, b) { return b.count - a.count; });
    var probs = evs.filter(function (e) { return toolFeat(t, e.name).area === 'Problems'; }), use = evs.filter(function (e) { return toolFeat(t, e.name).area !== 'Problems'; });
    txt(id('act'), d.visitors ? Math.round(Math.min(d.eventVisitors || 0, d.visitors) / d.visitors * 100) + '%' : '-');
    txt(id('actn'), fmt(d.eventVisitors || 0) + ' visitors did more than look');
    var dev = devSplit(d.sizes), known = dev.Phone + dev.Tablet + dev.Computer;
    txt(id('phone'), known ? Math.round(dev.Phone / known * 100) + '%' : '-');
    chart(d, null, toolIds(t));
    spark(id('spark'), d.range === 'today' ? ((last || {}).hourly || []) : d.days.map(function (x) { return x.n; }), '#3ddc84');
    var more = $(id('more')), all = more.getAttribute('data-all') === '1';
    bars(id('feat'), (all ? use : use.slice(0, 15)).map(function (e) { return toolFeatRow(t, e); }));
    more.classList.toggle('hidden', use.length <= 15); more.textContent = all ? 'Show fewer' : 'Show all ' + use.length;
    bars(id('probs'), probs.map(function (e) { return toolFeatRow(t, e, 'alt'); }));
    var refs = d.refs || [], links = refs.filter(function (r) { return r.scheme === 'c' && r.name; }), sites = refs.filter(function (r) { return r.scheme !== 'c' && r.name; });
    bars(id('srcs'), links.map(function (r) { return refRow(r, 'g'); }));
    bars(id('camps'), (d.campaigns || []).filter(function (c) { return c.count > 0; }).map(campRow));
    bars(id('refs'), sites.map(function (r) { return refRow(r); }));
    bars(id('pages'), (d.pages || []).slice(0, 10).map(function (x) { return pageRow(x, T.home); }));
    worldMap(id('map'), d.locations, 'visitors');
    bars(id('geo'), (d.locations || []).filter(function (s) { return s.count > 0; }).slice(0, 8).map(function (s) { return [esc(s.name && !/unknown/i.test(s.name) ? s.name : 'Unknown'), s.count]; }));
    bars(id('dev'), [['Phone', dev.Phone, 'a'], ['Computer', dev.Computer], ['Tablet or small laptop', dev.Tablet, 'g'], ['Unknown', dev.Unknown, '']].filter(function (r) { return r[1] > 0; }));
    hideEmptyCards(t);
    txt(id('when'), 'GoatCounter (' + (d.code || T.code) + ') ' + dshort(d.start) + (d.start !== d.end ? ' to ' + dshort(d.end) : '') + '. Updated ' + new Date(d.generated * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ', kept for 5 minutes.');
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
    var gid = 'ga' + ids.svg;
    g = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f7bff" stop-opacity=".35"/><stop offset="1" stop-color="#2f7bff" stop-opacity="0"/></linearGradient></defs>' + g;
    g += '<path d="' + path(days.map(function (x) { return x.n; })) + ' L' + X(n - 1).toFixed(1) + ' ' + Y(0).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z" fill="url(#' + gid + ')"/>';
    g += '<path d="' + path(days.map(function (x) { return x.n; })) + '" fill="none" stroke="#2f7bff" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    g += '<line class="cmark" x1="0" x2="0" y1="12" y2="' + (H - 12) + '" stroke="#5aa0ff" stroke-width="1" style="display:none"/>';
    if (d.range !== 'today' && built) g += '<path d="' + path(days.map(function (x) { return Math.min(x.n, built[x.day] || 0); })) + '" fill="none" stroke="#3ddc84" stroke-width="3" vector-effect="non-scaling-stroke"/>';
    var labs = d.range === 'today' ? [[0, '12 AM'], [12, '12 PM'], [n - 1, (n - 1) + ':00']] : [[0, dshort(days[0].day)], [Math.floor((n - 1) / 2), dshort(days[Math.floor((n - 1) / 2)].day)], [n - 1, dshort(days[n - 1].day)]];
    labs.forEach(function (l, j) { g += '<text x="' + X(l[0]) + '" y="' + (H + 16) + '" fill="#9aa6b8" font-size="12" text-anchor="' + (j === 0 ? 'start' : j === 2 ? 'end' : 'middle') + '">' + esc(l[1]) + '</text>'; });
    svg.innerHTML = g;
    if (ids.leg) $(ids.leg).classList.toggle('hidden', !pushes.length);
    days.forEach(function (x) { x.built = d.range !== 'today' && built ? Math.min(x.n, built[x.day] || 0) : null; });
    chartHover(svg, days, X, Y, ids.what.toLowerCase(), d);
  }
  // ---- BeatLeader profile (second GoatCounter site) ----
  var bl = null, blBusy = false, BLIDS = { svg: 'b-chart', head: 'b-charth', what: 'Views', dots: false };
  function devSplit(sizes) { var dev = { Phone: 0, Tablet: 0, Computer: 0, Unknown: 0 }; (sizes || []).forEach(function (s) { var n = s.name.toLowerCase(); dev[/phone/.test(n) && !/tablet/.test(n) ? 'Phone' : /phone|tablet/.test(n) ? 'Tablet' : /monitor|computer|laptop|desktop/.test(n) ? 'Computer' : 'Unknown'] += s.count; }); return dev; }
  function bMsg(t) { var el = $('b-msg'); el.innerHTML = t; el.classList.toggle('hidden', !t); }
  function loadBl(fresh) {
    var key = getKey(); if (!key) return;
    var tok = ++blTok, want = range;
    blBusy = true; if (!bl) bMsg('Loading your BeatLeader profile views...'); busyUi();
    fetch('/admin/gc?site=bl&range=' + encodeURIComponent(want) + (fresh ? '&fresh=1' : ''), { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      if (tok !== blTok) return;
      blBusy = false; busyUi();
      if (!res.ok) {
        if (res.status === 401) { setKey(''); signedIn(false); say(res.j.error || 'Wrong key', true); return; }
        bMsg(res.j.setup ? '<b>GoatCounter isn\\u2019t connected yet.</b> Add GC_TOKEN to the Worker first (see the Visitors tab).' : esc(res.j.error || 'Couldn\\u2019t load the BeatLeader profile site.'));
        return;
      }
      bl = res.j; bMsg(''); renderBl();
    }).catch(function () { if (tok !== blTok) return; blBusy = false; busyUi(); bMsg('Couldn\\u2019t reach the Worker.'); });
  }
  function renderBl() {
    var d = bl;
    txt('b-vis', fmt(d.visitors));
    if (d.prevVisitors != null && d.prevVisitors > 0) { var ch = Math.round((d.visitors - d.prevVisitors) / d.prevVisitors * 100); $('b-visn').innerHTML = '<span class="' + (ch >= 0 ? 'up' : 'down') + '">' + (ch >= 0 ? '\\u25B2 ' : '\\u25BC ') + Math.abs(ch) + '%</span> vs the ' + ({ today: 'day', '7d': '7 days', '30d': '30 days', '90d': '90 days' }[d.range] || 'period') + ' before'; }
    else txt('b-visn', d.range === 'all' ? 'since ' + dshort(d.start) : d.range === 'today' ? 'so far today' : dshort(d.start) + ' to ' + dshort(d.end));
    var last = d.days.length ? d.days[d.days.length - 1] : null, best = null;
    d.days.forEach(function (x) { if (!best || x.n > best.n) best = x; });
    txt('b-tod', fmt(last ? last.n : 0)); txt('b-todn', 'views so far, UTC day');
    txt('b-best', best && best.n ? fmt(best.n) : '-'); txt('b-bestn', best && best.n ? dshort(best.day) : 'no views yet');
    var dev = devSplit(d.sizes), known = dev.Phone + dev.Tablet + dev.Computer;
    txt('b-phone', known ? Math.round(dev.Phone / known * 100) + '%' : '-');
    chart(d, null, BLIDS);
    spark('b-spark', d.range === 'today' ? ((d.days[d.days.length - 1] || {}).hourly || []) : d.days.map(function (x) { return x.n; }), '#3ddc84');
    worldMap('b-map', d.locations, 'views');
    var PAGES = { '/msploit-profile': 'Your BeatLeader profile' };
    bars('b-pages', (d.pages || []).map(function (p) { var nm = PAGES[p.path] || p.title || p.path; return ['<span class="fl"><b>' + esc(nm) + '</b><span class="fd"><code>' + esc(p.path) + '</code></span></span>', p.count]; }), '', 'No profile views in this range.');
    bars('b-refs', (d.refs || []).filter(function (r) { return r.name; }).map(function (r) { return refRow(r, r.scheme === 'c' ? 'g' : ''); }), '', 'No referrers in this range.');
    renderGeo(d);
    bars('b-dev', [['Phone', dev.Phone, 'a'], ['Computer', dev.Computer], ['Tablet or small laptop', dev.Tablet, 'g'], ['Unknown', dev.Unknown, '']].filter(function (r) { return r[1] > 0; }));
    $('b-geoh').classList.toggle('hidden', !(d.locations || []).some(function (c) { return c.count > 0; }));
    hideEmptyCards('bl');
    $('b-geo').classList.toggle('hidden', !(d.locations || []).some(function (c) { return c.count > 0; }));
    $('b-geonote').classList.toggle('hidden', !(d.locations || []).some(function (c) { return c.count > 0; }));
    txt('b-when', 'GoatCounter (blprofile) ' + dshort(d.start) + (d.start !== d.end ? ' to ' + dshort(d.end) : '') + '. Updated ' + new Date(d.generated * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ', kept for 5 minutes.');
  }
  function renderGeo(d) {
    var locs = (d.locations || []).filter(function (c) { return c.count > 0; }), el = $('b-geo'), all = [], known = false;
    txt('b-ncty', fmt(locs.filter(function (c) { return c.name && !/unknown/i.test(c.name); }).length));
    if (!locs.length) { el.innerHTML = '<p class="empty">No views in this range.</p>'; txt('b-tcty', '-'); txt('b-tctyn', ''); txt('b-treg', '-'); txt('b-tregn', ''); $('b-regs').innerHTML = '<p class="empty">No views in this range.</p>'; txt('b-geonote', ''); return; }
    var max = Math.max.apply(null, locs.map(function (c) { return c.count; }).concat([1])), top = locs[0];
    txt('b-tcty', top.name || 'Unknown'); txt('b-tctyn', fmt(top.count) + ' views \\u00b7 ' + Math.round(top.count / Math.max(1, d.visitors) * 100) + '% of all');
    el.innerHTML = locs.map(function (c, i) {
      var regs = (c.regions || []).filter(function (r) { return r.count > 0; }), real = regs.filter(function (r) { return r.name && !/unknown/i.test(r.name); });
      if (real.length) known = true;
      regs.forEach(function (r) { if (r.name && !/unknown/i.test(r.name)) all.push({ name: r.name, country: c.name, count: r.count }); });
      var row = '<div class="bar"><span class="lab">' + esc(c.name && !/unknown/i.test(c.name) ? c.name : 'Unknown') + '</span><span class="track"><span class="fill" style="width:' + Math.max(2, Math.round(c.count / max * 100)) + '%"></span></span><span class="num">' + fmt(c.count) + '</span></div>';
      if (!real.length) return '<details><summary class="nokids">' + row + '</summary></details>';
      var rmax = Math.max.apply(null, regs.map(function (r) { return r.count; }).concat([1]));
      return '<details' + (i === 0 ? ' open' : '') + '><summary>' + row + '</summary><div class="sub">' + regs.map(function (r) { return '<div class="bar"><span class="lab">' + esc(r.name && !/unknown/i.test(r.name) ? r.name : 'Region unknown') + '</span><span class="track"><span class="fill" style="width:' + Math.max(2, Math.round(r.count / rmax * 100)) + '%"></span></span><span class="num">' + fmt(r.count) + '</span></div>'; }).join('') + '</div></details>';
    }).join('');
    all.sort(function (a, b) { return b.count - a.count; });
    if (all.length) { txt('b-treg', all[0].name); txt('b-tregn', all[0].country + ' \\u00b7 ' + fmt(all[0].count) + ' views'); }
    else { txt('b-treg', '-'); txt('b-tregn', 'no region data yet'); }
    bars('b-regs', all.slice(0, 12).map(function (r) { return ['<span class="fl"><b>' + esc(r.name) + '</b><span class="fd">' + esc(r.country) + '</span></span>', r.count]; }), '', 'No state or region data in this range.');
    txt('b-geonote', known ? 'Tap a country to see its states or regions. GoatCounter stops at state or region, there\\u2019s no city level.' : 'GoatCounter only has the country for these views. If you want states and regions, check that region is turned on in your blprofile site\\u2019s GoatCounter settings (what data to collect).');
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
    $('p-more').classList.toggle('hidden', list.length <= pShown);
    hideEmptyCards('ply'); $('p-more').textContent = 'Show ' + Math.min(40, list.length - pShown) + ' more';
  }
  $('p-find').addEventListener('input', function () { pf.find = this.value.trim(); pShown = 40; renderPlayers(); });
  [['p-fnew', 'fnew'], ['p-fclan', 'fclan'], ['p-fme', 'fme']].forEach(function (x) {
    $(x[0]).addEventListener('click', function () { pf[x[1]] = !pf[x[1]]; this.setAttribute('aria-pressed', pf[x[1]] ? 'true' : 'false'); if (x[1] === 'fme') ls('studioStatsHideMe', pf.fme ? '1' : '0'); pShown = 40; renderPlayers(); });
  });
  $('p-more').addEventListener('click', function () { pShown += 40; renderPlayers(); });
  Object.keys(TOOLS).forEach(function (t) { $(TOOLS[t].p + '-more').addEventListener('click', function () { this.setAttribute('data-all', this.getAttribute('data-all') === '1' ? '0' : '1'); renderTool(t); }); });
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
    txt('u-note', (s.usersUnknown ? s.usersUnknown + (s.usersUnknown === 1 ? ' more player hasn\\u2019t' : ' more players haven\\u2019t') + ' opened Studio with a connected profile since this list started, so their name isn\\u2019t known yet. ' : '') + 'Names come from the BeatLeader profile connected in Studio when it checks the headset list.');
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
      if (isTool(tab) && !toolData[tab]) loadTool(tab, false);
    }).catch(function () { say('Couldn’t reach the Worker.', true); });
  }
  $('go').addEventListener('click', loadSync);
  keyIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadSync(); });
  $('refresh').addEventListener('click', function () { loadSync(); if (tab === 'bl') loadBl(true); else if (isTool(tab)) loadTool(tab, true); else loadGc(true); });
  $('forget').addEventListener('click', function () { setKey(''); gc = null; sync = null; bl = null; toolData = {}; signedIn(false); say('Key forgotten on this device.'); keyIn.focus(); });
  var rz = null; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (gc && tab === 'vis') chart(gc, dailyWhere(BUILD)); if (bl && tab === 'bl') chart(bl, null, BLIDS); if (isTool(tab) && toolData[tab]) chart(toolData[tab], null, toolIds(tab)); }, 150); });
  showRange(); showTab(tab);
  if (getKey()) { $('keyrow').classList.add('hidden'); loadSync(); }
})();
</script></body></html>`;
