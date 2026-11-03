// Playlist Studio service worker: war alerts only. It shows the alerts the Worker pushes and opens Studio's war
// screen when one is clicked. It doesn't cache or touch any page loads (no fetch handler), so Studio loads
// exactly as it does without it.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// The taskbar / home screen icon count: hits on you since you last opened the war screen.
function bumpBadge(n) {
  if (!self.navigator || !self.navigator.setAppBadge) return Promise.resolve();
  return caches.open('ps-alerts').then(function (c) {
    return c.match('badge').then(function (r) { return r ? r.text() : '0'; }).then(function (t) {
      var v = (parseInt(t, 10) || 0) + n;
      return c.put('badge', new Response(String(v))).then(function () { return self.navigator.setAppBadge(v); });
    });
  }).catch(function () {});
}

self.addEventListener('push', function (e) {
  var m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { t: 'Playlist Studio', b: e.data ? e.data.text() : '' }; }
  var opts = { body: m.b || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { v: m.v || '1' }, timestamp: Date.now() };
  if (m.tag) { opts.tag = m.tag; opts.renotify = true; }
  if (m.k === 'hit') opts.actions = [{ action: 'maps', title: 'Hit back' }, { action: 'open', title: 'Open war' }];
  e.waitUntil(Promise.all([self.registration.showNotification(m.t || 'Playlist Studio', opts), m.n ? bumpBadge(m.n) : null]));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var v = e.action === 'maps' ? 'maps' : ((e.notification.data && e.notification.data.v) || '1');
  var url = new URL('./?utm_source=push&utm_campaign=war-alert&war=' + v, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var c = list.filter(function (x) { return x.url.indexOf(self.registration.scope) === 0; })[0];
    if (c) { c.postMessage({ t: 'ps-war', v: v }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
