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
  h["Access-Control-Allow-Headers"] = "Content-Type, X-Lib-Key, Authorization";
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
      return json({ library: dev.lib, device: me.name, playlists, writes }, 200, Object.assign({ "Cache-Control": "no-store" }, cors));
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
        items.push({ k: await fileKey(it.file), file: it.file, title: String(it.title || "").slice(0, 200), count: Math.max(0, Math.min(100000, it.count | 0)), ...mapsField(it.maps), ...soloField(it.solo), sha: it.sha, have, at: have ? prev.at : nowSec(), ...(have && prev.v ? { v: prev.v } : {}), backups: cleanBackups(it.backups) });
      }
      // Drop stored copies of playlists that are gone from the headset.
      const keep = new Set(items.map((it) => it.file));
      const gone = old.items.filter((it) => !keep.has(it.file));
      const backupsChanged = items.some((it) => { const p = byFile.get(it.file); return JSON.stringify(it.backups) !== JSON.stringify((p && p.backups) || []) || (p && p.maps) !== it.maps || (p && p.solo) !== it.solo; });
      // Playlists deleted on the headset that it can still bring back, and what this mod version can do.
      const deleted = [];
      for (const d of (Array.isArray(body.deleted) ? body.deleted : []).slice(0, MAX_DELETED)) {
        if (!d || !validFile(d.file)) continue;
        const backups = cleanBackups(d.backups);
        if (backups.length) deleted.push({ k: await fileKey(d.file), file: d.file, title: String(d.title || "").slice(0, 200), backups });
      }
      const features = (Array.isArray(body.features) ? body.features : []).filter((f) => f === "restore" || f === "delete" || f === "delete-songs");
      const changed = gone.length || need.length || items.length !== old.items.length || backupsChanged ||
        JSON.stringify(deleted) !== JSON.stringify(old.deleted || []) || JSON.stringify(features) !== JSON.stringify(old.features || []);
      if (changed) {
        await Promise.all(gone.map((it) => env.PLAYLISTS.delete("invb:" + dev.lib + ":" + me.id + ":" + it.k)));
        await putTtl(env, invKey(dev.lib, me.id), { items, deleted, features, updated: nowSec() });
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
    await putTtl(env, ordKey(om[1], om[2]), { ks, t: nowSec() });
    return json({ order: ks }, 200, cors);
  }
  const m = path.match(/^\/lib\/([A-Za-z0-9]{6,16})(\/items|\/claim|\/rekey|\/devices\/([A-Za-z0-9]{6,16})(\/playlists(?:\/(new|delete|[0-9a-f]{16})(\/send|\/restore|\/delete|\/cancel)?)?)?)?$/);
  if (!m) return json({ error: "Not found" }, 404, cors);
  const id = m[1], lib = await env.PLAYLISTS.get("lib:" + id, "json");
  if (!lib) return json({ error: "Not found" }, 404, cors);
  const key = request.headers.get("X-Lib-Key") || "";
  if (!key || !safeEqual(await sha256(key), lib.hk)) return json({ error: "Wrong library key" }, 403, cors);

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
      if (!opts.later) await putTtl(env, outKey(id, dv.id), out);
      return w;
    };
    const noSongs = () => !(inv.features || []).includes("delete-songs");
    if (!m[5] && request.method === "GET") {
      const old = inv.items.filter((it) => it.have && it.v === undefined).slice(0, 25);
      if (old.length) {
        for (const it of old) it.v = await plVersion(await env.PLAYLISTS.get("invb:" + id + ":" + dv.id + ":" + it.k));
        await putTtl(env, invKey(id, dv.id), inv);
      }
      const items = inv.items.map((it) => { const v = latestV(it.file, it); return Object.assign({ k: it.k, file: it.file, title: it.title, count: it.count }, mapsField(it.maps), soloField(it.solo), { ready: !!it.have, at: it.at }, v ? { v } : {}, { backups: it.backups || [] }); });
      const deleted = (inv.deleted || []).map((d) => ({ k: d.k, file: d.file, title: d.title, backups: d.backups }));
      const seen = Math.max(dv.seen || 0, +(await env.PLAYLISTS.get(seenKey(id, dv.id))) || 0);
      const ord = (await env.PLAYLISTS.get(ordKey(id, dv.id), "json")) || {};
      return json({ items, deleted, features: inv.features || [], pending: pendingList(), moved: movedList(), updated: inv.updated || 0, seen, order: Array.isArray(ord.ks) ? ord.ks : [] }, 200, Object.assign({ "Cache-Control": "no-store" }, cors));
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
      if (done.length) await putTtl(env, outKey(id, dv.id), out);
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
// Counts only: how many headsets are linked and how many sync. No playlist names, headset names or ids leave
// the Worker. The page is public but empty; the numbers need ADMIN_KEY, a Worker secret
// (npx wrangler secret put ADMIN_KEY), sent as "Authorization: Bearer <key>".
let adminFails = [];   // times of recent wrong admin keys, kept in memory only
async function admin(request, env, url) {
  const nocache = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
  if (url.pathname === "/admin" && request.method === "GET") {
    return new Response(ADMIN_PAGE, { headers: Object.assign({ "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://spanky3651.github.io" }, nocache) });
  }
  if (url.pathname !== "/admin/stats" || request.method !== "GET") return json({ error: "Not found" }, 404, nocache);
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
    sharedPlaylists: 0, hostedLinks: 0, linksByWeek: new Array(WEEKS).fill(0), activeByWeek: new Array(WEEKS).fill(0) };
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map(async (id) => {
      const lib = await env.PLAYLISTS.get("lib:" + id, "json");
      if (!lib) return;
      const devs = Array.isArray(lib.devices) ? lib.devices : [];
      st.hostedLinks += (lib.items || []).length;
      if (!devs.length) { st.librariesNoHeadset++; return; }
      if (devs.length > 1) st.librariesMulti++;
      const seen = await withSeen(env, id, devs);
      const invs = await Promise.all(devs.map((d) => env.PLAYLISTS.get(invKey(id, d.id), "json")));
      seen.forEach((d, j) => {
        st.headsets++;
        const s = d.seen || 0, added = d.added || 0;
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
      });
    }));
  }
  return st;
}

