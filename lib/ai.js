// AI 제공자·모델·키 후보 큐 + 쿨다운 (클라이언트/서버 공유)
// 가동률 전략:
//  1) 후보를 (제공자 × 키 × 모델) 조합으로 펼쳐 순차 시도  — 한 곳이 막혀도 다른 조합으로 계속
//  2) 무료 등급 쿼터는 '모델별'로 따로 잡히므로 같은 키라도 모델을 낮추면 살아있는 경우가 많다
//  3) 방금 한도가 소진된 조합은 쿨다운에 넣어 다음 생성 때 건너뛴다 (헛된 대기 제거)

export const PROVIDERS = {
  gemini: {
    label: "Gemini",
    placeholder: "AIza...",
    linkLabel: "Google AI Studio에서 무료로 발급받기 ↗",
    linkHref: "https://aistudio.google.com/app/apikey",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
  },
  openai: {
    label: "ChatGPT",
    placeholder: "sk-...",
    linkLabel: "OpenAI 플랫폼에서 API 키 발급받기 ↗",
    linkHref: "https://platform.openai.com/api-keys",
    models: ["gpt-4o-mini", "gpt-4.1-mini"],
  },
};

export const PROVIDER_KEYS = ["gemini", "openai"];
export const normProvider = (p) => (p === "openai" ? "openai" : "gemini");
export const providerLabel = (p) => PROVIDERS[normProvider(p)].label;
export const modelsOf = (p) => PROVIDERS[normProvider(p)].models;
export const defaultModel = (p) => modelsOf(p)[0];
export const isAllowedModel = (p, m) => modelsOf(p).includes(m);

// 화면 표시용 짧은 모델명: "gemini-2.5-flash" → "2.5-flash"
export const modelLabel = (m = "") => m.replace(/^gemini-/, "").replace(/^gpt-/, "GPT-");
// 키 표시용 뒷 4자리 (전체 키는 절대 화면·로그에 남기지 않는다)
export const keyTag = (k) => (k ? "…" + k.slice(-4) : "공용 키");

// 후보 하나를 식별하는 문자열 — 쿨다운 캐시의 키로 쓴다(키 전체가 아닌 뒷자리만 사용)
export const candId = (c) =>
  `${c.provider}|${c.model}|${c.apiKey ? c.apiKey.slice(-6) : "server"}`;
export const candLabel = (c) =>
  `${providerLabel(c.provider)} · ${modelLabel(c.model)}${c.apiKey ? ` (${keyTag(c.apiKey)})` : " (공용 키)"}`;

// 시도 후보 큐 만들기.
// preferred 제공자를 먼저 배치하고, 제공자 안에서는 [모델 순서 → 키 순서]로 펼친다.
// (좋은 모델을 등록된 모든 키에 먼저 시도한 뒤, 그 다음 등급 모델로 내려간다)
// 등록된 키가 없는 제공자는 서버 공용 키(빈 문자열)로만 시도한다.
export function buildCandidates(preferred, keys = {}, { perProvider = 4, total = 8 } = {}) {
  const first = normProvider(preferred);
  const order = first === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];
  const out = [];
  for (const p of order) {
    const list = (keys[p] || []).map((k) => (k || "").trim()).filter(Boolean);
    const ks = list.length ? list : [""]; // "" = 서버 공용 키 폴백
    const sub = [];
    for (const m of modelsOf(p)) for (const k of ks) sub.push({ provider: p, model: m, apiKey: k });
    out.push(...sub.slice(0, perProvider));
  }
  return out.slice(0, total);
}

// ── 쿨다운 (브라우저 localStorage) ──
const CD_STORE = "ai_cooldowns";

export function loadCooldowns() {
  try {
    const raw = JSON.parse(localStorage.getItem(CD_STORE) || "{}");
    const now = Date.now();
    const out = {};
    for (const k in raw) if (raw[k] > now) out[k] = raw[k]; // 만료된 항목은 자동 정리
    return out;
  } catch { return {}; }
}
function saveCooldowns(map) {
  try { localStorage.setItem(CD_STORE, JSON.stringify(map)); } catch {}
}
export function clearCooldowns() { saveCooldowns({}); }

