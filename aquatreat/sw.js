var CACHE='aquatreat-v1';
var SHELL=['index.html','manifest.webmanifest','icon-192.png','icon-512.png'];

self.addEventListener('install',function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c){ return c.addAll(SHELL); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k.indexOf('aquatreat-')===0 && k!==CACHE) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch',function(e){
  var req=e.request;
  if(req.method!=='GET') return;
  var url=new URL(req.url);
  if(url.hostname.indexOf('openstreetmap')>=0) return;   // geocoder/tiles: network only, degrade silently
  if(req.mode==='navigate'){
    // network-first so new deploys propagate; fall back to the cached shell offline
    e.respondWith(fetch(req).catch(function(){ return caches.match('index.html').then(function(r){ return r||Response.error(); }); }));
    return;
  }
  e.respondWith(caches.match(req).then(function(r){ return r||fetch(req); }));
});
