// Vercel Cron — 매일 1회 호출. 삭제 예정일이 7일 이내로 남았고 아직 알림을 보내지 않은
// 계정에 리마인더 메일을 보낸다. CRON_SECRET을 설정해 두면 Vercel이 자동으로 Authorization
// 헤더를 붙여 호출하므로, 그 값으로 요청 주체를 검증한다.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, reminderEmailHtml } from "@/lib/email";
import { REMINDER_DAYS_BEFORE, daysUntil, fmtDate } from "@/lib/retention";

export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // 설정 안 했으면 검증 생략(로컬 테스트용) — 배포 시 반드시 설정 권장
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://" + (process.env.VERCEL_URL || "");
  const soon = new Date(Date.now() + REMINDER_DAYS_BEFORE * 86400000).toISOString();

  const { data: targets, error } = await supabase
    .from("retention_settings")
    .select("owner_id, delete_at, status")
    .is("reminder_sent_at", null)
    .lte("delete_at", soon);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const row of targets || []) {
    try {
      const { data: userRes } = await supabase.auth.admin.getUserById(row.owner_id);
      const email = userRes?.user?.email;
      if (!email) { results.push({ owner_id: row.owner_id, ok: false, reason: "no email" }); continue; }

      await sendEmail({
        to: email,
        subject: "[생기부 도우미] 학생 데이터가 곧 삭제됩니다",
        html: reminderEmailHtml({ appUrl, deleteDateText: fmtDate(row.delete_at), daysLeft: Math.max(daysUntil(row.delete_at), 0) }),
      });

      await supabase.from("retention_settings")
        .update({ reminder_sent_at: new Date().toISOString(), status: "reminder_sent" })
        .eq("owner_id", row.owner_id);

      results.push({ owner_id: row.owner_id, ok: true });
    } catch (e) {
      results.push({ owner_id: row.owner_id, ok: false, reason: String(e.message || e) });
    }
  }
  return NextResponse.json({ checked: (targets || []).length, results });
}
