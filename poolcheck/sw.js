// PoolCheck service worker — caches the app shell so it installs and runs offline.
// Navigations are network-first (online users always get fresh HTML on deploy);
// other same-origin GETs are cache-first. The map/address calls (OpenStreetMap)
// are intentionally NOT cached; they only work online and degrade silently.
var CACHE='poolcheck-v2'; // bump on every deploy
var SHELL=['index.html','poolcheck.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){if(k.indexOf('poolcheck-')===0&&k!==CACHE)return caches.delete(k);}));}).then(function(){return self.clients.claim();}));
});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET') return;
  var u=new URL(e.request.url);
  if(u.hostname.indexOf('openstreetmap')>=0) return;         // never cache map/geocode
  if(u.origin!==location.origin) return;                     // only handle our own files
  if(e.request.mode==='navigate'){
    // network-first for the page itself: fresh HTML when online, cached shell offline
    e.respondWith(fetch(e.request).then(function(r){
      if(r.ok&&r.type==='basic'&&!r.redirected){   // never overwrite the shell with an error/redirect page
        var cp=r.clone();
        caches.open(CACHE).then(function(c){ return c.put('index.html',cp); }).catch(function(){});
      }
      return r;
    }).catch(function(){ return caches.match('index.html').then(function(r){ return r||Response.error(); }); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function(r){ return r||fetch(e.request); }));
});