// Studio Sync icon (the same one as on the BeatLeader profile card), 92 px PNG.
const ADMIN_LOGO = "data:image/png;base64,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";
const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Studio Sync Stats</title>
<link rel="icon" type="image/png" href="${ADMIN_LOGO}">
<style>
:root{--bg:#000;--card:#0b0f17;--line:#1f2a3d;--text:#f2f5fa;--muted:#9aa6b8;--blue:#2f7bff;--red:#ff2740;--green:#3ddc84;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,'Segoe UI',Arial,sans-serif;padding:24px 16px 48px}
main{max-width:980px;margin:0 auto}
h1{font-size:26px;margin:0}
.brand{display:flex;align-items:center;gap:12px;margin:0 0 6px}
.brand img{width:44px;height:44px;border-radius:11px;box-shadow:0 0 16px rgba(47,123,255,.25);flex:none}
.sub{color:var(--muted);font-size:15px;margin:0 0 22px}
.keyrow{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
input{flex:1;min-width:220px;background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:11px 13px;font-size:16px}
button{background:var(--blue);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-size:16px;font-weight:700;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--muted)}
.msg{color:var(--muted);font-size:15px;min-height:22px;margin:0 0 16px}
.msg.err{color:#ff8a98}
.msg:empty{display:none}
/* Inside Playlist Studio's drawer (?embed=1) the drawer has its own title, so the page's title goes */
.embed body{padding-top:16px}
.embed .brand,.embed .top .sub{display:none}
.embed .top{justify-content:flex-end;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.label{font-size:13px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.value{font-size:34px;font-weight:800;margin-top:2px}
.note{font-size:14px;color:var(--muted)}
.hero .value{color:var(--green)}
h2{font-size:18px;margin:26px 0 10px}
.bars{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.bar{display:grid;grid-template-columns:110px 1fr 44px;align-items:center;gap:10px;margin:6px 0;font-size:15px}
.track{height:14px;background:#111827;border-radius:7px;overflow:hidden}
.fill{height:100%;border-radius:7px;background:var(--blue)}
.fill.alt{background:var(--red)}
.num{text-align:right;font-weight:700}
.hidden{display:none}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:22px}
.top .sub{margin:0}
.tools{display:flex;gap:8px;margin-top:4px}
.tools button{padding:7px 12px;font-size:14px;font-weight:600}
</style></head><body><main>
<div class="top"><div><div class="brand"><img src="${ADMIN_LOGO}" alt="" width="44" height="44"><h1>Studio Sync stats</h1></div>
<p class="sub">Headsets linked to Playlist Studio and how many keep syncing. Counts only.</p></div>
<div class="tools hidden" id="tools"><button id="refresh" class="ghost">Refresh</button><button id="forget" class="ghost">Forget key</button></div></div>
<div class="keyrow" id="keyrow"><input id="key" type="password" placeholder="Admin key" autocomplete="current-password">
<button id="go">Show stats</button></div>
<p class="msg" id="msg"></p>
<div id="out" class="hidden">
<div class="grid">
<div class="card hero"><div class="label">Active today</div><div class="value" id="activeDay"></div><div class="note">synced in the last 24 hours</div></div>
<div class="card hero"><div class="label">Active this week</div><div class="value" id="activeWeek"></div><div class="note">last 7 days</div></div>
<div class="card"><div class="label">Active this month</div><div class="value" id="activeMonth"></div><div class="note">last 30 days</div></div>
<div class="card"><div class="label">Headsets linked</div><div class="value" id="headsets"></div><div class="note" id="neverNote"></div></div>
<div class="card"><div class="label">New this week</div><div class="value" id="newWeek"></div><div class="note" id="newMonthNote"></div></div>
<div class="card"><div class="label">Players</div><div class="value" id="players"></div><div class="note" id="multiNote"></div></div>
<div class="card"><div class="label">Playlists shared</div><div class="value" id="sharedPlaylists"></div><div class="note">from headsets to Studio</div></div>
<div class="card"><div class="label">Started, not linked</div><div class="value" id="librariesNoHeadset"></div><div class="note">opened linking but no headset yet</div></div>
</div>
<h2>New headsets per week</h2><div class="bars" id="linksBars"></div>
<h2>Headsets by last sync</h2><div class="bars" id="activeBars"></div>
<p class="sub" id="when" style="margin-top:16px"></p>
</div>
</main>
<script>
(function () {
  var embedded = /[?&]embed=1/.test(location.search);
  if (embedded) {
    document.documentElement.classList.add('embed');
    // Esc pressed in here closes Playlist Studio's drawer too.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') try { parent.postMessage('studio-sync-stats-close', 'https://spanky3651.github.io'); } catch (x) {} });
  }
  var K = 'studioSyncAdminKey', keyIn = document.getElementById('key'), msg = document.getElementById('msg');
  function getKey() { try { return localStorage.getItem(K) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { if (v) localStorage.setItem(K, v); else localStorage.removeItem(K); } catch (e) {} }
  function txt(id, v) { document.getElementById(id).textContent = v; }
  // With a working key the key box goes away; Refresh and Forget key sit by the title instead.
  function signedIn(on) {
    document.getElementById('keyrow').classList.toggle('hidden', on);
    document.getElementById('tools').classList.toggle('hidden', !on);
    if (!on) document.getElementById('out').classList.add('hidden');
  }
  function say(t, err) { msg.textContent = t; msg.className = 'msg' + (err ? ' err' : ''); }
  function bars(id, data, alt) {
    var max = Math.max.apply(null, data.concat([1])), el = document.getElementById(id);
    el.textContent = '';
    data.forEach(function (n, i) {
      var row = document.createElement('div'); row.className = 'bar';
      var lab = document.createElement('span'); lab.textContent = i === 0 ? 'This week' : i === 1 ? 'Last week' : i + ' weeks ago';
      var tr = document.createElement('span'); tr.className = 'track';
      var f = document.createElement('span'); f.className = 'fill' + (alt ? ' alt' : ''); f.style.display = 'block'; f.style.width = Math.round(n / max * 100) + '%';
      tr.appendChild(f);
      var num = document.createElement('span'); num.className = 'num'; num.textContent = n;
      row.appendChild(lab); row.appendChild(tr); row.appendChild(num); el.appendChild(row);
    });
  }
  function load() {
    var key = keyIn.value.trim() || getKey();
    if (!key) { say('Enter your admin key.', true); return; }
    say('Loading...');
    fetch('/admin/stats', { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      if (!res.ok) { if (res.status === 401) { setKey(''); signedIn(false); } say(res.j.error || 'Couldn’t load stats.', true); return; }
      setKey(key); keyIn.value = ''; signedIn(true);
      var s = res.j, players = s.libraries - s.librariesNoHeadset;
      txt('activeDay', s.activeDay); txt('activeWeek', s.activeWeek); txt('activeMonth', s.activeMonth);
      txt('headsets', s.headsets); txt('neverNote', s.neverSynced ? s.neverSynced + ' never synced' : 'all have synced at least once');
      txt('newWeek', s.newWeek); txt('newMonthNote', s.newMonth + ' in the last 30 days');
      txt('players', players); txt('multiNote', s.librariesMulti ? s.librariesMulti + ' with more than one headset' : 'one headset each');
      txt('sharedPlaylists', s.sharedPlaylists); txt('librariesNoHeadset', s.librariesNoHeadset);
      bars('linksBars', s.linksByWeek); bars('activeBars', s.activeByWeek, true);
      txt('when', 'Updated ' + new Date(s.generated * 1000).toLocaleString() + '. Last sync times are at most 10 minutes old.' + (s.excluded ? ' Your own library is left out.' : ' Your own headsets are counted (ADMIN_EXCLUDE isn\u2019t set).'));
      document.getElementById('out').classList.remove('hidden'); say('');
    }).catch(function () { say('Couldn’t reach the Worker.', true); });
  }
  document.getElementById('go').addEventListener('click', load);
  keyIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('forget').addEventListener('click', function () { setKey(''); signedIn(false); say('Key forgotten on this device.'); keyIn.focus(); });
  if (getKey()) { document.getElementById('keyrow').classList.add('hidden'); load(); }
})();
</script></body></html>`;
