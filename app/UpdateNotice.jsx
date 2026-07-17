"use client";
import { useEffect, useState, useCallback } from "react";

// 이 번들이 빌드될 때 박힌 버전 = "내가 지금 보고 있는 버전"
const LOADED = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
const POLL_MS = 60_000; // 1분마다 확인

export default function UpdateNotice() {
  const [stale, setStale] = useState(false);
  const [reloading, setReloading] = useState(false);

  // 서버의 현재 배포 버전과 비교
  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const { version } = await res.json();
      if (version && version !== LOADED) setStale(true);
    } catch {}
  }, []);

  useEffect(() => {
    if (LOADED === "dev") return; // 로컬 개발 중에는 알림 비활성

    check();
    const id = setInterval(check, POLL_MS);

    // 탭으로 돌아오거나 창이 포커스될 때 즉시 확인 (오래 켜둔 탭 대응)
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // 서비스워커가 새 버전으로 교체되면 보조 신호로 활용
    let sw;
    if ("serviceWorker" in navigator) {
      sw = () => setStale(true);
      navigator.serviceWorker.addEventListener?.("controllerchange", sw);
    }

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      if (sw) navigator.serviceWorker.removeEventListener?.("controllerchange", sw);
    };
  }, [check]);

  async function reload() {
    setReloading(true);
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg?.update?.();
        reg?.waiting?.postMessage?.({ type: "SKIP_WAITING" });
      }
      // 오래된 정적 캐시 정리 후 새로고침
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {}
    window.location.reload();
  }

  if (!stale) return null;

  return (
    <div className="sg-update" role="status" aria-live="polite">
      <span className="sg-update-dot" />
      <div className="sg-update-text">
        <b>새 버전이 배포되었습니다</b>
        <span>새로고침하면 최신 화면으로 업데이트됩니다.</span>
      </div>
      <button className="sg-update-btn" onClick={reload} disabled={reloading}>
        {reloading ? "갱신 중…" : "새로고침"}
      </button>
      <button className="sg-update-x" onClick={() => setStale(false)} aria-label="알림 닫기">✕</button>
    </div>
  );
}
