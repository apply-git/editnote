// editnote Service Worker ??讓編輯器?�離線�??�、可安�???app
// 策略：網路優?��?online ?�永?�拿?�?�編輯器）�?失�??�用快�?（offline 也能?��?
const CACHE = 'editnote-v23';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(CORE); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  const req = e.request;
  if (req.method !== 'GET') return; // ?��???POST，�???
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ?�管?�己網�?
  e.respondWith(
    fetch(req).then(function(res){
      const copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(req, copy); });
      return res;
    }).catch(function(){
      return caches.match(req).then(function(hit){ return hit || caches.match('/'); });
    })
  );
});
