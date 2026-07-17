// 영역 정의 + 공용 헬퍼 (클라이언트/서버 공유)

export const CATEGORIES = [
  { key: "subject",   label: "세부능력 및 특기사항", short: "세특",   needsSubject: true,  target: 1500,
    guide: "교과 수업 안에서의 탐구·발표·과제·토론 등 학습 활동과, 그 과정에서 드러난 교과 역량(지식 이해·적용, 탐구력, 사고력 등)을 중심으로 서술한다." },
  { key: "autonomy",  label: "자율·자치활동",        short: "자율",   target: 1500,
    guide: "학급·학교 단위 활동에서의 역할, 자기주도성, 공동체 의식, 책임감, 의사소통·협력 태도를 중심으로 서술한다." },
  { key: "club",      label: "동아리활동",            short: "동아리", target: 1500,
    guide: "관심 분야에 대한 탐구 과정, 협업과 기여, 자기주도적 활동, 산출물과 그 의미를 중심으로 서술한다." },
  { key: "career",    label: "진로활동",              short: "진로",   target: 2100,
    guide: "진로 탐색·설계 과정, 관심 분야에 대한 이해 심화, 자기 이해와 진로 역량의 성장을 중심으로 서술한다." },
  { key: "volunteer", label: "봉사활동 특기사항",     short: "봉사",   target: 1050,
    guide: "나눔과 배려의 실천, 지속성, 봉사 과정에서 보인 태도와 변화·성장을 중심으로 서술한다." },
  { key: "behavior",  label: "행동특성 및 종합의견",  short: "행특",  target: 1500,
    guide: "인성, 학습 태도, 대인관계, 잠재력 등 1년간의 행동 특성을 종합적으로 관찰자 시점에서 서술한다." },
];

export const REFINEMENTS = [
  { key: "concrete", label: "더 구체적으로", instr: "추상적 표현을 줄이고 활동의 과정·근거가 더 구체적으로 드러나도록 다듬어 주세요." },
  { key: "shorter",  label: "더 간결하게",  instr: "핵심을 유지하면서 더 간결하게 줄여 주세요." },
  { key: "natural",  label: "문장 다듬기",  instr: "나열식 문장을 자연스러운 하나의 흐름으로 매끄럽게 다듬어 주세요." },
  { key: "longer",   label: "분량 늘리기",  instr: "활동의 의미와 역량 서술을 보강해 분량을 자연스럽게 늘려 주세요." },
];

export const catOf = (k) => CATEGORIES.find((c) => c.key === k) || CATEGORIES[0];

export const studentMeta = (s) =>
  [s.school, s.grade && s.grade + "학년", s.klass && s.klass + "반", s.number && s.number + "번"]
    .filter(Boolean)
    .join(" ");

// NEIS 바이트: 한글/한자 3, 영문·숫자·공백·특수 1, 줄바꿈 2
export function neisBytes(s = "") {
  let b = 0;
  for (const ch of s) {
    if (ch === "\n" || ch === "\r") b += 2;
    else if (ch.codePointAt(0) > 127) b += 3;
    else b += 1;
  }
  return b;
}

export const charCount = (s = "") => [...s].length;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 활동 우선순위: 2=높음(중점 서술), 1=보통(기본), 0=낮음(간략)
export const PRIORITIES = [
  { v: 2, label: "높음", emph: "중점 서술", hint: "분량과 비중을 늘려 본문의 중심으로 다룸" },
  { v: 1, label: "보통", emph: "기본",     hint: "보통 비중으로 다룸" },
  { v: 0, label: "낮음", emph: "간략 서술", hint: "핵심만 간략히, 또는 흐름상 생략 가능" },
];
export const prioOf = (v) => PRIORITIES.find((p) => p.v === v) || PRIORITIES[1];

// 학생 진행 상태 — 학생 목록에서 '다 한 학생' / '추후 작업 필요' 등을 색으로 구분하기 위한 표시.
// students.status 컬럼(text, 기본값 "none")에 저장. 컬럼이 없어도(과거 데이터) "none"으로 처리된다.
export const STUDENT_STATUSES = [
  { key: "none", label: "미지정", dot: "#8b93a1", hint: "표시 없음" },
  { key: "todo", label: "작업 필요", dot: "#f5a623", hint: "추후 이어서 작성해야 함" },
  { key: "review", label: "검토 필요", dot: "#7c6feb", hint: "초안은 있으나 검토·수정 필요" },
  { key: "done", label: "완료", dot: "#2fb573", hint: "작성을 마침" },
];
export const statusOf = (k) => STUDENT_STATUSES.find((s) => s.key === k) || STUDENT_STATUSES[0];
// 미지정 → 작업 필요 → 검토 필요 → 완료 → 미지정 순으로 한 번 클릭에 한 단계씩 순환
export const nextStatus = (k) => {
  const i = STUDENT_STATUSES.findIndex((s) => s.key === k);
  return STUDENT_STATUSES[(i < 0 ? 0 : i + 1) % STUDENT_STATUSES.length].key;
};

// parentId: 이 활동이 '심화 탐구'로서 이어받는 원 활동의 id. ""(빈 값)이면 독립 활동.
export const newActivity = () => ({ id: uid(), title: "", detail: "", meaning: "", priority: 1, parentId: "" });

