// 학기 종료 후 데이터 보관·자동 삭제 정책 — 공용 상수·날짜 계산·백업 직렬화
// 흐름: 교사가 [데이터 보관 설정]에서 학기 종료일을 지정 → 그날 + 3개월이 삭제 예정일.
// 삭제 7일 전부터 앱 상단에 안내 배너가 뜨고(연장·백업 가능), 삭제 예정일이 지나면 크론이 데이터를 지운다.
// (이 파일은 브라우저·서버 양쪽에서 import 하므로 서버 전용 모듈을 넣지 않는다.)

export const RETENTION_MONTHS = 3;
export const REMINDER_DAYS_BEFORE = 7;
const DAY_MS = 86400000;

export const BACKUP_FORMAT = "saenggibu-helper-backup@1";

// 월 단위 덧셈 — 대상 월의 일수보다 날짜가 크면 말일로 보정(예: 1/31 + 1개월 → 2/28)
export function addMonthsClamped(date, months) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = d.getMonth() + months;
  const first = new Date(y, m, 1);
  const daysInTarget = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(d.getDate(), daysInTarget));
  first.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return first;
}

// "학기 종료일(YYYY-MM-DD)" 문자열로부터 삭제 예정 시각(ISO)을 계산
export function computeDeleteAt(semesterEndDateStr) {
  // 종료일 자정(로컬) 기준 + 3개월
  const base = new Date(`${semesterEndDateStr}T00:00:00`);
  return addMonthsClamped(base, RETENTION_MONTHS).toISOString();
}

// 연장 후 삭제 예정 시각(ISO) — 현재 삭제 예정일과 지금 중 더 늦은 시점에 3개월을 더한다.
// ※ 예전에는 ISO 문자열을 slice(0,10)으로 잘라 다시 계산했는데, ISO는 UTC 기준이라 한국 시간에서는
//   날짜가 하루 당겨지고(자정 KST = 전날 15시 UTC) 말일 보정까지 겹쳐 연장 폭이 들쭉날쭉했다.
//   이제 Date 객체 그대로 월을 더해 시간대와 무관하게 정확히 3개월이 늘어난다.
export function computeExtendedDeleteAt(currentDeleteAtIso, now = new Date()) {
  const cur = currentDeleteAtIso ? new Date(currentDeleteAtIso) : null;
  const base = cur && !Number.isNaN(cur.getTime()) && cur > now ? cur : now;
  return addMonthsClamped(base, RETENTION_MONTHS).toISOString();
}

export const daysUntil = (iso) => Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS);
export const daysSince = (iso, now = new Date()) => (now.getTime() - new Date(iso).getTime()) / DAY_MS;

export const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

// Supabase(PostgREST)는 한 번에 최대 1000행만 돌려준다. 학생·항목이 많으면 백업이 잘려 나가므로
// id 순으로 페이지를 넘기며 전부 가져온다. ownerId를 주면 그 소유자 행만(서비스 롤 클라이언트용).
export async function fetchAllRows(supabase, table, { ownerId, pageSize = 1000 } = {}) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let q = supabase.from(table).select("*").order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (ownerId) q = q.eq("owner_id", ownerId);
    const { data, error } = await q;
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

// 전체 데이터를 다시 불러올 수 있는 형태의 백업 JSON으로 직렬화
export function buildBackupPayload(students, entries) {
  const byStudent = {};
  for (const e of entries) (byStudent[e.student_id] ||= []).push(e);
  return {
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    studentCount: students.length,
    entryCount: entries.length,
    students: students.map((s) => ({ ...s, entries: byStudent[s.id] || [] })),
  };
}

export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `saenggibu-backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}

// 백업 JSON(문자열 또는 객체)을 { students: [...], entries: [...] } 평면 구조로 정규화.
// 지원 형식: ① 이 앱의 백업(students[].entries 중첩) ② { students, entries } 평면 ③ 학생 배열만 있는 JSON
export function parseBackup(input) {
  let obj = input;
  if (typeof input === "string") {
    const text = input.replace(/^﻿/, ""); // BOM 제거(메모장 등으로 저장한 파일)
    try { obj = JSON.parse(text); } catch { throw new Error("JSON 형식이 올바르지 않습니다. 백업 파일이 맞는지 확인해 주세요."); }
  }
  const list = Array.isArray(obj) ? obj : Array.isArray(obj?.students) ? obj.students : null;
  if (!list) throw new Error("학생 목록(students)이 없는 파일입니다. 생기부 도우미 백업 파일을 선택해 주세요.");

  const students = [];
  const entries = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const { entries: nested, ...s } = raw;
    if (!s.name && !s.id) continue;
    students.push(s);
    if (Array.isArray(nested)) for (const e of nested) if (e && typeof e === "object") entries.push({ ...e, student_id: e.student_id ?? s.id });
  }
  if (!Array.isArray(obj) && Array.isArray(obj?.entries)) {
    for (const e of obj.entries) if (e && typeof e === "object") entries.push(e);
  }
  if (!students.length) throw new Error("파일에 불러올 학생 데이터가 없습니다.");
  return { students, entries };
}
