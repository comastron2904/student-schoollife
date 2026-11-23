// Vercel Cron — 매일 1회 호출. 삭제 예정일이 지난 계정의 학생·항목 데이터를 삭제한다.
// 실제 처리 로직은 lib/retention-server.js 의 purgeOwner 참고.
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { purgeOwner } from "@/lib/retention-server";

export const dynamic = "force-dynamic"; // 응답이 캐시되어 크론이 실제로 실행되지 않는 일 방지
export const maxDuration = 60;
const TIME_BUDGET_MS = 50000; // maxDuration 전에 안전하게 끝내고, 남은 계정은 다음 회차에 처리

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const started = Date.now();
  let supabase;
  try { supabase = createAdminClient(); }
  catch (e) { return NextResponse.json({ error: String(e.message || e) }, { status: 500 }); }

  const now = new Date();
  const { data: targets, error } = await supabase
    .from("retention_settings")
    .select("owner_id, delete_at")
    .lte("delete_at", now.toISOString())
    .order("delete_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const row of targets || []) {
    if (Date.now() - started > TIME_BUDGET_MS) { results.push({ owner_id: row.owner_id, ok: false, retry: true, reason: "시간 초과 — 다음 회차" }); continue; }
    try {
      results.push(await purgeOwner(supabase, row.owner_id, { now }));
    } catch (e) {
      results.push({ owner_id: row.owner_id, ok: false, reason: String(e.message || e) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.error("[retention-delete] 실패/보류:", JSON.stringify(failed));
  return NextResponse.json({ checked: (targets || []).length, results });
}
