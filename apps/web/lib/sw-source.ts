/**
 * Service worker for the app host, served by `app/sw.js/route.ts`.
 *
 * - Static assets: `/_next/static/*` (content-hashed) cache-first; other files
 *   (icons, fonts, images) stale-while-revalidate. The static cache is trimmed.
 * - Pages: network-first. The `/app` shell is kept for offline use; any other
 *   page falls back to `/offline`.
 * - `/api/*`: network-first. A response is stored only when the request had no
 *   Authorization header and the response says `Cache-Control: public` (e.g.
 *   the shared Sightings feed). Anything private or signed-in is never stored.
 * - Push: shows the morning alert and opens the app on tap. Nothing subscribes
 *   until `lib/push.ts` is switched on.
 *
 * Bump VERSION when this file changes in a way that needs old caches dropped.
 * Plain ES2017 inside: no template literals, so this string stays literal.
 */
export const SERVICE_WORKER_SOURCE = String.raw`/* Falcon service worker */
"use strict";

var VERSION = "v1";
var SHELL_CACHE = "falcon-shell-" + VERSION;
var STATIC_CACHE = "falcon-static-" + VERSION;
var API_CACHE = "falcon-api-" + VERSION;
var CURRENT = [SHELL_CACHE, STATIC_CACHE, API_CACHE];
var OFFLINE_URL = "/offline";
var SHELL_URL = "/app";
var PRECACHE = [OFFLINE_URL, SHELL_URL, "/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/apple-touch-icon.png"];
var STATIC_LIMIT = 200;
var API_LIMIT = 50;

var OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  "<title>You're offline</title></head>" +
  '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fdfdfd;color:#1d1b1b;font-family:system-ui,-apple-system,sans-serif">' +
  "<h1 style=\"font-size:20px;font-weight:500;margin:0\">You're offline</h1></body></html>";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        return Promise.all(
          PRECACHE.map(function (url) {
            return fetch(url, { cache: "reload", credentials: "same-origin" })
              .then(function (res) {
                if (res.ok && !res.redirected) return cache.put(url, res);
              })
              .catch(function () {});
          }),
        );
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf("falcon-") === 0 && CURRENT.indexOf(key) === -1;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function trim(cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      var extra = keys.length - limit;
      if (extra <= 0) return;
      return Promise.all(
        keys.slice(0, extra).map(function (key) {
          return cache.delete(key);
        }),
      );
    });
  });
}

function noStore(res) {
  return /no-store|private/i.test(res.headers.get("cache-control") || "");
}

function offlineResponse() {
  return caches.match(OFFLINE_URL).then(function (hit) {
    return (
      hit ||
      new Response(OFFLINE_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      })
    );
  });
}

function isShellPath(pathname) {
  return pathname === SHELL_URL || pathname === SHELL_URL + "/";
}

function handlePage(event, url) {
  return fetch(event.request)
    .then(function (res) {
      if (isShellPath(url.pathname) && res.ok && res.type === "basic" && !res.redirected && !noStore(res)) {
        var copy = res.clone();
        event.waitUntil(
          caches.open(SHELL_CACHE).then(function (cache) {
            return cache.put(SHELL_URL, copy);
          }),
        );
      }
      return res;
    })
    .catch(function () {
      if (!isShellPath(url.pathname)) return offlineResponse();
      return caches.match(SHELL_URL).then(function (hit) {
        return hit || offlineResponse();
      });
    });
}

function cacheableApi(request, res) {
  if (!res.ok || res.type !== "basic") return false;
  if (request.headers.has("authorization")) return false;
  var cc = (res.headers.get("cache-control") || "").toLowerCase();
  if (/no-store|no-cache|private/.test(cc)) return false;
  if (!/(^|[\s,])public([\s,]|$)/.test(cc)) return false;
  var vary = (res.headers.get("vary") || "").toLowerCase();
  if (vary.indexOf("authorization") !== -1 || vary.indexOf("cookie") !== -1 || vary === "*") return false;
  return true;
}

function handleApi(event) {
  var request = event.request;
  return fetch(request)
    .then(function (res) {
      if (cacheableApi(request, res)) {
        var copy = res.clone();
        event.waitUntil(
          caches
            .open(API_CACHE)
            .then(function (cache) {
              return cache.put(request, copy);
            })
            .then(function () {
              return trim(API_CACHE, API_LIMIT);
            }),
        );
      }
      return res;
    })
    .catch(function () {
      var hit = request.headers.has("authorization") ? Promise.resolve(undefined) : caches.match(request, { cacheName: API_CACHE });
      return hit.then(function (res) {
        return (
          res ||
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          })
        );
      });
    });
}

function putStatic(event, request, res) {
  if (!res.ok || res.type !== "basic" || noStore(res)) return;
  var copy = res.clone();
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(function (cache) {
        return cache.put(request, copy);
      })
      .then(function () {
        return trim(STATIC_CACHE, STATIC_LIMIT);
      }),
  );
}

function handleHashedStatic(event) {
  return caches.match(event.request, { cacheName: STATIC_CACHE }).then(function (hit) {
    if (hit) return hit;
    return fetch(event.request).then(function (res) {
      putStatic(event, event.request, res);
      return res;
    });
  });
}

function handleStatic(event) {
  return caches.match(event.request).then(function (hit) {
    var network = fetch(event.request)
      .then(function (res) {
        putStatic(event, event.request, res);
        return res;
      })
      .catch(function () {
        return hit;
      });
    if (hit) {
      event.waitUntil(network);
      return hit;
    }
    return network;
  });
}

var STATIC_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i;

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.indexOf("/api/") === 0) {
    event.respondWith(handleApi(event));
  } else if (request.mode === "navigate") {
    event.respondWith(handlePage(event, url));
  } else if (url.pathname.indexOf("/_next/static/") === 0) {
    event.respondWith(handleHashedStatic(event));
  } else if (STATIC_FILE.test(url.pathname)) {
    event.respondWith(handleStatic(event));
  }
});

self.addEventListener("push", function (event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Falcon", {
      body: data.body || "",
      icon: "/pwa/icon-192.png",
      tag: data.tag || "morning-alert",
      data: { url: typeof data.url === "string" ? data.url : SHELL_URL },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || SHELL_URL, self.location.origin);
  if (target.origin !== self.location.origin) target = new URL(SHELL_URL, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus().then(function (focused) {
            return focused && "navigate" in focused ? focused.navigate(target.href) : focused;
          });
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
`;
