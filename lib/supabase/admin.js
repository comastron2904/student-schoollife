// 서버 전용(크론 등) — RLS를 우회하는 서비스 롤 클라이언트.
// SUPABASE_SERVICE_ROLE_KEY는 절대 클라이언트 번들에 노출되면 안 되므로,
// 이 파일은 app/api/cron/** 라우트 핸들러(서버)에서만 import한다.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY 또는 SUPABASE URL이 설정되지 않았습니다.");
  return createSupabaseClient(url, key, { auth: { persistSession: false } });
}
