// 학기 종료 후 데이터 보관·자동 삭제 정책 — 공용 상수·날짜 계산
// 흐름: 교사가 [데이터 보관 설정]에서 학기 종료일을 지정 → 그날 + 3개월이 삭제 예정일.
// 삭제 7일 전 크론이 알림 메일을 보내고, 삭제 예정일이 지나면 크론이 JSON 백업을 메일로 보낸 뒤 데이터를 지운다.

export const RETENTION_MONTHS = 3;
export const REMINDER_DAYS_BEFORE = 7;

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

export const daysUntil = (iso) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

export const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

// 전체 데이터를 사람이 다시 불러올 수 있는 형태의 백업 JSON으로 직렬화
export function buildBackupPayload(students, entries) {
  const byStudent = {};
  for (const e of entries) (byStudent[e.student_id] ||= []).push(e);
  return {
    exportedAt: new Date().toISOString(),
    format: "saenggibu-helper-backup@1",
    students: students.map((s) => ({ ...s, entries: byStudent[s.id] || [] })),
  };
}
