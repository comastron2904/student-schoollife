// Vercel Cron — 매일 1회 호출. 삭제 예정일이 지난 계정의 데이터를 JSON으로 백업해
// 메일로 보낸 뒤 실제로 삭제한다. 메일 발송이 실패하면 그 계정은 이번 회차에 삭제하지
// 않고 건너뛰어(다음날 재시도) 백업 없이 지워지는 일이 없도록 한다.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, deletedEmailHtml } from "@/lib/email";
import { buildBackupPayload, fmtDate } from "@/lib/retention";

export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const { data: targets, error } = await supabase
    .from("retention_settings")
    .select("owner_id, delete_at")
    .lte("delete_at", now);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const row of targets || []) {
    try {
      const { data: userRes } = await supabase.auth.admin.getUserById(row.owner_id);
      const email = userRes?.user?.email;
      if (!email) { results.push({ owner_id: row.owner_id, ok: false, reason: "no email" }); continue; }

      const { data: students } = await supabase.from("students").select("*").eq("owner_id", row.owner_id);
      const { data: entries } = await supabase.from("entries").select("*").eq("owner_id", row.owner_id);
      const backup = buildBackupPayload(students || [], entries || []);
      const contentBase64 = Buffer.from(JSON.stringify(backup, null, 2), "utf-8").toString("base64");

      // 백업 메일 발송에 성공한 경우에만 삭제를 진행한다(발송 실패 시 다음 회차에 재시도).
      await sendEmail({
        to: email,
        subject: "[생기부 도우미] 데이터가 삭제되었습니다 (백업 첨부)",
        html: deletedEmailHtml({ studentCount: (students || []).length, deleteDateText: fmtDate(row.delete_at) }),
        attachments: [{ filename: `saenggibu-backup-${fmtDate(row.delete_at).replace(/\./g, "")}.json`, contentBase64 }],
      });

      await supabase.from("students").delete().eq("owner_id", row.owner_id); // entries는 ON DELETE CASCADE
      await supabase.from("retention_settings").delete().eq("owner_id", row.owner_id);

      results.push({ owner_id: row.owner_id, ok: true, deleted: (students || []).length });
    } catch (e) {
      results.push({ owner_id: row.owner_id, ok: false, reason: String(e.message || e) });
    }
  }
  return NextResponse.json({ checked: (targets || []).length, results });
}
