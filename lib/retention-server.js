// 서버 전용 — 보관 기간이 지난 계정의 데이터를 삭제하는 공용 로직.
// 크론(app/api/cron/retention-delete)과 앱 진입 시 안전장치(app/app/page.js)에서 함께 쓴다.
// (메일 발송 없음 — 백업은 교사가 앱의 [💾 백업·불러오기]에서 직접 받아 둔다)

// 지금도 삭제 대상인지 DB에서 다시 확인 — 크론이 대상 목록을 읽은 뒤 교사가 연장했을 수 있다.
async function freshDueRow(admin, ownerId, now) {
  const { data, error } = await admin
    .from("retention_settings").select("owner_id, delete_at").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error("보관 설정 조회 실패: " + error.message);
  if (!data || new Date(data.delete_at) > now) return null;
  return data;
}

async function deleteAndCount(admin, table, ownerId, label) {
  const { count, error } = await admin.from(table).delete({ count: "exact" }).eq("owner_id", ownerId);
  if (error) throw new Error(`${label} 실패: ${error.message}`);
  return count || 0;
}

/**
 * 한 계정을 정리한다. 반환: { owner_id, ok, deleted?, entries?, skipped? }
 * 삭제는 entries → students → retention_settings 순서로 하고 단계마다 오류를 확인한다.
 * 중간에 실패하면 retention_settings 행이 남아 있으므로 다음 회차에 다시 시도된다.
 */
export async function purgeOwner(admin, ownerId, { now = new Date() } = {}) {
  if (!(await freshDueRow(admin, ownerId, now))) return { owner_id: ownerId, ok: true, skipped: "not_due" };

  const entries = await deleteAndCount(admin, "entries", ownerId, "항목 삭제");
  const deleted = await deleteAndCount(admin, "students", ownerId, "학생 삭제");
  const { error } = await admin.from("retention_settings").delete().eq("owner_id", ownerId);
  if (error) throw new Error("보관 설정 삭제 실패: " + error.message);

  return { owner_id: ownerId, ok: true, deleted, entries };
}
