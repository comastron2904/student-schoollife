// 생기부 도우미 서비스워커 — 설치 가능 조건 충족 + 정적 자산만 보수적으로 캐시
const CACHE = "sg-cache-v1";
const PRECACHE = ["/icon-192.png", "/icon-512.png", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // GET·동일 출처만 처리. API/인증/슈퍼베이스/Next 데이터는 항상 네트워크(캐시 금지).
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth") ||
    url.pathname.startsWith("/login") ||
    url.pathname.includes("/_next/data")
  ) {
    return; // 브라우저 기본 처리
  }

  // 정적 자산(_next/static, 아이콘, 매니페스트): 캐시 우선
  if (url.pathname.startsWith("/_next/static") || PRECACHE.includes(url.pathname) ||
      /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|css|js)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => hit)
      )
    );
    return;
  }

  // 페이지 내비게이션: 네트워크 우선(최신 상태 유지), 실패 시에만 캐시 폴백
  e.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
