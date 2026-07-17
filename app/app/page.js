export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Workspace from "./Workspace";

export default async function AppPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS가 owner 기준으로 자동 필터링
  const { data: students } = await supabase
    .from("students").select("*").order("created_at", { ascending: true });
  const { data: entries } = await supabase
    .from("entries").select("*").order("updated_at", { ascending: false });
  // retention_settings 테이블이 아직 없는 배포본이면 error가 나므로 조용히 무시(기능 비활성으로 동작)
  const { data: retention } = await supabase
    .from("retention_settings").select("*").maybeSingle();

  return <Workspace initialStudents={students || []} initialEntries={entries || []} userEmail={user.email} initialRetention={retention || null} />;
}
