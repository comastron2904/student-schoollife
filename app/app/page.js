export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Workspace from "./Workspace";
import { fetchAllRows } from "@/lib/retention";

// 삭제 예정일이 이만큼 지났는데도 데이터가 남아 있으면 크론이 돌지 않은 것으로 보고 접속 시점에 정리한다.
const PURGE_ON_VISIT_AFTER_MS = 86400000; // 1일

export default async function AppPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // retention_settings 테이블이 아직 없는 배포본이면 error가 나므로 조용히 무시(기능 비활성으로 동작)
  let { data: retention } = await supabase
    .from("retention_settings").select("*").maybeSingle();

  // 안전장치: 크론 미등록·실패 등으로 기간이 지난 데이터가 남아 있으면 접속 시점에 삭제
  let purgedNotice = null;
  if (retention && Date.now() - new Date(retention.delete_at).getTime() > PURGE_ON_VISIT_AFTER_MS && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const [{ createAdminClient }, { purgeOwner }] = await Promise.all([
        import("@/lib/supabase/admin"), import("@/lib/retention-server"),
      ]);
      const r = await purgeOwner(createAdminClient(), user.id);
      if (r.ok && r.deleted !== undefined) {
        purgedNotice = { count: r.deleted };
        retention = null;
      }
    } catch (e) {
      console.error("[app] 접속 시 보관 기간 정리 실패:", e);
    }
  }

  // RLS가 owner 기준으로 자동 필터링. 한 번에 1000행 제한이 있어 페이지를 넘기며 전부 읽는다.
  const students = (await fetchAllRows(supabase, "students").catch(() => []))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const entries = (await fetchAllRows(supabase, "entries").catch(() => []))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));

  return (
    <Workspace
      initialStudents={students || []} initialEntries={entries || []} userEmail={user.email}
      initialRetention={retention || null} purgedNotice={purgedNotice}
    />
  );
}