// 실패 코드 → 쿨다운 시간(ms). null이면 쿨다운하지 않음.
export function cooldownMs(code, retryAfterSec) {
  switch (code) {
    case "QUOTA_EXHAUSTED": return 3 * 60 * 60 * 1000; // 일일 한도·크레딧 소진 → 3시간
    case "BAD_API_KEY":     return 6 * 60 * 60 * 1000; // 잘못된 키 → 다시 등록할 때까지(키 저장 시 해제)
    case "RATE_LIMIT":      return Math.max((retryAfterSec || 60) * 1000, 30 * 1000);
    case "AI_BUSY":
    case "NETWORK":         return 30 * 1000;
    default:                return null; // NO_API_KEY·기타 오류는 쿨다운 없음
  }
}
export function markCooldown(cand, code, retryAfterSec) {
  const ms = cooldownMs(code, retryAfterSec);
  if (!ms) return;
  const map = loadCooldowns();
  map[candId(cand)] = Date.now() + ms;
  saveCooldowns(map);
}
// 특정 키에 걸린 쿨다운 해제 — 사용자가 키를 새로 저장/삭제할 때 호출
export function clearCooldownsForKey(apiKey) {
  const tail = apiKey ? apiKey.slice(-6) : "server";
  const map = loadCooldowns();
  for (const k in map) if (k.endsWith("|" + tail)) delete map[k];
  saveCooldowns(map);
}

// 쿨다운 중인 후보는 뒤로 미룬다. 전부 쿨다운이면 순서만 남기고 그대로 시도(막다른 길 방지).
export function orderByCooldown(cands, cds = loadCooldowns()) {
  const now = Date.now();
  const ready = cands.filter((c) => !(cds[candId(c)] > now));
  const cooled = cands
    .filter((c) => cds[candId(c)] > now)
    .sort((a, b) => cds[candId(a)] - cds[candId(b)]); // 곧 풀리는 것부터
  return { ready, cooled, queue: [...ready, ...cooled] };
}

// ── 요청 간격 조절 (RPM 초과 예방) ──
export const MIN_REQUEST_GAP_MS = 4500;
const LAST_AT = "ai_last_request_at";
export function lastRequestAt() {
  try { return Number(localStorage.getItem(LAST_AT)) || 0; } catch { return 0; }
}
export function touchRequestAt() {
  try { localStorage.setItem(LAST_AT, String(Date.now())); } catch {}
}
// 다음 요청까지 기다려야 하는 ms (0이면 바로 가능)
export function waitBeforeRequest() {
  const gap = Date.now() - lastRequestAt();
  return gap >= MIN_REQUEST_GAP_MS ? 0 : MIN_REQUEST_GAP_MS - gap;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 키 저장 (제공자당 여러 개) ──
// 예전 단일 키 저장 형식(gemini_api_key)을 배열 형식(gemini_api_keys)으로 자동 이관한다.
const keysStore = (p) => `${p}_api_keys`;
const legacyStore = (p) => `${p}_api_key`;

export function loadKeys() {
  const out = { gemini: [], openai: [] };
  for (const p of PROVIDER_KEYS) {
    try {
      const raw = localStorage.getItem(keysStore(p));
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) out[p] = arr.filter((k) => typeof k === "string" && k.trim());
      } else {
        const legacy = (localStorage.getItem(legacyStore(p)) || "").trim();
        if (legacy) {
          out[p] = [legacy];
          localStorage.setItem(keysStore(p), JSON.stringify(out[p])); // 이관
        }
      }
    } catch {}
  }
  return out;
}
export function saveKeys(p, list) {
  const clean = [...new Set(list.map((k) => (k || "").trim()).filter(Boolean))];
  try {
    localStorage.setItem(keysStore(p), JSON.stringify(clean));
    localStorage.removeItem(legacyStore(p)); // 구 형식 제거
  } catch {}
  return clean;
}