// ── 활동 간 연계(심화 탐구) ──
// 활동 목록을 parentId 기준 트리로 만들고 깊이우선(DFS) 순서로 평탄화한다.
// - 존재하지 않는 부모를 가리키면 독립 활동으로 취급
// - 자기참조·순환 참조는 무시(독립 활동으로 취급)
// 반환: [{ act, depth, label, parent }]  label 예: "1", "1-1", "1-1-1"
//        parent = { label, title } | null
export function activityTree(activities = []) {
  const acts = (activities || []).filter(Boolean);
  const byId = new Map(acts.map((a) => [a.id, a]));

  const resolveParent = (a) => {
    const p = a.parentId ? byId.get(a.parentId) : null;
    if (!p || p.id === a.id) return null;
    const seen = new Set([a.id]); // 조상 체인을 거슬러 올라가며 순환 검사
    let cur = p;
    while (cur) {
      if (seen.has(cur.id)) return null;
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return p;
  };

  const childrenOf = new Map();
  const roots = [];
  for (const a of acts) {
    const p = resolveParent(a);
    if (p) {
      if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
      childrenOf.get(p.id).push(a);
    } else roots.push(a);
  }

  const out = [];
  const walk = (a, depth, label, parent) => {
    out.push({ act: a, depth, label, parent });
    const kids = childrenOf.get(a.id) || [];
    kids.forEach((c, i) =>
      walk(c, depth + 1, `${label}-${i + 1}`, { label, title: (a.title || "").trim() }));
  };
  roots.forEach((r, i) => walk(r, 0, String(i + 1), null));
  return out;
}

// id의 모든 하위(심화) 활동 id 집합 — 연계 선택 시 순환을 막기 위해 사용
export function descendantIds(activities = [], id) {
  const kids = {};
  for (const a of activities || []) {
    if (!a?.parentId) continue;
    (kids[a.parentId] = kids[a.parentId] || []).push(a.id);
  }
  const out = new Set();
  const stack = [...(kids[id] || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    stack.push(...(kids[cur] || []));
  }
  return out;
}

// ── 초안 버전 히스토리 ──
export const MAX_HISTORY = 15; // 항목별 최대 보관 개수(최신순)

// 히스토리 배열 맨 앞에 스냅샷을 추가하고 최대 개수로 제한해 반환한다.
// snap: { draft, notes, label } — id·at은 자동 부여
export function pushHistorySnapshot(history, snap) {
  const item = { id: uid(), at: new Date().toISOString(), draft: "", notes: "", label: "", ...snap };
  const list = Array.isArray(history) ? history : [];
  return [item, ...list].slice(0, MAX_HISTORY);
}

// 단어(어절) 단위 diff — 외부 라이브러리 없이 LCS로 구현.
// oldText → newText로 바뀔 때 무엇이 지워지고(del) 무엇이 더해지는지(add) 반환.
// 반환: [{ type: 'same'|'add'|'del', text }]
export function wordDiff(oldText = "", newText = "") {
  const tokenize = (s) => (s || "").split(/(\s+)/).filter((t) => t !== "");
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length, m = b.length;

  // 너무 길면(희귀 케이스) LCS 비용이 커지므로 안전하게 생략하고 통짜 교체로 처리
  if (n * m > 400000) {
    const out = [];
    if (oldText) out.push({ type: "del", text: oldText });
    if (newText) out.push({ type: "add", text: newText });
    return out;
  }

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
    else { out.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: "del", text: a[i] }); i++; }
  while (j < m) { out.push({ type: "add", text: b[j] }); j++; }

  // 인접한 같은 타입 토큰 병합 — 렌더링 노드 수 절감
  const merged = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === t.type) last.text += t.text;
    else merged.push({ ...t });
  }
  return merged;
}

// ── 생성 후 사후 검토: 기재 금지 가능성이 있는 표현 하이라이트 ──
// 100% 정확한 필터가 아니라 "검토가 필요할 수 있는 표현"을 짚어주는 보조 도구입니다.
// (강사·교수 등 특정 인물의 실명은 일반 단어와 구분이 어려워 자동 감지 대상에서 제외했습니다.)
const FORBIDDEN_PATTERNS = [
  { category: "대학명", re: /[가-힣A-Za-z]{1,10}(대학교|대학원)/g },
  { category: "사설기관명", re: /[가-힣A-Za-z]{1,10}(학원|어학원)/g },
  { category: "어학·인증시험", re: /(토익스피킹|토익|TOEIC|토플|TOEFL|아이엘츠|IELTS|텝스|TEPS|HSK|JLPT|JPT|OPIc|지텔프|G-?TELP|한국사능력검정시험|한자능력검정)/gi },
  { category: "점수·등급", re: /\d+\s?(점|급|등급)\b/g },
  { category: "수상·대회", re: /(금상|은상|동상|대상|최우수상|우수상|장려상|특별상)\b/g },
];

// 반환: [{ category, match, index, context }] — index 기준 오름차순 정렬
export function scanForbiddenTerms(text) {
  const s = text || "";
  const hits = [];
  for (const { category, re } of FORBIDDEN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const start = Math.max(0, m.index - 10);
      const end = Math.min(s.length, m.index + m[0].length + 10);
      hits.push({
        category, match: m[0], index: m.index,
        context: (start > 0 ? "…" : "") + s.slice(start, end) + (end < s.length ? "…" : ""),
      });
      if (re.lastIndex === m.index) re.lastIndex++; // 0-length 매치로 인한 무한루프 방지
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
