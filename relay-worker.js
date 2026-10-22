const RELAY_HOSTS = ["api.beatleader.xyz", "api.beatsaver.com", "scoresaber.com"];
const WRITE_ORIGINS = ["https://spanky3651.github.io"];
const MAX_BYTES = 2000000;
const MAX_SONGS = 3000;
const TTL = 60 * 60 * 24 * 180;            // seconds a list lives after its last update
const REFRESH_AFTER = 60 * 60 * 24 * 90;   // a list still being synced gets its clock reset after this
const WRITE_LIMIT = 30, WRITE_WINDOW = 600; // writes per IP per 10 minutes (per Worker instance)
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
function putTtl(env, k, v) { return env.PLAYLISTS.put(k, typeof v === "string" ? v : JSON.stringify(v), { expirationTtl: LIB_TTL }); }
function looksLikePlaylist(text) {
  try { const p = JSON.parse(text); return !!(p && typeof p === "object" && Array.isArray(p.songs)); } catch (e) { return false; }
}
const MAX_MOVED = 30;
// Backups the headset reports for one playlist: [{ t: unix seconds, count: songs or -1 }], newest first.
function cleanBackups(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((b) => b && Number.isSafeInteger(b.t) && b.t > 0 && b.t < 1e11).slice(0, 5).map((b) => ({ t: b.t, count: Number.isInteger(b.count) ? Math.max(-1, Math.min(100000, b.count)) : -1 }));
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
      const out = (await env.PLAYLISTS.get(outKey(dev.lib, me.id), "json")) || { items: [] };
      const writes = out.items.map((w) => Object.assign({ id: w.id, file: w.file, create: !!w.create, url: url.origin + "/link/outbox/" + w.id }, w.restore ? { restore: w.restore } : {}));
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
        items.push({ k: await fileKey(it.file), file: it.file, title: String(it.title || "").slice(0, 200), count: Math.max(0, Math.min(100000, it.count | 0)), sha: it.sha, have, at: have ? prev.at : nowSec(), backups: cleanBackups(it.backups) });
      }
      // Drop stored copies of playlists that are gone from the headset.
      const keep = new Set(items.map((it) => it.file));
      const gone = old.items.filter((it) => !keep.has(it.file));
      const backupsChanged = items.some((it) => { const p = byFile.get(it.file); return JSON.stringify(it.backups) !== JSON.stringify((p && p.backups) || []); });
      const changed = gone.length || need.length || items.length !== old.items.length || backupsChanged;
      if (changed) {
        await Promise.all(gone.map((it) => env.PLAYLISTS.delete("invb:" + dev.lib + ":" + me.id + ":" + it.k)));
        await putTtl(env, invKey(dev.lib, me.id), { items, updated: nowSec() });
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
      it.have = true; it.at = nowSec();
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
        if (!text) return json({ error: "Not found" }, 404, cors);
        return new Response(text, { headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors) });
      }
      if (ob[2] && request.method === "POST") {
        // A new playlist whose name was taken on the headset is saved under another one; remember the move
        // so Studio (and sends still on their way) follow it to the new file.
        const body = (await readJson(request, 2000)) || {};
        if (validFile(body.file) && body.file !== w.file) {
          out.moved = (out.moved || []).filter((x) => x.k !== w.k).concat({ k: w.k, nk: await fileKey(body.file), file: body.file, at: nowSec() }).slice(-MAX_MOVED);
        }
        out.items = out.items.filter((x) => x.id !== w.id);
        await putTtl(env, outKey(dev.lib, me.id), out);
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
  if (!originOk(request)) return json({ error: "Only Playlist Studio can manage libraries" }, 403, cors);

  if (path === "/lib" && request.method === "POST") {
    if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
    const id = randomId(10), key = randomHex(24);
    await putLib(env, id, { hk: await sha256(key), items: [], devices: [], created: nowSec() });
    return json({ id, key }, 201, cors);
  }

  const m = path.match(/^\/lib\/([A-Za-z0-9]{6,16})(\/items|\/claim|\/devices\/([A-Za-z0-9]{6,16})(\/playlists(?:\/(new|[0-9a-f]{16})(\/send|\/restore)?)?)?)?$/);
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
    const pendingList = () => out.items.map((x) => ({ id: x.id, k: x.k, file: x.file, title: x.title || "", create: !!x.create, restore: x.restore || 0, at: x.at }));
    const movedList = () => (out.moved || []).map((x) => ({ k: x.k, nk: x.nk, file: x.file }));
    const queue = async (k, file, title, create, body, restore) => {
      // One pending write per playlist: a newer send replaces the older one (a create stays a create).
      const prev = out.items.filter((x) => x.file === file);
      for (const w of prev) await env.PLAYLISTS.delete("outb:" + id + ":" + dv.id + ":" + w.id);
      out.items = out.items.filter((x) => x.file !== file);
      const w = { id: randomId(10), k, file, title: String(title || "").slice(0, 200), create: create || prev.some((x) => x.create), at: nowSec() };
      if (restore) w.restore = restore;
      else await putTtl(env, "outb:" + id + ":" + dv.id + ":" + w.id, JSON.stringify(body));
      out.items.push(w);
      await putTtl(env, outKey(id, dv.id), out);
      return w;
    };
    if (!m[5] && request.method === "GET") {
      const items = inv.items.map((it) => ({ k: it.k, file: it.file, title: it.title, count: it.count, ready: !!it.have, at: it.at, backups: it.backups || [] }));
      return json({ items, pending: pendingList(), moved: movedList(), updated: inv.updated || 0 }, 200, Object.assign({ "Cache-Control": "no-store" }, cors));
    }
    if (m[5] === "new" && !m[6] && request.method === "POST") {
      if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      const pl = await readPlaylist(request);
      if (pl.error) return json({ error: pl.error }, 400, cors);
      // A file name from the title that doesn't clash with anything on the headset or queued.
      const taken = new Set(inv.items.map((x) => x.file.toLowerCase()).concat(out.items.map((x) => x.file.toLowerCase())));
      const base = (pl.value.playlistTitle || "Playlist").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^StudioSync_/i, "").replace(/^\.+/, "").trim().slice(0, 80) || "Playlist";
      let file = base + ".bplist", n = 2;
      while (taken.has(file.toLowerCase())) file = base + " (" + (n++) + ").bplist";
      const w = await queue(await fileKey(file), file, pl.value.playlistTitle, true, pl.value);
      return json({ k: w.k, file: w.file, pending: pendingList() }, 201, cors);
    }
    let k = m[5] && m[5] !== "new" ? m[5] : "";
    // Follow a new playlist that was saved under another name on the headset.
    const mv = k && !inv.items.some((x) => x.k === k) && (out.moved || []).find((x) => x.k === k);
    if (mv) k = mv.nk;
    const it = k && inv.items.find((x) => x.k === k);
    const waiting = k && !it && out.items.find((x) => x.k === k && x.create);
    if (!it && !waiting) return json({ error: "That playlist isn't on the headset anymore" }, 404, cors);
    if (!m[6] && request.method === "GET") {
      const text = it ? await env.PLAYLISTS.get("invb:" + id + ":" + dv.id + ":" + it.k) : await env.PLAYLISTS.get("outb:" + id + ":" + dv.id + ":" + waiting.id);
      if (!text) return json({ error: "The headset hasn't uploaded this one yet" }, 404, cors);
      return new Response(text, { headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors) });
    }
    if (m[6] === "/restore" && request.method === "POST") {
      if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      if (!it) return json({ error: "The headset hasn't written that playlist yet" }, 409, cors);
      const body = (await readJson(request, 2000)) || {};
      const t = Number(body.t);
      if (!(it.backups || []).some((b) => b.t === t)) return json({ error: "That backup isn't on the headset anymore" }, 404, cors);
      await queue(it.k, it.file, it.title, false, null, t);
      return json({ pending: pendingList() }, 200, cors);
    }
    if (m[6] === "/send" && request.method === "POST") {
      if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);
      const pl = await readPlaylist(request);
      if (pl.error) return json({ error: pl.error }, 400, cors);
      const target = it || waiting;
      await queue(target.k, target.file, pl.value.playlistTitle, false, pl.value);
      return json({ k: target.k, file: target.file, pending: pendingList() }, 200, cors);
    }
    return json({ error: "Method not allowed" }, 405, cors);
  }

  if (!m[2] && request.method === "GET") {
    return json({ items: lib.items || [], devices: publicDevices(lib) }, 200, Object.assign({ "Cache-Control": "no-store" }, cors));
  }

  if (!(await allowWrite(request, env))) return json({ error: "Too many updates - wait a few minutes" }, 429, cors);

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
