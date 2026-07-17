"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function submit() {
    setErr(""); setMsg(""); setBusy(true);
    const supabase = createClient();
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
        router.push("/app");
        router.refresh();
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password: pw });
        if (error) throw error;
        if (data.session) {
          router.push("/app");
          router.refresh();
        } else {
          setMsg("가입 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요. (Supabase에서 이메일 확인을 꺼두면 바로 로그인됩니다.)");
          setMode("login");
        }
      }
    } catch (e) {
      setErr(translate(e?.message) || "오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }
  function translate(m = "") {
    if (m.includes("Invalid login")) return "이메일 또는 비밀번호가 올바르지 않습니다.";
    if (m.includes("already registered")) return "이미 가입된 이메일입니다.";
    if (m.includes("at least 6")) return "비밀번호는 6자 이상이어야 합니다.";
    return m;
  }

  return (
    <div className="sg-auth">
      <div className="sg-auth-card">
        <div className="sg-auth-mark">생활기록부 도우미</div>
        <p className="sg-auth-sub">{mode === "login" ? "로그인" : "회원가입"} · 교사용</p>

        <label className="sg-auth-label">이메일</label>
        <input className="sg-input" type="email" value={email} placeholder="teacher@school.kr"
               onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <label className="sg-auth-label">비밀번호</label>
        <input className="sg-input" type="password" value={pw} placeholder="6자 이상"
               onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />

        {err && <div className="sg-error" style={{ marginTop: 12 }}>{err}</div>}
        {msg && <div className="sg-notes" style={{ marginTop: 12 }}>{msg}</div>}

        <button className="sg-generate" style={{ width: "100%", marginTop: 16 }} disabled={busy || !email || !pw} onClick={submit}>
          {busy ? "처리 중…" : mode === "login" ? "로그인" : "가입하기"}
        </button>

        <button className="sg-linkbtn" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(""); setMsg(""); }}>
          {mode === "login" ? "계정이 없으신가요? 회원가입" : "이미 계정이 있으신가요? 로그인"}
        </button>
      </div>
    </div>
  );
}
