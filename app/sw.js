// Service worker do CiadoChurras (Curitiba e região).
// Estratégia: o "casco" do app (HTML, ícones) fica em cache e é servido na hora;
// os dados (/dados/latest.json) tentam a rede primeiro e caem para o cache quando está sem internet.

const VERSAO = "ciadochurras-v10";
const CASCO = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", evento => {
  evento.waitUntil(
    caches.open(VERSAO).then(cache => cache.addAll(CASCO)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", evento => {
  evento.waitUntil(
    caches.keys()
      .then(nomes => Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", evento => {
  const req = evento.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // envios, fotos e painel de aprovação nunca passam pelo cache
  if (url.pathname.includes("/api/") || url.pathname.includes("/fotos/") || url.pathname.endsWith("/admin.html") || url.pathname.endsWith("/parceiros.html") || url.pathname.endsWith("/parceiro.html")) return;

  // correções aprovadas: sempre da rede, sem reserva antiga
  if (url.pathname.endsWith("/dados/ajustes.json") || url.pathname.endsWith("/dados/parceiros.json")) {
    evento.respondWith(fetch(req).catch(() => new Response('{"correcoes":[],"novos":[],"produtos":[]}', { headers: { "content-type": "application/json" } })));
    return;
  }

  // dados: rede primeiro, cache como reserva
  if (url.pathname.includes("/dados/") || url.pathname.includes("/dados-inicial/")) {
    evento.respondWith(
      fetch(req)
        .then(resp => {
          const copia = resp.clone();
          caches.open(VERSAO).then(c => c.put(req, copia));
          return resp;
        })
        .catch(() => caches.match(req).then(r => r || caches.match("./dados-inicial/latest.json")))
    );
    return;
  }

  // casco: cache primeiro, rede como reserva
  evento.respondWith(
    caches.match(req).then(achou => achou || fetch(req).then(resp => {
      const copia = resp.clone();
      caches.open(VERSAO).then(c => c.put(req, copia));
      return resp;
    }).catch(() => caches.match("./index.html")))
  );
});
