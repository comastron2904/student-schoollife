// 서버 전용 — 보관 기간이 지난 계정의 데이터를 백업 메일 발송 후 삭제하는 공용 로직.
// 크론(app/api/cron/retention-delete)과 앱 진입 시 안전장치(app/app/page.js)에서 함께 쓴다.
import { sendEmail, deletedEmailHtml } from "@/lib/email";
import { buildBackupPayload, fetchAllRows, fmtDate, daysSince, EMAIL_FAIL_GRACE_DAYS } from "@/lib/retention";

// 지금도 삭제 대상인지 DB에서 다시 확인 — 크론이 대상 목록을 읽은 뒤 교사가 연장했을 수 있다.
async function freshDueRow(admin, ownerId, now) {
  const { data, error } = await admin
    .from("retention_settings").select("owner_id, delete_at").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error("보관 설정 조회 실패: " + error.message);
  if (!data || new Date(data.delete_at) > now) return null;
  return data;
}

async function mustOk(promise, label) {
  const { error } = await promise;
  if (error) throw new Error(`${label} 실패: ${error.message}`);
}

/**
 * 한 계정을 정리한다. 반환: { owner_id, ok, deleted?, skipped?, retry?, reason?, mailed? }
 * - 백업 메일 발송에 실패하면 삭제 예정일로부터 EMAIL_FAIL_GRACE_DAYS일 동안은 다음 회차에 재시도하고,
 *   그 뒤에도 실패하면 메일 없이 삭제한다(메일 설정 문제로 데이터가 영원히 남지 않도록).
 * - 삭제는 entries → students → retention_settings 순서로, 각 단계의 오류를 확인한다.
 *   (예전 코드는 오류를 확인하지 않아 학생 삭제가 실패해도 보관 설정 행만 지워져 재시도조차 안 됐다)
 */
export async function purgeOwner(admin, ownerId, { now = new Date() } = {}) {
  const due = await freshDueRow(admin, ownerId, now);
  if (!due) return { owner_id: ownerId, ok: true, skipped: "not_due" };

  const students = await fetchAllRows(admin, "students", { ownerId });
  const entries = await fetchAllRows(admin, "entries", { ownerId });

  let mailed = false;
  let mailError = null;
  if (students.length || entries.length) {
    try {
      const { data: userRes } = await admin.auth.admin.getUserById(ownerId);
      const email = userRes?.user?.email;
      if (!email) throw new Error("가입 이메일 없음");
      const backup = buildBackupPayload(students, entries);
      const contentBase64 = Buffer.from(JSON.stringify(backup, null, 2), "utf-8").toString("base64");
      await sendEmail({
        to: email,
        subject: "[생기부 도우미] 데이터가 삭제되었습니다 (백업 첨부)",
        html: deletedEmailHtml({ studentCount: students.length, deleteDateText: fmtDate(due.delete_at) }),
        attachments: [{ filename: `saenggibu-backup-${fmtDate(due.delete_at).replace(/\./g, "")}.json`, contentBase64 }],
      });
      mailed = true;
    } catch (e) {
      mailError = String(e?.message || e);
      if (daysSince(due.delete_at, now) < EMAIL_FAIL_GRACE_DAYS) {
        return { owner_id: ownerId, ok: false, retry: true, reason: "백업 메일 실패(다음 회차 재시도): " + mailError };
      }
    }
  }

  // 메일 발송 중에 연장했을 수도 있으니 지우기 직전에 한 번 더 확인
  if (!(await freshDueRow(admin, ownerId, now))) return { owner_id: ownerId, ok: true, skipped: "extended_during_run", mailed };

  await mustOk(admin.from("entries").delete().eq("owner_id", ownerId), "항목 삭제");
  await mustOk(admin.from("students").delete().eq("owner_id", ownerId), "학생 삭제");
  await mustOk(admin.from("retention_settings").delete().eq("owner_id", ownerId), "보관 설정 삭제");

  return {
    owner_id: ownerId, ok: true, deleted: students.length, entries: entries.length, mailed,
    ...(mailError ? { reason: "메일 없이 삭제(유예 기간 경과): " + mailError } : {}),
  };
}
