const V='circuit-cbcebb0dfd';const A=['./','./index.html','./app.css','./app.js','./config.js','./db.js','./data.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(V).then(c=>c.addAll(A)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
  // network-first for the app shell so deploys are picked up immediately; cache is the offline fallback.
  e.respondWith(fetch(e.request).then(res=>{const c=res.clone();caches.open(V).then(x=>x.put(e.request,c));return res}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))))});