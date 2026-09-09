/*
 * Playlist Studio — CORS relay (Cloudflare Worker)
 * -------------------------------------------------
 * BeatLeader's API sends no CORS headers, so a browser can't call it directly.
 * The public free proxies the app used to race (allorigins, corsproxy.io,
 * codetabs, proxy.cors.sh) have gone paid, gated, or down. This tiny Worker is
 * your own relay: it fetches the API server-side and adds the CORS header the
 * browser needs. Free tier is plenty (100k requests/day), and it's fast.
 *
 * DEPLOY (about 5 minutes, no command line):
 *   1. Sign in at https://dash.cloudflare.com  (free account is fine).
 *   2. Workers & Pages  ->  Create  ->  Workers  ->  Create Worker.
 *      Name it something like "playlist-relay", then Deploy.
 *   3. Click "Edit code", delete the sample, paste THIS whole file, then Deploy.
 *   4. Copy the URL it gives you, e.g. https://playlist-relay.YOURNAME.workers.dev
 *   5. In Playlist Studio: open the BeatLeader "Connection" panel ->
 *      Advanced: custom relay, and paste:
 *         https://playlist-relay.YOURNAME.workers.dev/?url=
 *      (keep the trailing "?url=") then run a search to confirm it works.
 *   6. Send that URL to me and I'll bake it in as the default relay for everyone.
 *
 * It only proxies the two hosts this app needs, so it can't be abused as an
 * open proxy.
 */
export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return new Response("Missing ?url=", { status: 400, headers: cors });

    let t;
    try { t = new URL(target); } catch (e) { return new Response("Bad url", { status: 400, headers: cors }); }

    // Allowlist so this can never be used as a general-purpose open proxy.
    const ALLOWED = ["api.beatleader.xyz", "api.beatsaver.com"];
    if (!ALLOWED.includes(t.hostname)) {
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
  },
};
