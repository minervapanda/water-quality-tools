// PoolCheck service worker — caches the app shell so it installs and runs offline.
// The map/address calls (OpenStreetMap) are intentionally NOT cached; they only
// work online and degrade silently.
var CACHE='poolcheck-v1';
var SHELL=['index.html','poolcheck.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){if(k!==CACHE)return caches.delete(k);}));}).then(function(){return self.clients.claim();}));
});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(u.hostname.indexOf('openstreetmap')>=0) return;         // never cache map/geocode
  e.respondWith(caches.match(e.request).then(function(r){ return r||fetch(e.request); }));
});
