"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  CATEGORIES, REFINEMENTS, PRIORITIES, catOf, studentMeta, neisBytes, charCount, uid, newActivity,
  pushHistorySnapshot, MAX_HISTORY, wordDiff, scanForbiddenTerms, activityTree, descendantIds,
  STUDENT_STATUSES, statusOf,
} from "@/lib/categories";
import {
  PROVIDERS, PROVIDER_KEYS, providerLabel, modelLabel, keyTag, candId, candLabel,
  buildCandidates, orderByCooldown, loadCooldowns, markCooldown, clearCooldowns, clearCooldownsForKey,
  loadKeys, saveKeys, waitBeforeRequest, touchRequestAt, sleep, MIN_REQUEST_GAP_MS,
} from "@/lib/ai";
import { computeDeleteAt, daysUntil, fmtDate, REMINDER_DAYS_BEFORE } from "@/lib/retention";

// 남은 쿨다운을 "3시간 12분" / "45초" 처럼 표시
function untilText(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

// 히스토리 타임스탬프 표시용: "07/02 14:23"
function formatHistDate(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ""; }
}

// initialEntries(평면) → 학생별로 묶기
function groupStudents(students, entries) {
  const byStudent = {};
  for (const e of entries) {
    (byStudent[e.student_id] = byStudent[e.student_id] || []).push({
      ...e,
      activities: Array.isArray(e.activities) ? e.activities : [],
    });
  }
  return students.map((s) => ({ ...s, entries: byStudent[s.id] || [] }));
}

const gnum = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? Infinity : n; };

// 학년/반으로 학생 묶기 (사이드바 분류용)
function groupByClass(students) {
  const groups = {};
  for (const s of students) {
    const g = (s.grade || "").trim();
    const k = (s.klass || "").trim();
    const key = (g || k) ? `${g}|${k}` : "__none__";
    if (!groups[key]) {
      const label = g && k ? `${g}학년 ${k}반` : g ? `${g}학년` : k ? `${k}반` : "미분류";
      groups[key] = { key, label, grade: g, klass: k, students: [] };
    }
    groups[key].students.push(s);
  }
  const arr = Object.values(groups);
  for (const grp of arr) {
    grp.students.sort((a, b) =>
      gnum(a.number) - gnum(b.number) || (a.name || "").localeCompare(b.name || "", "ko"));
  }
  arr.sort((a, b) => {
    if (a.key === "__none__") return 1;
    if (b.key === "__none__") return -1;
    return gnum(a.grade) - gnum(b.grade) || gnum(a.klass) - gnum(b.klass);
  });
  return arr;
}

export default function Workspace({ initialStudents, initialEntries, userEmail, initialRetention }) {
  const router = useRouter();
  const supabase = createClient();

  const [students, setStudents] = useState(() => groupStudents(initialStudents, initialEntries));
  const [activeSid, setActiveSid] = useState(initialStudents[0]?.id || null);
  const [activeEid, setActiveEid] = useState(() => {
    const grouped = groupStudents(initialStudents, initialEntries);
    return grouped[0]?.entries[0]?.id || null;
  });
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [addOpen, setAddOpen] = useState(false);      // 사이드바 학생 추가 폼
  const [navOpen, setNavOpen] = useState(false);      // 모바일 사이드바 드로어
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState({}); // { [groupKey]: true } = 접힘
  const [add, setAdd] = useState({ name: "", school: "", subject: "", grade: "", klass: "", number: "" });
  const [editOpen, setEditOpen] = useState(false); // 학생 정보 수정 모달
  const [edit, setEdit] = useState({ name: "", school: "", grade: "", klass: "", number: "" });
  const [delTarget, setDelTarget] = useState(null); // 삭제 확인 대상 { id, name }
  const [statusFilter, setStatusFilter] = useState("all"); // 학생 목록 상태 필터: all | none | todo | review | done

  // ── 일괄 생성 ──
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchStatus, setBatchStatus] = useState("todo");   // 대상 상태 필터
  const [batchCount, setBatchCount] = useState(1);           // 처리할 학생 수(사용자 입력)
  const [batchOnlyEmpty, setBatchOnlyEmpty] = useState(true); // 이미 초안이 있는 항목은 건너뛰기
  const [batchAutoReview, setBatchAutoReview] = useState(true); // 완료 후 상태를 '검토 필요'로 자동 변경
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null); // { index, total, name, sub, log:[{id,name,ok,msg}], done }
  const batchCancelRef = useRef(false);

  // ── 데이터 보관/자동 삭제 ──
  const [retention, setRetention] = useState(initialRetention); // null이면 아직 학기 종료일을 지정하지 않음
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [semesterEndInput, setSemesterEndInput] = useState(initialRetention?.semester_end_at || "");
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [refineText, setRefineText] = useState("");  // 직접 입력 수정 요청
  const [byteOpen, setByteOpen] = useState(false);   // 바이트 계산기 모달
  const [byteText, setByteText] = useState("");
  const [byteTarget, setByteTarget] = useState(1500);
  const [byteCat, setByteCat] = useState("subject"); // 바이트 계산기 AI 수정 기준 영역
  const [byteLoading, setByteLoading] = useState(false);
  const [byteLoadingMsg, setByteLoadingMsg] = useState("");
  const [byteError, setByteError] = useState("");
  const [byteNotes, setByteNotes] = useState("");
  const [byteRefineText, setByteRefineText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [fallbackInfo, setFallbackInfo] = useState(""); // 방금 생성에서 AI 자동 폴백이 있었으면 안내 문구
  const [historyOpen, setHistoryOpen] = useState(false); // 초안 이력 모달
  const [diffTarget, setDiffTarget] = useState(null);    // 이력 모달 내에서 비교 중인 버전
  const [theme, setThemeState] = useState("light");      // 라이트/다크 모드
  const [provider, setProvider] = useState("gemini");    // 우선 사용할 AI 제공자: gemini | openai
  const [keys, setKeys] = useState({ gemini: [], openai: [] }); // 제공자별 API 키 목록(이 기기에만 저장)
  const [cooldowns, setCooldowns] = useState({});        // 최근 실패해 잠시 건너뛸 후보들
  const [keyOpen, setKeyOpen] = useState(false);         // 키 관리 모달
  const [keyProvider, setKeyProvider] = useState("gemini"); // 모달 내 선택된 제공자 탭
  const [keyInput, setKeyInput] = useState("");          // 모달 임시 입력값
  const keyCount = keys.gemini.length + keys.openai.length;
  const hasKey = keyCount > 0;
  const [installEvt, setInstallEvt] = useState(null); // PWA 설치 프롬프트 이벤트
  const addNameRef = useRef(null);
  const resultRef = useRef(null);
  const saveTimers = useRef({});

  useEffect(() => { if (addOpen) setTimeout(() => addNameRef.current?.focus(), 30); }, [addOpen]);

  // 기기별 저장된 우선 제공자·API 키 목록 불러오기 (구 단일 키 형식은 자동 이관)
  useEffect(() => {
    try {
      const p = localStorage.getItem("ai_provider");
      if (p === "openai" || p === "gemini") setProvider(p);
    } catch {}
    setKeys(loadKeys());
    setCooldowns(loadCooldowns());
  }, []);

  // 기기별 저장된 라이트/다크 모드 불러오기 (실제 적용은 layout.js의 인라인 스크립트가 먼저 처리해 깜빡임을 막음)
  useEffect(() => {
    try { if (localStorage.getItem("ui_theme") === "dark") setThemeState("dark"); } catch {}
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setThemeState(next);
    try { localStorage.setItem("ui_theme", next); } catch {}
    if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }

  // PWA 설치 가능 시점 포착
  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => setInstallEvt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function installApp() {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch {}
    setInstallEvt(null);
  }

  function openKeyModal() {
    setKeyProvider(provider);
    setKeyInput("");
    setCooldowns(loadCooldowns());
    setKeyOpen(true);
  }
  // 키 추가 — 같은 제공자에 여러 개 등록하면 한도 소진 시 자동으로 다음 키로 넘어간다.
  function addKey() {
    const v = keyInput.trim();
    if (!v) return;
    const next = saveKeys(keyProvider, [...(keys[keyProvider] || []), v]);
    setKeys((k) => ({ ...k, [keyProvider]: next }));
    clearCooldownsForKey(v); // 새로 등록한 키에 남아 있던 쿨다운 해제
    setCooldowns(loadCooldowns());
    setKeyInput("");
  }
  function removeKey(p, k) {
    const next = saveKeys(p, (keys[p] || []).filter((x) => x !== k));
    setKeys((s) => ({ ...s, [p]: next }));
    clearCooldownsForKey(k);
    setCooldowns(loadCooldowns());
  }
  // 우선 제공자 지정 — 후보 큐의 맨 앞에 오는 제공자
  function pickPrimary(p) {
    setProvider(p);
    try { localStorage.setItem("ai_provider", p); } catch {}
  }
  function resetCooldowns() {
    clearCooldowns();
    setCooldowns({});
  }

  const student = students.find((s) => s.id === activeSid) || null;
  const entry = student?.entries.find((e) => e.id === activeEid) || null;
  const cat = entry ? catOf(entry.category) : null;

  // ── 저장 (디바운스) ──
  function scheduleSave(eid, fields) {
    setSaveState("saving");
    clearTimeout(saveTimers.current[eid]);
    saveTimers.current[eid] = setTimeout(async () => {
      const { error } = await supabase.from("entries")
        .update({ ...fields, updated_at: new Date().toISOString() }).eq("id", eid);
      setSaveState(error ? "idle" : "saved");
    }, 600);
  }

  // ── 학생 ──
  function selectStudent(id) {
    const s = students.find((x) => x.id === id);
    setActiveSid(id); setActiveEid(s?.entries[0]?.id || null);
    setNavOpen(false);
  }
  async function addStudent() {
    if (!add.name.trim()) return;
    const { data: srow, error } = await supabase.from("students")
      .insert({ name: add.name.trim(), school: add.school.trim(), grade: add.grade.trim(), klass: add.klass.trim(), number: add.number.trim() })
      .select().single();
    if (error || !srow) { setError("학생 추가 실패: " + (error?.message || "")); return; }

    const defActs = [newActivity()];
    const c = catOf("subject");
    const { data: erow } = await supabase.from("entries")
      .insert({ student_id: srow.id, category: "subject", subject: add.subject.trim(), activities: defActs, target: c.target, draft: "", notes: "" })
      .select().single();

    const newStudent = { ...srow, entries: erow ? [{ ...erow, activities: defActs }] : [] };
    setStudents((arr) => [...arr, newStudent]);
    setActiveSid(srow.id); setActiveEid(erow?.id || null);
    // 같은 학급·과목 학생을 이어서 추가하기 쉽도록 학교/과목/학년/반은 유지하고 이름·번호만 비움
    setAdd((p) => ({ name: "", school: p.school, subject: p.subject, grade: p.grade, klass: p.klass, number: "" }));
    setAddOpen(false);
  }
  async function deleteStudent(id) {
    await supabase.from("students").delete().eq("id", id); // entries는 ON DELETE CASCADE
    setStudents((arr) => arr.filter((s) => s.id !== id));
    if (id === activeSid) {
      const rest = students.filter((s) => s.id !== id);
      setActiveSid(rest[0]?.id || null);
      setActiveEid(rest[0]?.entries[0]?.id || null);
    }
  }
  function openEdit() {
    if (!student) return;
    setEdit({
      name: student.name || "", school: student.school || "",
      grade: student.grade || "", klass: student.klass || "", number: student.number || "",
    });
    setError(""); setEditOpen(true);
  }
  async function saveEdit() {
    if (!student || !edit.name.trim()) return;
    const fields = {
      name: edit.name.trim(), school: edit.school.trim(),
      grade: edit.grade.trim(), klass: edit.klass.trim(), number: edit.number.trim(),
    };
    const { error } = await supabase.from("students").update(fields).eq("id", student.id);
    if (error) { setError("학생 정보 수정 실패: " + error.message); return; }
    setStudents((arr) => arr.map((s) => s.id === student.id ? { ...s, ...fields } : s));
    setEditOpen(false);
  }

  // 학생 목록에서 상태 점을 클릭할 때마다 미지정 → 작업 필요 → 검토 필요 → 완료 순으로 순환.
  // 낙관적으로 화면을 먼저 갱신하고, 실패하면 원래 상태로 되돌린다.
  const [statusMenuId, setStatusMenuId] = useState(null); // 상태 점 팝오버가 열린 학생 id

  function openStatusMenu(id, e) {
    e.stopPropagation();
    setStatusMenuId((cur) => (cur === id ? null : id));
  }
  async function pickStatus(id, key, e) {
    e?.stopPropagation();
    setStatusMenuId(null);
    const cur = students.find((s) => s.id === id);
    const prev = cur?.status || "none";
    if (prev === key) return;
    setStudents((arr) => arr.map((s) => s.id === id ? { ...s, status: key } : s));
    const { error } = await supabase.from("students").update({ status: key }).eq("id", id);
    if (error) {
      // status 컬럼이 아직 없는 배포본일 수 있음 — 조용히 되돌리고 안내
      setStudents((arr) => arr.map((s) => s.id === id ? { ...s, status: prev } : s));
      setError("상태 저장 실패: students 테이블에 status 컬럼이 있는지 확인해 주세요 (SQL: alter table students add column status text default 'none';)");
    }
  }
  useEffect(() => {
    if (!statusMenuId) return;
    const close = () => setStatusMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [statusMenuId]);

  // ── 항목 ──
  async function addEntry() {
    if (!student) return;
    const c = catOf(entry?.category || "subject");
    const subjDefault = c.key === "subject" ? (entry?.subject || "") : "";
    const defActs = [newActivity()];
    const { data: erow, error } = await supabase.from("entries")
      .insert({ student_id: student.id, category: c.key, subject: subjDefault, activities: defActs, target: c.target, draft: "", notes: "" })
      .select().single();
    if (error || !erow) { setError("항목 추가 실패: " + (error?.message || "")); return; }
    const e = { ...erow, activities: defActs };
    setStudents((arr) => arr.map((s) => s.id !== activeSid ? s : { ...s, entries: [...s.entries, e] }));
    setActiveEid(e.id);
  }
  async function deleteEntry(eid) {
    await supabase.from("entries").delete().eq("id", eid);
    setStudents((arr) => arr.map((s) => s.id !== activeSid ? s : { ...s, entries: s.entries.filter((e) => e.id !== eid) }));
    if (eid === activeEid) {
      const rest = student.entries.filter((e) => e.id !== eid);
      setActiveEid(rest[0]?.id || null);
    }
  }
  const patchEntry = useCallback((patch, { persist = true } = {}) => {
    setStudents((arr) => arr.map((s) => s.id !== activeSid ? s : {
      ...s, entries: s.entries.map((e) => e.id !== activeEid ? e : { ...e, ...patch }),
    }));
    if (persist) scheduleSave(activeEid, patch);
  }, [activeSid, activeEid]);

  const setActivities = (fn) => {
    const next = fn(entry.activities);
    patchEntry({ activities: next });
  };
  const updateActivity = (id, field, val) => setActivities((a) => a.map((x) => x.id === id ? { ...x, [field]: val } : x));
  const addActivity = () => setActivities((a) => [...a, newActivity()]);
  // 활동 삭제 — 이 활동을 원 활동으로 삼던 심화 탐구들은 독립 활동으로 되돌린다.
  const removeActivity = (id) => setActivities((a) => a.length > 1
    ? a.filter((x) => x.id !== id).map((x) => x.parentId === id ? { ...x, parentId: "" } : x)
    : a);
  // 심화 탐구 연계 지정 — 자기 자신·자신의 하위 활동은 선택할 수 없다(순환 방지).
  const linkActivity = (id, parentId) => updateActivity(id, "parentId", parentId);

  // ── 파일(PDF/PPT)로 활동 채우기 ──
  const fillFileRef = useRef(null);      // 숨겨진 <input type="file">
  const fillTargetRef = useRef(null);    // 어떤 활동에 채울지(activity id)
  const [fillingId, setFillingId] = useState(null);   // 현재 처리 중인 활동 id
  const [fillMsg, setFillMsg] = useState("");
  const [fillErr, setFillErr] = useState({});         // { [activityId]: 오류 메시지 }

  const triggerFileFill = (actId) => {
    if (fillingId) return; // 동시에 하나만 처리
    fillTargetRef.current = actId;
    setFillErr((m) => ({ ...m, [actId]: "" }));
    fillFileRef.current?.click();
  };

  const FILE_UPLOAD_LIMIT = 4 * 1024 * 1024; // 서버(/api/extract-file) 업로드 상한과 동일(Vercel 요청 크기 제한)
  const MAX_EXTRACT_TEXT = 9000;

  // pptx는 zip 안의 슬라이드 XML을 브라우저에서 직접 읽어 텍스트만 뽑는다.
  // → 파일 용량과 무관하게 항상 아주 작은 텍스트만 서버로 보내므로 업로드 용량 제한에 걸리지 않는다.
  async function extractPptxTextClient(file) {
    const { default: JSZip } = await import("jszip");
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const slideFiles = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
        return na - nb;
      });
    const unescapeXml = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const out = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await zip.files[slideFiles[i]].async("text");
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
      const slideText = texts.join(" ").replace(/\s+/g, " ").trim();
      if (slideText) out.push(`[슬라이드 ${i + 1}] ${slideText}`);
    }
    const text = out.join("\n").trim();
    return text.length > MAX_EXTRACT_TEXT ? text.slice(0, MAX_EXTRACT_TEXT) : text;
  }

  // 4MB가 넘는 PDF는 서버 업로드 자체가 막히므로(Vercel 요청 크기 제한),
  // 브라우저에서 각 페이지를 낮은 해상도 JPEG로 렌더링해 용량을 줄인 뒤 이미지로 보낸다(압축 → Gemini 이미지 인식).
  const PDF_COMPRESS_PRESETS = [
    { scale: 1.4, quality: 0.72 },
    { scale: 1.1, quality: 0.55 },
    { scale: 0.85, quality: 0.4 },
    { scale: 0.65, quality: 0.32 },
  ];
  const PDF_COMPRESS_TARGET_BYTES = 2.5 * 1024 * 1024; // 원본 이미지 바이트 합 목표치(base64 변환 후에도 서버 한도 안에 들도록 여유를 둠)
  const PDF_COMPRESS_MAX_PAGES = 20;

  async function compressPdfToImages(file, onProgress) {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pageCount = Math.min(pdf.numPages, PDF_COMPRESS_MAX_PAGES);
    const truncated = pdf.numPages > PDF_COMPRESS_MAX_PAGES;

    for (let p = 0; p < PDF_COMPRESS_PRESETS.length; p++) {
      const preset = PDF_COMPRESS_PRESETS[p];
      const isLast = p === PDF_COMPRESS_PRESETS.length - 1;
      onProgress?.(`파일이 커서 페이지를 압축하는 중… (${p + 1}/${PDF_COMPRESS_PRESETS.length}차 시도)`);

      const images = [];
      let totalBytes = 0;
      for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: preset.scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        const dataUrl = canvas.toDataURL("image/jpeg", preset.quality);
        const base64 = dataUrl.split(",")[1] || "";
        totalBytes += base64.length * 0.75; // base64 → 원본 바이트 근사치
        images.push({ data: base64, mimeType: "image/jpeg" });
      }

      if (totalBytes <= PDF_COMPRESS_TARGET_BYTES || isLast) {
        return { images, truncated, pageCount, totalPages: pdf.numPages };
      }
    }
  }

  async function onFillFileChange(e) {
    const file = e.target.files?.[0];
    const actId = fillTargetRef.current;
    e.target.value = ""; // 같은 파일을 다시 선택해도 change 이벤트가 발생하도록 초기화
    if (!file || !actId) return;

    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith(".pdf");
    const isPptx = lower.endsWith(".pptx");
    if (!isPdf && !isPptx) {
      setFillErr((m) => ({ ...m, [actId]: "PDF 또는 PPTX 파일만 지원합니다" }));
      return;
    }

    setFillingId(actId);
    setFillErr((m) => ({ ...m, [actId]: "" }));
    setFillMsg("파일을 확인하는 중…");

    try {
      const act = (entry?.activities || []).find((a) => a.id === actId);
      let payload;
      let genOpts = {};

      if (isPptx) {
        // pptx는 항상 브라우저에서 텍스트만 뽑아 보낸다 — 원본 용량과 무관하게 업로드 제한에 걸리지 않는다.
        setFillMsg("PPT에서 텍스트를 추출하는 중…");
        const text = await extractPptxTextClient(file);
        if (!text) throw Object.assign(new Error("PPT에서 텍스트를 찾지 못했습니다. 이미지 위주의 자료일 수 있어요."), { friendly: true });
        payload = { mode: "extract", category: entry.category, subject: entry.subject, existingTitle: act?.title || "", fileText: text };
      } else if (file.size <= FILE_UPLOAD_LIMIT) {
        // 4MB 이하 PDF — 기존 방식대로 서버에 업로드해 텍스트 추출(스캔본이면 서버가 자동으로 비전 모드로 응답).
        setFillMsg("파일에서 텍스트를 추출하는 중…");
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/extract-file", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "파일을 읽지 못했습니다");

        payload = data.scanned
          ? { mode: "extract", category: entry.category, subject: entry.subject, existingTitle: act?.title || "", fileBase64: data.fileBase64, fileMime: data.mimeType }
          : { mode: "extract", category: entry.category, subject: entry.subject, existingTitle: act?.title || "", fileText: data.text };
        if (data.scanned) genOpts = { forceProvider: "gemini" };
      } else {
        // 4MB 초과 PDF — 서버 업로드 자체가 막히므로, 브라우저에서 페이지를 압축 이미지로 만들어 보낸다.
        const { images, truncated, pageCount, totalPages } = await compressPdfToImages(file, setFillMsg);
        if (!images?.length) throw new Error("PDF 페이지를 읽지 못했습니다");
        if (truncated) {
          setFillErr((m) => ({ ...m, [actId]: `페이지가 많아 앞 ${pageCount}장(전체 ${totalPages}장)만 분석했어요.` }));
        }
        payload = { mode: "extract", category: entry.category, subject: entry.subject, existingTitle: act?.title || "", fileImages: images };
        genOpts = { forceProvider: "gemini" };
      }

      const baseMsg = genOpts.forceProvider ? "압축된 페이지를 Gemini로 분석하는 중…" : "파일 내용을 분석해 활동을 채우는 중…";
      const msgOf = stepMsg(baseMsg);
      const result = await callGenerate(payload, (...args) => setFillMsg(msgOf(...args)), genOpts);

      // 이미 내용이 있던 칸은 지우지 않고 파일 요약을 이어붙인다. 빈 칸은 그대로 채운다.
      const mergeField = (cur, added) => {
        if (!added?.trim()) return cur;
        return cur?.trim() ? `${cur.trim()}\n\n[파일 요약 — ${file.name}]\n${added.trim()}` : added.trim();
      };
      setActivities((arr) => arr.map((a) => a.id !== actId ? a : {
        ...a,
        title: a.title?.trim() ? a.title : (result.title || a.title),
        detail: mergeField(a.detail, result.detail),
        meaning: mergeField(a.meaning, result.meaning),
      }));
    } catch (e) {
      setFillErr((m) => ({ ...m, [actId]: e?.friendly ? e.message : (e?.message || "처리 중 문제가 발생했습니다") }));
    } finally {
      setFillingId(null);
      setFillMsg("");
    }
  }

  // 제목을 지정해 활동 추가 — 비어 있는 단일 활동이면 거기에 채우고, 아니면 새로 추가
  const addActivityWithTitle = (title) => setActivities((a) => {
    const onlyEmpty = a.length === 1 && !a[0].title.trim() && !a[0].detail.trim() && !a[0].meaning.trim();
    return onlyEmpty ? [{ ...a[0], title }] : [...a, { ...newActivity(), title }];
  });

  // 모든 학생의 세특(subject) 항목에서 과목별로 사용된 활동 제목을 모은다.
  const subjectTitleLibrary = useMemo(() => {
    const map = {};
    for (const s of students) {
      for (const e of (s.entries || [])) {
        if (e.category !== "subject") continue;
        const subj = (e.subject || "").trim();
        if (!subj) continue;
        for (const a of (e.activities || [])) {
          const t = (a.title || "").trim();
          if (!t) continue;
          (map[subj] = map[subj] || new Set()).add(t);
        }
      }
    }
    const out = {};
    for (const k in map) out[k] = [...map[k]];
    return out;
  }, [students]);

  const subjKey = (entry?.subject || "").trim();
  const isSubjectEntry = cat?.key === "subject";
  const allSubjectTitles = isSubjectEntry && subjKey ? (subjectTitleLibrary[subjKey] || []) : [];
  const presentTitles = new Set((entry?.activities || []).map((a) => (a.title || "").trim()).filter(Boolean));
  const suggestedTitles = allSubjectTitles.filter((t) => !presentTitles.has(t));

  const hasContent = entry?.activities.some((a) => a.title.trim() || a.detail.trim());

  // ── 활동 트리(심화 탐구 연계) — 화면 표시 순서·번호는 이 트리를 따른다 ──
  const actNodes = useMemo(() => activityTree(entry?.activities || []), [entry?.activities]);
  const actTitleOf = (a) => (a.title || "").trim() || "제목 없음";
  // '이 활동은 무엇의 심화 탐구인가' 후보 — 자기 자신과 자신의 하위 활동은 제외(순환 방지)
  const parentOptions = (id) => {
    const banned = descendantIds(entry?.activities || [], id);
    return actNodes.filter((n) => n.act.id !== id && !banned.has(n.act.id));
  };
  const hasLinks = actNodes.some((n) => n.parent);

  // 이력 모달에서 비교 중인 버전과 현재 초안의 단어 단위 diff (복원 시 무엇이 바뀌는지 미리 보기)
  const diffTokens = useMemo(() => {
    if (!diffTarget || !entry) return [];
    return wordDiff(entry.draft || "", diffTarget.draft || "");
  }, [diffTarget, entry?.draft]);

  // 생성된 초안에서 기재 금지 가능성이 있는 표현 사후 검토
  const forbiddenHits = useMemo(() => scanForbiddenTerms(entry?.draft || ""), [entry?.draft]);
  const byteForbiddenHits = useMemo(() => scanForbiddenTerms(byteText), [byteText]);

  // ── AI ── 후보(제공자 × 키 × 모델) 큐를 순서대로 시도한다.
  // 재시도로 풀릴 오류(429 일시 혼잡·5xx)는 서버가 이미 백오프 재시도한 뒤 실패로 돌려주므로,
  // 여기서는 곧바로 '다른 조합'으로 넘어가는 것이 가장 빠른 복구 경로다.
  const SWITCHABLE = new Set(["NO_API_KEY", "BAD_API_KEY", "RATE_LIMIT", "QUOTA_EXHAUSTED", "AI_BUSY", "NETWORK", "UNKNOWN"]);

  // 실패 원인을 사람이 읽을 문장으로 (어떤 키·모델이었는지 함께)
  function causeOf(e, cand) {
    const who = candLabel(cand);
    const shared = e.keySource === "server" ? " (등록된 개인 키가 없어 공용 키로 시도됨)" : "";
    switch (e.code) {
      case "NO_API_KEY":      return `${who}${shared}: API 키가 등록되어 있지 않습니다.`;
      case "BAD_API_KEY":     return `${who}${shared}: API 키가 올바르지 않습니다.`;
      case "QUOTA_EXHAUSTED": return `${who}${shared}: 사용량(한도·크레딧)이 소진되었습니다.`;
      case "RATE_LIMIT":      return `${who}${shared}: 요청이 몰려 한도에 걸렸습니다.`;
      case "AI_BUSY":
      case "NETWORK":         return `${who}: 서버가 혼잡하거나 연결이 불안정합니다.`;
      default:                return `${who}: ${e.detail || e.message || "알 수 없는 오류"}`;
    }
  }
  const isKeyProblem = (e) => e.code === "NO_API_KEY" || e.code === "BAD_API_KEY" || e.code === "QUOTA_EXHAUSTED";

  // 단일 후보 요청 — 실패 시 e.code(서버 에러 코드 또는 NETWORK)를 담아 throw
  async function requestOnce(payload, cand) {
    let res;
    try {
      res = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, provider: cand.provider, model: cand.model, apiKey: cand.apiKey }),
      });
    } catch {
      const e = new Error("네트워크 오류"); e.code = "NETWORK"; throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data?.error || "생성 실패");
      e.code = data?.code || "UNKNOWN";
      e.detail = data?.detail;
      e.retryAfter = data?.retryAfter || 0;
      e.keySource = data?.keySource || "none";
      throw e;
    }
    return {
      draft: data.draft || "", notes: data.notes || "",
      title: data.title || "", detail: data.detail || "", meaning: data.meaning || "",
    };
  }

  // 후보 큐를 순차 시도. 실패한 후보는 쿨다운에 등록해 다음 생성 때 건너뛴다.
  // onStep(cand, i, total, prev) 로 진행 상황(로딩 문구)을 갱신한다.
  // opts.forceProvider가 있으면 그 제공자 후보만 시도한다(예: 스캔 PDF 이미지 인식은 Gemini만 지원).
  async function callGenerate(payload, onStep, opts = {}) {
    const cands = buildCandidates(opts.forceProvider || provider, keys)
      .filter((c) => !opts.forceProvider || c.provider === opts.forceProvider);
    const { queue, cooled } = orderByCooldown(cands, loadCooldowns());
    if (queue.length === 0) {
      const who = opts.forceProvider ? providerLabel(opts.forceProvider) : null;
      const e = new Error(
        who
          ? `스캔 문서 인식에는 ${who} API 키가 필요합니다. [API 키]에서 ${who} 키를 등록해 주세요.`
          : "등록된 API 키가 없습니다. [API 키]에서 키를 등록해 주세요."
      );
      e.friendly = true; openKeyModal(); throw e;
    }

    // 분당 요청 한도(RPM) 초과 예방 — 직전 요청과 너무 가까우면 잠깐 간격을 둔다.
    let wait = waitBeforeRequest();
    while (wait > 0) {
      onStep?.(null, 0, queue.length, null, Math.ceil(wait / 1000));
      await sleep(Math.min(wait, 1000));
      wait = waitBeforeRequest();
    }

    const fails = [];
    for (let i = 0; i < queue.length; i++) {
      const cand = queue[i];
      onStep?.(cand, i, queue.length, fails[fails.length - 1] || null, 0);
      touchRequestAt();
      try {
        const result = await requestOnce(payload, cand);
        if (i > 0) {
          setFallbackInfo(
            `${candLabel(fails[0].cand)}가 응답하지 않아 ${candLabel(cand)}(으)로 자동 전환해 생성했어요.`
          );
        }
        setCooldowns(loadCooldowns());
        return result;
      } catch (e) {
        markCooldown(cand, e.code, e.retryAfter);
        fails.push({ cand, e });
        if (!SWITCHABLE.has(e.code)) break; // 전환해도 소용없는 오류 → 즉시 중단
      }
    }

    setCooldowns(loadCooldowns());
    if (fails.some(({ e }) => isKeyProblem(e))) openKeyModal();
    // 같은 원인끼리 묶어 요약 (예: "Gemini 3개 조합 · 한도 소진")
    const lines = [];
    const seen = new Set();
    for (const f of fails) {
      const line = causeOf(f.e, f.cand);
      if (seen.has(line)) continue;
      seen.add(line); lines.push("· " + line);
    }
    const err = new Error(
      `${fails.length}개 조합을 모두 시도했지만 실패했습니다.\n${lines.join("\n")}\n\n같은 제공자에 다른 API 키를 하나 더 등록하면 한도 소진 시 자동으로 넘어갑니다.`
    );
    err.friendly = true;
    throw err;
  }

  // 로딩 문구 만들기 — 몇 번째 후보를 어떤 모델·키로 시도 중인지 보여준다.
  const stepMsg = (base) => (cand, i, total, prev, waitSec) => {
    if (waitSec) return `요청 간격 조절 중… ${waitSec}초 후 시작`;
    const head = i === 0 ? base : `${prev ? candLabel(prev.cand) + " 실패 → " : ""}${candLabel(cand)}(으)로 전환해 재시도 중…`;
    return total > 1 && i > 0 ? `${head} (${i + 1}/${total})` : head;
  };

  async function runGenerate(payload, msg) {
    setError(""); setCopied(false); setFallbackInfo(""); setLoading(true); setLoadingMsg(msg);
    try {
      const msgOf = stepMsg(msg);
      const { draft, notes } = await callGenerate(payload, (...args) => setLoadingMsg(msgOf(...args)));
      // AI가 초안을 덮어쓰기 전, 기존 초안이 있었다면 이력에 남겨둔다.
      const prevDraft = (entry.draft || "").trim();
      const history = prevDraft
        ? pushHistorySnapshot(entry.history, {
            draft: entry.draft, notes: entry.notes || "",
            label: payload.mode === "refine" ? "AI 다듬기 전" : "새로 작성 전",
          })
        : (entry.history || []);
      patchEntry({ draft, notes, history });
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (e) {
      setError(e?.friendly ? e.message : "생성 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally { setLoading(false); }
  }

  // 현재 초안을 이력에 그대로 저장(수동 체크포인트) — 초안 자체는 바뀌지 않는다.
  function snapshotNow() {
    if (!entry?.draft?.trim()) return;
    patchEntry({
      history: pushHistorySnapshot(entry.history, { draft: entry.draft, notes: entry.notes || "", label: "수동 저장" }),
    });
  }
  // 이력 모달을 닫으면서 비교 상태도 함께 초기화
  function closeHistoryModal() { setHistoryOpen(false); setDiffTarget(null); }
  // 이력의 특정 버전으로 복원 — 복원 전 현재 초안도 이력에 남긴다.
  function restoreVersion(v) {
    if (!entry) return;
    const prevDraft = (entry.draft || "").trim();
    const history = prevDraft && prevDraft !== v.draft
      ? pushHistorySnapshot(entry.history, { draft: entry.draft, notes: entry.notes || "", label: "복원 전" })
      : (entry.history || []);
    patchEntry({ draft: v.draft, notes: v.notes || "", history });
    closeHistoryModal();
  }
  function removeVersion(id) {
    patchEntry({ history: (entry.history || []).filter((h) => h.id !== id) });
  }
  const generate = () => runGenerate(
    { mode: "generate", category: entry.category, subject: entry.subject, target: entry.target, activities: entry.activities },
    "활동 기록을 검토하는 중…"
  );
  const refine = (instruction) => entry.draft.trim() && runGenerate(
    { mode: "refine", category: entry.category, subject: entry.subject, target: entry.target, draft: entry.draft, instruction },
    "초안을 다듬는 중…"
  );
  function submitRefine() {
    const t = refineText.trim();
    if (!t || loading || !entry?.draft.trim()) return;
    refine(t);
    setRefineText("");
  }

  // ── 일괄 생성 ──
  // 항목에 채워 넣을 내용(제목/한 일)이 있는지 — 빈 항목은 생성 대상에서 자동 제외
  const entryHasContent = (e) => (e.activities || []).some((a) => a.title?.trim() || a.detail?.trim());
  // 한 학생에서 이번에 생성할 항목들 — 내용이 있고, (옵션에 따라) 아직 초안이 없는 것만
  const entriesToGenerate = (s) =>
    (s.entries || []).filter((e) => entryHasContent(e) && (!batchOnlyEmpty || !e.draft?.trim()));

  // 사이드바에 표시되는 순서(학급별) 그대로 — 검색어와 무관하게 전체 학생 대상
  const batchOrder = useMemo(() => groupByClass(students).flatMap((g) => g.students), [students]);
  // 상태 필터 + 생성할 항목이 1개 이상 있는 학생만 후보로
  const batchTargets = useMemo(
    () => batchOrder.filter((s) => (batchStatus === "all" || (s.status || "none") === batchStatus) && entriesToGenerate(s).length > 0),
    [batchOrder, batchStatus, batchOnlyEmpty]
  );
  const batchMax = batchTargets.length;

  function openBatch() {
    setBatchStatus(statusFilter !== "all" ? statusFilter : "todo");
    setBatchProgress(null);
    setBatchOpen(true);
  }
  // 대상 조건(상태 필터·옵션)이 바뀌면 인원 수 입력을 기본값(전체 대상)으로 맞춘다
  useEffect(() => {
    if (batchOpen && !batchRunning) setBatchCount(Math.max(batchMax, 1));
  }, [batchOpen, batchStatus, batchOnlyEmpty, batchMax, batchRunning]);

  // 특정 항목 하나를 생성 — 현재 화면에 열려 있지 않은 학생/항목도 직접 대상으로 지정해 처리한다.
  async function generateForEntry(studentId, en, onStep) {
    const payload = { mode: "generate", category: en.category, subject: en.subject, target: en.target, activities: en.activities };
    const { draft, notes } = await callGenerate(payload, onStep);
    const prevDraft = (en.draft || "").trim();
    const history = prevDraft
      ? pushHistorySnapshot(en.history, { draft: en.draft, notes: en.notes || "", label: "일괄 생성 전" })
      : (en.history || []);
    const patch = { draft, notes, history };
    setStudents((arr) => arr.map((s) => s.id !== studentId ? s : {
      ...s, entries: s.entries.map((e) => e.id !== en.id ? e : { ...e, ...patch }),
    }));
    await supabase.from("entries").update(patch).eq("id", en.id);
  }

  async function runBatch() {
    const list = batchTargets.slice(0, Math.max(1, Math.min(batchCount, batchMax)));
    if (!list.length) return;
    batchCancelRef.current = false;
    setBatchRunning(true);
    setBatchProgress({ index: 0, total: list.length, name: "", sub: "", log: [], done: false, cancelled: false });

    for (let i = 0; i < list.length; i++) {
      if (batchCancelRef.current) { setBatchProgress((p) => ({ ...p, cancelled: true })); break; }
      const s = list[i];
      setBatchProgress((p) => ({ ...p, index: i, name: s.name, sub: "" }));
      const targets = entriesToGenerate(s);
      const msgOf = stepMsg("생성 중…");
      let failErr = null;
      let doneCount = 0;
      for (const en of targets) {
        if (batchCancelRef.current) break;
        try {
          await generateForEntry(s.id, en, (...args) => setBatchProgress((p) => ({ ...p, sub: msgOf(...args) })));
          doneCount++;
        } catch (e) {
          failErr = e;
          // 등록된 키가 아예 없는 경우 이후 시도도 전부 실패하므로 배치 전체를 중단
          if (e?.message?.includes("등록된 API 키가 없습니다")) {
            setBatchProgress((p) => ({
              ...p, cancelled: true,
              log: [...p.log, { id: s.id, name: s.name, ok: false, msg: "API 키가 없어 배치를 중단했습니다." }],
            }));
            batchCancelRef.current = true;
            break;
          }
        }
      }
      if (batchCancelRef.current && !failErr && doneCount === 0) break;

      const ok = !!doneCount && !failErr;
      setBatchProgress((p) => ({
        ...p,
        log: [...p.log, {
          id: s.id, name: s.name, ok,
          msg: ok ? `${doneCount}개 항목 생성 완료`
               : failErr ? (failErr.friendly ? failErr.message.split("\n")[0] : "생성 실패")
               : "건너뜀",
        }],
      }));
      // 생성에 성공했고 아직 '완료'가 아니라면 '검토 필요'로 자동 전환 — 무엇을 검토해야 할지 놓치지 않도록
      if (ok && batchAutoReview && (s.status || "none") !== "done") {
        await pickStatus(s.id, "review");
      }
    }
    setBatchProgress((p) => ({ ...p, done: true }));
    setBatchRunning(false);
  }
  function cancelBatch() { batchCancelRef.current = true; }
  function closeBatch() {
    if (batchRunning) return;
    setBatchOpen(false);
    setBatchProgress(null);
  }

  // ── 데이터 보관/자동 삭제 ──
  function openRetention() {
    setSemesterEndInput(retention?.semester_end_at || "");
    setRetentionOpen(true);
  }
  // 학기 종료일 저장(신규 지정 또는 재설정) — 저장 시 알림 발송 이력·상태를 초기화한다.
  async function saveSemesterEnd() {
    if (!semesterEndInput) return;
    setRetentionSaving(true);
    const delete_at = computeDeleteAt(semesterEndInput);
    const row = { semester_end_at: semesterEndInput, delete_at, reminder_sent_at: null, status: "active" };
    const { data, error } = await supabase.from("retention_settings")
      .upsert(row, { onConflict: "owner_id" }).select().single();
    setRetentionSaving(false);
    if (error) { setError("보관 설정 저장 실패: " + error.message); return; }
    setRetention(data);
    setBannerDismissed(false);
  }
  // 삭제 예정일을 현재 시점 기준 3개월 뒤로 미루고, 다시 알림을 받을 수 있도록 초기화
  async function extendRetention() {
    if (!retention) return;
    setRetentionSaving(true);
    const base = new Date() > new Date(retention.delete_at) ? new Date() : new Date(retention.delete_at);
    const delete_at = computeDeleteAt(base.toISOString().slice(0, 10));
    const { data, error } = await supabase.from("retention_settings")
      .update({ delete_at, reminder_sent_at: null, status: "active", extended_count: (retention.extended_count || 0) + 1 })
      .eq("owner_id", retention.owner_id).select().single();
    setRetentionSaving(false);
    if (error) { setError("연장 실패: " + error.message); return; }
    setRetention(data);
    setBannerDismissed(false);
  }
  const retentionDaysLeft = retention ? daysUntil(retention.delete_at) : null;
  const showRetentionBanner = !!retention && retentionDaysLeft <= REMINDER_DAYS_BEFORE && !bannerDismissed;

  // ── 바이트 계산기 AI 수정 ──
  async function refineByte(instruction, msg) {
    const src = byteText.trim();
    if (!src || byteLoading) return;
    setByteError(""); setByteNotes(""); setFallbackInfo(""); setByteLoading(true); setByteLoadingMsg(msg);
    try {
      const msgOf = stepMsg(msg);
      const { draft, notes } = await callGenerate({
        mode: "refine", category: byteCat, subject: "", target: byteTarget || 1500, draft: src, instruction,
      }, (...args) => setByteLoadingMsg(msgOf(...args)));
      setByteText(draft || src);
      setByteNotes(notes || "");
    } catch (e) {
      setByteError(e?.friendly ? e.message : "수정 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally { setByteLoading(false); }
  }
  function submitByteRefine() {
    const t = byteRefineText.trim();
    if (!t || byteLoading || !byteText.trim()) return;
    refineByte(t, "내용을 다듬는 중…");
    setByteRefineText("");
  }
  function pickByteCat(key) {
    setByteCat(key);
    setByteTarget(catOf(key).target); // 영역 선택 시 권장 분량을 기준 바이트로
  }

  function copyDraft() {
    navigator.clipboard?.writeText(entry.draft).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }
  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login"); router.refresh();
  }

  const filtered = students
    .filter((s) => !query.trim() || s.name.includes(query.trim()))
    .filter((s) => statusFilter === "all" || (s.status || "none") === statusFilter);
  const searching = !!query.trim();
  const groups = groupByClass(filtered);
  const toggleGroup = (key) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  // 상태 필터 칩에 표시할 학생 수(검색어는 반영하되 상태 필터 자체는 무시하고 센다)
  const statusCounts = STUDENT_STATUSES.reduce((acc, st) => {
    acc[st.key] = students.filter((s) => !query.trim() || s.name.includes(query.trim()))
      .filter((s) => (s.status || "none") === st.key).length;
    return acc;
  }, {});
  const bytes = entry ? neisBytes(entry.draft) : 0;
  const over = entry ? bytes > entry.target : false;
  const gaugePct = entry ? Math.min((bytes / Math.max(entry.target, 1)) * 100, 100) : 0;
  const gaugeClass = entry ? (over ? "over" : bytes > entry.target * 0.9 ? "near" : "") : "";

  // 바이트 계산기
  const byteBytes = neisBytes(byteText);
  const byteOver = byteTarget > 0 && byteBytes > byteTarget;
  const bytePct = byteTarget > 0 ? Math.min((byteBytes / byteTarget) * 100, 100) : 0;
  const byteGauge = byteOver ? "over" : (byteTarget > 0 && byteBytes > byteTarget * 0.9) ? "near" : "";

  // ── 시도 계획(후보 큐) 미리보기 — 키·모델·제공자를 어떤 순서로 시도하는지 ──
  const attemptPlan = useMemo(
    () => orderByCooldown(buildCandidates(provider, keys), cooldowns).queue,
    [provider, keys, cooldowns]
  );
  const attemptCount = attemptPlan.length;
  const cooledCount = attemptPlan.filter((c) => cooldowns[candId(c)] > Date.now()).length;
  // 특정 키의 상태 문구 — 그 키로 만든 조합 중 몇 개가 쿨다운(건너뛰기) 중인지
  const modelsCooled = (p, k) => {
    const all = PROVIDERS[p].models.map((m) => ({ provider: p, model: m, apiKey: k }));
    const n = all.filter((c) => cooldowns[candId(c)] > Date.now()).length;
    if (n === 0) return "";
    return n === all.length ? "한도 도달 · 잠시 건너뜀" : `모델 ${n}/${all.length} 건너뜀`;
  };

  return (
    <div className="sg-app">
      {navOpen && <div className="sg-scrim" onClick={() => setNavOpen(false)} />}

      {/* ───────────── 사이드바 ───────────── */}
      <aside className={"sg-side" + (navOpen ? " open" : "")}>
        <div className="sg-side-brand">
          <div className="sg-side-mark">생활기록부 도우미<small>학교생활기록부 초안 작성 · 교사용</small></div>
        </div>

        <div className="sg-side-tools">
          <button className={"sg-newbtn" + (addOpen ? " open" : "")} onClick={() => setAddOpen((o) => !o)}>
            {addOpen ? "✕ 닫기" : "＋ 새 학생 추가"}
          </button>
          <button className="sg-batchbtn" onClick={openBatch}>⚡ 일괄 생성</button>
          <input className="sg-search" placeholder="학생 이름 검색"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {addOpen && (
          <div className="sg-addform">
            <input ref={addNameRef} placeholder="이름" value={add.name}
                   onChange={(e) => setAdd({ ...add, name: e.target.value })}
                   onKeyDown={(e) => e.key === "Enter" && addStudent()} />
            <input placeholder="학교 (선택)" value={add.school}
                   onChange={(e) => setAdd({ ...add, school: e.target.value })}
                   onKeyDown={(e) => e.key === "Enter" && addStudent()} />
            <input placeholder="과목 (세특 기본 과목, 선택)" value={add.subject}
                   onChange={(e) => setAdd({ ...add, subject: e.target.value })}
                   onKeyDown={(e) => e.key === "Enter" && addStudent()} />
            <div className="sg-add-row">
              <input placeholder="학년" value={add.grade} onChange={(e) => setAdd({ ...add, grade: e.target.value })} />
              <input placeholder="반" value={add.klass} onChange={(e) => setAdd({ ...add, klass: e.target.value })} />
              <input placeholder="번호" value={add.number} onChange={(e) => setAdd({ ...add, number: e.target.value })} />
              <button className="sg-addbtn" onClick={addStudent} disabled={!add.name.trim()}>추가</button>
            </div>
          </div>
        )}

        <div className="sg-side-list">
          <div className="sg-list-label">학생 {students.length}명 · {groupByClass(students).length}개 학급</div>

          <div className="sg-statusbar" role="group" aria-label="상태별 보기">
            <button className={"sg-statuschip all" + (statusFilter === "all" ? " on" : "")}
                    onClick={() => setStatusFilter("all")}>전체</button>
            {STUDENT_STATUSES.filter((st) => st.key !== "none").map((st) => (
              <button key={st.key} className={"sg-statuschip" + (statusFilter === st.key ? " on" : "")}
                      onClick={() => setStatusFilter((f) => f === st.key ? "all" : st.key)}
                      title={st.hint}>
                <span className="sg-statuschip-dot" style={{ background: st.dot }} />
                {st.label}{statusCounts[st.key] ? ` ${statusCounts[st.key]}` : ""}
              </button>
            ))}
          </div>

          {groups.map((grp) => {
            const isCollapsed = !searching && collapsed[grp.key];
            return (
              <div className="sg-group" key={grp.key}>
                <button
                  className={"sg-group-head" + (isCollapsed ? " collapsed" : "") + (searching ? " no-toggle" : "")}
                  onClick={searching ? undefined : () => toggleGroup(grp.key)}
                >
                  {!searching && <span className="sg-group-caret">▾</span>}
                  <span className="sg-group-name">{grp.label}</span>
                  <span className="sg-group-count">{grp.students.length}</span>
                </button>
                {!isCollapsed && grp.students.map((s) => {
                  const st = statusOf(s.status || "none");
                  return (
                    <div key={s.id} className={"sg-srow" + (s.id === activeSid ? " on" : "")} onClick={() => selectStudent(s.id)}>
                      <div className="sg-srow-av">{(s.name || "?").trim().charAt(0)}</div>
                      <div className="sg-srow-main">
                        <div className="sg-srow-name">{s.name}</div>
                        <div className="sg-srow-meta">{s.number ? `${s.number}번 · ` : ""}{s.entries.length}개 항목</div>
                      </div>
                      <div className="sg-srow-status">
                        <button className="sg-srow-dot" style={{ background: st.dot }}
                                title={`상태: ${st.label} (클릭해 변경)`}
                                onClick={(e) => openStatusMenu(s.id, e)} aria-label="학생 상태 변경" />
                        {statusMenuId === s.id && (
                          <div className="sg-statusmenu" onClick={(e) => e.stopPropagation()}>
                            {STUDENT_STATUSES.map((opt) => (
                              <button key={opt.key}
                                      className={"sg-statusmenu-item" + ((s.status || "none") === opt.key ? " on" : "")}
                                      onClick={(e) => pickStatus(s.id, opt.key, e)}>
                                <span className="sg-statusmenu-dot" style={{ background: opt.dot }} />
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="sg-srow-x" onClick={(e) => { e.stopPropagation(); setDelTarget({ id: s.id, name: s.name }); }} aria-label="학생 삭제">✕</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="sg-list-empty">
              {students.length ? "검색 결과가 없습니다." : "위 ＋ 새 학생 추가로\n학생을 등록하세요."}
            </div>
          )}
        </div>

        <div className="sg-side-foot">
          <div className="sg-foot-user">
            <span className="sg-foot-dot" />
            <span className="sg-foot-email">{userEmail}</span>
            <span className="sg-topbar-spacer" />
            <span className={"sg-save sg-save-" + saveState}>
              {saveState === "saving" ? "저장 중…" : saveState === "saved" ? "저장됨 ✓" : ""}
            </span>
          </div>
          <div className="sg-foot-actions">
            <button className="sg-fbtn" onClick={() => setByteOpen(true)}>바이트 계산기</button>
            <button className={"sg-fbtn key" + (hasKey ? " on" : "")} onClick={openKeyModal}>
              API 키{hasKey ? ` ${keyCount}개 ✓` : ""}
            </button>
            <button className={"sg-fbtn" + (retention ? " on" : "")} onClick={openRetention}>
              ⏳ 데이터 보관{retention ? ` D-${Math.max(retentionDaysLeft, 0)}` : ""}
            </button>
            <button className="sg-fbtn" onClick={toggleTheme}>{theme === "dark" ? "☀️ 라이트모드" : "🌙 다크모드"}</button>
            {installEvt && <button className="sg-fbtn install" onClick={installApp}>⬇ 앱 설치</button>}
            <button className="sg-fbtn danger" onClick={signOut}>로그아웃</button>
          </div>
          {hasKey && (
            <p className="sg-fallback-hint">
              {attemptCount > 1
                ? `⚡ 자동 전환 ${attemptCount}단계 — 한도·혼잡이 걸리면 다른 키·모델·제공자로 즉시 넘어가요.`
                : "키를 하나 더 등록하면 한도 소진·혼잡 시 자동으로 다른 조합으로 넘어가요."}
              {cooledCount > 0 && ` · 잠시 건너뛰는 조합 ${cooledCount}개`}
            </p>
          )}
        </div>
      </aside>

      {/* ───────────── 메인 ───────────── */}
      <div className="sg-main">
        <div className="sg-topbar">
          <button className="sg-burger" onClick={() => setNavOpen(true)} aria-label="메뉴">☰</button>
          {student ? (
            <div className="sg-topbar-id">
              <span className="sg-topbar-name">{student.name}</span>
              {studentMeta(student) && <span className="sg-topbar-meta">{studentMeta(student)}</span>}
            </div>
          ) : (
            <span className="sg-topbar-name" style={{ fontSize: 18 }}>생활기록부 도우미</span>
          )}
          <span className="sg-topbar-spacer" />
          {student && <button className="sg-topbar-edit" onClick={openEdit}>학생 정보 수정</button>}
        </div>

        {!hasKey && (
          <div className="sg-keybanner">
            <span className="sg-keybanner-icon">🔑</span>
            <div className="sg-keybanner-text">
              <b>AI 초안 생성에는 본인 API 키가 필요해요.</b>
              <span>Gemini 또는 ChatGPT 키를 무료로 발급받아 등록하면 바로 사용할 수 있어요. <b>키를 여러 개 등록</b>해두면 한도 소진·서버 혼잡 시 다른 키·모델·제공자로 자동 전환됩니다. 키는 이 브라우저에만 저장되고 서버에는 보관되지 않습니다.</span>
            </div>
            <button className="sg-keybanner-btn" onClick={openKeyModal}>API 키 등록</button>
          </div>
        )}

        {showRetentionBanner && (
          <div className={"sg-retbanner" + (retentionDaysLeft <= 0 ? " urgent" : "")}>
            <span className="sg-keybanner-icon">⏳</span>
            <div className="sg-keybanner-text">
              <b>
                {retentionDaysLeft <= 0
                  ? "학생 데이터가 곧 삭제 처리됩니다."
                  : `학생 데이터가 ${retentionDaysLeft}일 후(${fmtDate(retention.delete_at)}) 삭제될 예정이에요.`}
              </b>
              <span>삭제 시 그 시점까지의 전체 데이터를 JSON으로 백업해 가입 이메일로 보내드린 뒤 삭제합니다. 계속 사용하시려면 지금 연장해 주세요.</span>
            </div>
            <button className="sg-keybanner-btn" onClick={extendRetention} disabled={retentionSaving}>
              {retentionSaving ? "연장 중…" : "3개월 연장"}
            </button>
            <button className="sg-retbanner-x" onClick={() => setBannerDismissed(true)} aria-label="닫기">✕</button>
          </div>
        )}

        {!student ? (
          <div className="sg-blank">
            <div>
              <div className="sg-blank-mark">생기부</div>
              <h2>학생을 추가해 시작하세요</h2>
              <p>왼쪽 <b>＋ 새 학생 추가</b>로 학생을 등록하면<br />영역별 생기부 초안 작성을 시작할 수 있습니다.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="sg-tabs">
              {student.entries.map((e) => {
                const c = catOf(e.category);
                return (
                  <button key={e.id} className={"sg-tab" + (e.id === activeEid ? " on" : "")} onClick={() => setActiveEid(e.id)}>
                    {c.short}{c.needsSubject && e.subject ? `·${e.subject}` : ""}
                    <span className="sg-tab-x" onClick={(ev) => { ev.stopPropagation(); deleteEntry(e.id); }}>✕</span>
                  </button>
                );
              })}
              <button className="sg-tab add" onClick={addEntry}>＋ 새 항목</button>
            </div>

            <div className="sg-canvas">
              {entry && (
                <>
                  <div className="sg-card">
                    <div className="sg-eyebrow">영역 · 분량</div>
                    <div className="sg-chips">
                      {CATEGORIES.map((c) => (
                        <button key={c.key} className={"sg-chip" + (c.key === entry.category ? " on" : "")}
                                onClick={() => patchEntry({ category: c.key })}>{c.label}</button>
                      ))}
                    </div>
                    <div className="sg-row">
                      {cat.needsSubject && (
                        <div className="sg-field" style={{ flex: 1, minWidth: 200 }}>
                          <label>과목</label>
                          <input className="sg-input" placeholder="예) 통합과학, 문학, 미적분"
                                 value={entry.subject || ""} onChange={(e) => patchEntry({ subject: e.target.value })} />
                        </div>
                      )}
                      <div className="sg-field" style={{ width: 170 }}>
                        <label>권장 분량 <span className="sub">(NEIS 바이트)</span></label>
                        <input className="sg-input" type="number" min={300} max={4000} step={50}
                               value={entry.target} onChange={(e) => patchEntry({ target: Number(e.target.value) || 0 })} />
                      </div>
                    </div>
                  </div>

                  <div className="sg-card">
                    <div className="sg-eyebrow">활동 기록</div>
                    <p className="sg-help">
                      <b>한 일 / 관찰</b>은 사실 위주로, <b>의미 / 성장</b>은 드러난 역량이나 변화를 적으면 초안 품질이 좋아집니다.
                      {" "}어떤 활동이 다른 활동에서 이어진 후속 탐구라면 <b>심화 탐구 연계</b>로 지정하세요. AI가 두 활동을 <b>하나의 이어진 탐구 흐름</b>으로 엮어 서술합니다.
                      {" "}활동지·발표자료가 있다면 <b>PDF·PPT로 채우기</b> 버튼으로 파일을 올려 핵심 내용을 자동으로 채워 넣을 수 있습니다.
                    </p>
                    {hasLinks && (
                      <div className="sg-chain">
                        <span className="sg-chain-label">탐구 심화 흐름</span>
                        <div className="sg-chain-list">
                          {actNodes.filter((n) => n.depth === 0 && actNodes.some((m) => m.label.startsWith(n.label + "-")))
                            .map((n) => {
                              const chain = actNodes.filter((m) => m.label === n.label || m.label.startsWith(n.label + "-"));
                              return (
                                <div className="sg-chain-row" key={n.act.id}>
                                  {chain.map((m, i) => (
                                    <span key={m.act.id}>
                                      {i > 0 && <span className="sg-chain-arrow"> → </span>}
                                      <span className="sg-chain-node">{actTitleOf(m.act)}</span>
                                    </span>
                                  ))}
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                    {isSubjectEntry && subjKey && suggestedTitles.length > 0 && (
                      <div className="sg-suggest">
                        <span className="sg-suggest-label">같은 과목「{subjKey}」 활동 제목 불러오기</span>
                        <div className="sg-suggest-chips">
                          {suggestedTitles.map((t) => (
                            <button key={t} type="button" className="sg-suggest-chip"
                                    onClick={() => addActivityWithTitle(t)}>＋ {t}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    <input ref={fillFileRef} type="file" accept=".pdf,.pptx"
                           style={{ display: "none" }} onChange={onFillFileChange} />
                    <div className="sg-acts">
                      {actNodes.map(({ act: a, depth, label, parent }) => (
                        <div className={"sg-act" + (depth > 0 ? " sub" : "")} key={a.id}
                             style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 20 } : undefined}>
                          {parent && (
                            <div className="sg-act-rel">
                              ↳ <b>활동 {parent.label} 「{parent.title || "제목 없음"}」</b>의 심화 탐구
                            </div>
                          )}
                          <div className="sg-act-head">
                            <span className="sg-act-no">{label}</span>
                            <input className="sg-act-title" placeholder="활동 제목 (예: 환경 캠페인 기획)"
                                   list={isSubjectEntry ? "sg-subj-titles" : undefined}
                                   value={a.title} onChange={(e) => updateActivity(a.id, "title", e.target.value)} />
                            <div className="sg-prio" role="group" aria-label="우선순위">
                              <span className="sg-prio-label">우선순위</span>
                              {PRIORITIES.map((p) => (
                                <button key={p.v} type="button"
                                        className={"sg-prio-b p" + p.v + ((a.priority ?? 1) === p.v ? " on" : "")}
                                        title={p.label + " · " + p.hint}
                                        onClick={() => updateActivity(a.id, "priority", p.v)}>
                                  {p.label}
                                </button>
                              ))}
                            </div>
                            <button className="sg-del" onClick={() => removeActivity(a.id)} disabled={entry.activities.length === 1} aria-label="활동 삭제">✕</button>
                          </div>
                          <div className="sg-fill-row">
                            <button type="button" className="sg-fill-btn"
                                    disabled={!!fillingId}
                                    onClick={() => triggerFileFill(a.id)}>
                              📎 {fillingId === a.id ? "분석 중…" : "PDF·PPT로 채우기"}
                            </button>
                            {fillingId === a.id && <span className="sg-fill-msg">{fillMsg}</span>}
                          </div>
                          {fillErr[a.id] && <div className="sg-fill-err">{fillErr[a.id]}</div>}
                          <textarea className="sg-area" rows={2} placeholder="한 일 / 관찰한 내용 — 무엇을, 어떻게 했는지"
                                    value={a.detail} onChange={(e) => updateActivity(a.id, "detail", e.target.value)} />
                          <textarea className="sg-area" rows={2} placeholder="의미 / 성장 — 드러난 역량, 태도, 변화 (선택)"
                                    value={a.meaning} onChange={(e) => updateActivity(a.id, "meaning", e.target.value)} />
                          {entry.activities.length > 1 && (
                            <div className="sg-act-link">
                              <label htmlFor={"lnk-" + a.id}>심화 탐구 연계</label>
                              <select id={"lnk-" + a.id} className="sg-link-sel"
                                      value={a.parentId || ""}
                                      onChange={(e) => linkActivity(a.id, e.target.value)}>
                                <option value="">독립 활동 (연계 없음)</option>
                                {parentOptions(a.id).map((n) => (
                                  <option key={n.act.id} value={n.act.id}>
                                    활동 {n.label}. {actTitleOf(n.act)} 의 심화 탐구
                                  </option>
                                ))}
                              </select>
                              {a.parentId && (
                                <button type="button" className="sg-link-clear" onClick={() => linkActivity(a.id, "")}>연계 해제</button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {isSubjectEntry && allSubjectTitles.length > 0 && (
                      <datalist id="sg-subj-titles">
                        {allSubjectTitles.map((t) => <option key={t} value={t} />)}
                      </datalist>
                    )}
                    <button className="sg-addact" onClick={addActivity}>＋ 활동 추가</button>
                  </div>

                  <button className="sg-generate" onClick={generate} disabled={!hasContent || loading}>
                    {loading ? loadingMsg : "생기부 초안 작성"}
                  </button>
                  {!hasContent && <p className="sg-hint">활동을 한 개 이상 입력하면 작성할 수 있어요.</p>}

                  <div className="sg-card sg-result" ref={resultRef}>
                    <div className="sg-result-top">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="sg-result-eyebrow">초안 · {cat.label}{cat.needsSubject && entry.subject ? ` · ${entry.subject}` : ""}</div>
                        {entry.draft && (
                          <>
                            <div className="sg-count">
                              <span className={over ? "warn" : "ok"}>{bytes}바이트</span>
                              <span className="dim"> / {entry.target}바이트 · {charCount(entry.draft)}자</span>
                              {over && <span className="warn"> · 초과</span>}
                            </div>
                            <div className="sg-gauge"><div className={"sg-gauge-fill " + gaugeClass} style={{ width: gaugePct + "%" }} /></div>
                          </>
                        )}
                      </div>
                      {entry.draft && (
                        <div className="sg-result-actions">
                          <button className="sg-copy" onClick={snapshotNow} title="현재 초안을 이력에 저장">스냅샷</button>
                          <button className="sg-copy" onClick={() => { setDiffTarget(null); setHistoryOpen(true); }}>
                            이력{entry.history?.length ? ` (${entry.history.length})` : ""}
                          </button>
                          <button className="sg-copy" onClick={copyDraft}>{copied ? "복사됨 ✓" : "복사"}</button>
                        </div>
                      )}
                    </div>

                    {fallbackInfo && <div className="sg-fallback-notice">⚡ {fallbackInfo}</div>}
                    {error && <div className="sg-error">{error}</div>}

                    {!entry.draft && !loading && (
                      <div className="sg-empty">
                        <div className="sg-empty-mark">기재</div>
                        <p>활동을 입력하고 <b>생기부 초안 작성</b>을 누르면<br />여기에 초안이 나타납니다.</p>
                      </div>
                    )}
                    {loading && !entry.draft && <div className="sg-empty"><p>{loadingMsg}</p></div>}

                    {entry.draft && (
                      <>
                        <div className="sg-draft-label">본문 — 직접 수정하면 자동 저장되고 바이트 수도 다시 계산됩니다.</div>
                        <textarea className="sg-draft" value={entry.draft} spellCheck={false}
                                  onChange={(e) => patchEntry({ draft: e.target.value })} />
                        {entry.notes && <div className="sg-notes"><span className="sg-notes-tag">검토</span>{entry.notes}</div>}
                        {forbiddenHits.length > 0 && (
                          <div className="sg-forbidden">
                            <div className="sg-forbidden-head">⚠️ 검토가 필요할 수 있는 표현 {forbiddenHits.length}건</div>
                            <div className="sg-forbidden-list">
                              {forbiddenHits.map((h, i) => (
                                <div key={i} className="sg-forbidden-item">
                                  <span className="sg-forbidden-tag">{h.category}</span>
                                  <span className="sg-forbidden-context">{h.context}</span>
                                </div>
                              ))}
                            </div>
                            <p className="sg-forbidden-note">자동 감지는 완벽하지 않습니다. 강사·교수 등 특정 인물의 실명은 감지되지 않으니 직접 확인해 주세요.</p>
                          </div>
                        )}
                        <div className="sg-refine">
                          {REFINEMENTS.map((r) => (
                            <button key={r.key} className="sg-rbtn" onClick={() => refine(r.instr)} disabled={loading}>{r.label}</button>
                          ))}
                        </div>
                        <div className="sg-refine-custom">
                          <input className="sg-input sm" placeholder="직접 수정 요청 입력 (예: 리더십이 드러나도록 보강해줘)"
                                 value={refineText} onChange={(e) => setRefineText(e.target.value)}
                                 onKeyDown={(e) => e.key === "Enter" && submitRefine()} disabled={loading} />
                          <button className="sg-refine-send" onClick={submitRefine} disabled={loading || !refineText.trim()}>
                            {loading ? "처리 중…" : "요청"}
                          </button>
                        </div>
                        <p className="sg-disclaimer">AI가 작성한 초안입니다. 사실 여부·기재 가능 항목을 반드시 교사가 검토·수정한 뒤 사용하세요.</p>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* ───────────── 바이트 계산기 모달 ───────────── */}
      {byteOpen && (
        <>
          <div className="sg-overlay" onClick={() => setByteOpen(false)} />
          <div className="sg-keymodal sg-bytemodal">
            <div className="sg-keymodal-title">바이트 계산기</div>
            <p className="sg-keymodal-desc">
              외부에서 작성한 생기부 내용을 붙여넣으면 NEIS 기준 바이트 수를 계산하고, AI로 직접 다듬을 수 있습니다. (한글·한자 3, 영문·숫자·공백·기호 1, 줄바꿈 2바이트)
            </p>

            <div className="sg-byte-cats">
              <span className="sg-byte-cats-label">영역 <small>(AI 수정 기준)</small></span>
              <div className="sg-chips" style={{ marginBottom: 0 }}>
                {CATEGORIES.map((c) => (
                  <button key={c.key} className={"sg-chip" + (c.key === byteCat ? " on" : "")}
                          onClick={() => pickByteCat(c.key)}>{c.short}</button>
                ))}
              </div>
            </div>

            <textarea className="sg-byte-area" placeholder="여기에 생기부 내용을 붙여넣으세요…"
                      value={byteText} onChange={(e) => setByteText(e.target.value)} spellCheck={false} autoFocus />
            <div className="sg-byte-meter">
              <div className="sg-count sg-byte-count">
                <span className={byteOver ? "warn" : "ok"}>{byteBytes}바이트</span>
                <span className="dim"> / {byteTarget}바이트 · {charCount(byteText)}자</span>
                {byteOver && <span className="warn"> · {byteBytes - byteTarget}바이트 초과</span>}
              </div>
              <div className="sg-byte-target">
                <label>기준</label>
                <input className="sg-input sm" type="number" min={0} max={4000} step={50}
                       value={byteTarget} onChange={(e) => setByteTarget(Number(e.target.value) || 0)} />
              </div>
            </div>
            <div className="sg-gauge"><div className={"sg-gauge-fill " + byteGauge} style={{ width: bytePct + "%" }} /></div>

            <div className="sg-byte-ai">
              <div className="sg-byte-ai-label">AI 수정</div>
              <div className="sg-refine" style={{ padding: 0 }}>
                {REFINEMENTS.map((r) => (
                  <button key={r.key} className="sg-rbtn" onClick={() => refineByte(r.instr, "내용을 다듬는 중…")}
                          disabled={byteLoading || !byteText.trim()}>{r.label}</button>
                ))}
              </div>
              <div className="sg-refine-custom" style={{ padding: "10px 0 0" }}>
                <input className="sg-input sm" placeholder="직접 수정 요청 입력 (예: 분량을 1500바이트에 맞춰 줄여줘)"
                       value={byteRefineText} onChange={(e) => setByteRefineText(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && submitByteRefine()} disabled={byteLoading} />
                <button className="sg-refine-send" onClick={submitByteRefine} disabled={byteLoading || !byteRefineText.trim() || !byteText.trim()}>
                  {byteLoading ? "처리 중…" : "요청"}
                </button>
              </div>
              {byteLoading && <p className="sg-byte-status">{byteLoadingMsg || "처리 중…"}</p>}
              {byteNotes && <div className="sg-notes" style={{ margin: "12px 0 0" }}><span className="sg-notes-tag">검토</span>{byteNotes}</div>}
              {byteForbiddenHits.length > 0 && (
                <div className="sg-forbidden" style={{ margin: "12px 0 0" }}>
                  <div className="sg-forbidden-head">⚠️ 검토가 필요할 수 있는 표현 {byteForbiddenHits.length}건</div>
                  <div className="sg-forbidden-list">
                    {byteForbiddenHits.map((h, i) => (
                      <div key={i} className="sg-forbidden-item">
                        <span className="sg-forbidden-tag">{h.category}</span>
                        <span className="sg-forbidden-context">{h.context}</span>
                      </div>
                    ))}
                  </div>
                  <p className="sg-forbidden-note">자동 감지는 완벽하지 않습니다. 강사·교수 등 특정 인물의 실명은 감지되지 않으니 직접 확인해 주세요.</p>
                </div>
              )}
              {fallbackInfo && <div className="sg-fallback-notice" style={{ margin: "12px 0 0" }}>⚡ {fallbackInfo}</div>}
              {byteError && <div className="sg-error" style={{ margin: "12px 0 0" }}>{byteError}</div>}
            </div>

            <div className="sg-keymodal-row">
              <button className="sg-ghost" onClick={() => { setByteText(""); setByteNotes(""); setByteError(""); }}>지우기</button>
              <div className="sg-keymodal-spacer" />
              <button className="sg-addbtn" onClick={() => setByteOpen(false)}>닫기</button>
            </div>
          </div>
        </>
      )}

      {/* ───────────── 초안 이력 모달 ───────────── */}
      {historyOpen && entry && (
        <>
          <div className="sg-overlay" onClick={closeHistoryModal} />
          <div className="sg-keymodal sg-histmodal">
            {!diffTarget ? (
              <>
                <div className="sg-keymodal-title">초안 이력</div>
                <p className="sg-keymodal-desc">
                  AI로 다시 작성·다듬을 때 이전 버전이 자동 저장됩니다. [스냅샷]으로 직접 체크포인트를 남길 수도 있어요. 최근 {MAX_HISTORY}개까지 보관됩니다.
                </p>
                {(!entry.history || entry.history.length === 0) ? (
                  <div className="sg-histempty">아직 저장된 이력이 없습니다.</div>
                ) : (
                  <div className="sg-histlist">
                    {entry.history.map((v) => (
                      <div key={v.id} className="sg-histitem">
                        <div className="sg-histitem-meta">
                          <span>{formatHistDate(v.at)}</span>
                          <span className="dim"> · {neisBytes(v.draft)}바이트{v.label ? ` · ${v.label}` : ""}</span>
                        </div>
                        <div className="sg-histitem-preview">{v.draft.slice(0, 90)}{v.draft.length > 90 ? "…" : ""}</div>
                        <div className="sg-histitem-actions">
                          <button className="sg-ghost" onClick={() => removeVersion(v.id)}>삭제</button>
                          <button className="sg-addbtn" onClick={() => setDiffTarget(v)}>현재와 비교</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="sg-keymodal-row">
                  <div className="sg-keymodal-spacer" />
                  <button className="sg-addbtn" onClick={closeHistoryModal}>닫기</button>
                </div>
              </>
            ) : (
              <>
                <div className="sg-keymodal-title">현재 초안과 비교</div>
                <p className="sg-keymodal-desc">
                  <span className="sg-diff-swatch del" /> 삭제될 내용 · <span className="sg-diff-swatch add" /> 추가될 내용
                  {" — "}{formatHistDate(diffTarget.at)}{diffTarget.label ? ` · ${diffTarget.label}` : ""} 버전으로 복원할 때 기준입니다.
                </p>
                <div className="sg-diffbox">
                  {diffTokens.length === 0 ? (
                    <span className="dim">두 버전의 내용이 같습니다.</span>
                  ) : (
                    diffTokens.map((t, idx) => (
                      <span key={idx} className={t.type === "same" ? undefined : "sg-diff-" + t.type}>{t.text}</span>
                    ))
                  )}
                </div>
                <div className="sg-keymodal-row">
                  <button className="sg-ghost" onClick={() => setDiffTarget(null)}>← 목록으로</button>
                  <div className="sg-keymodal-spacer" />
                  <button className="sg-addbtn" onClick={() => restoreVersion(diffTarget)}>이 버전으로 복원</button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ───────────── 학생 삭제 확인 모달 ───────────── */}
      {delTarget && (
        <>
          <div className="sg-overlay" onClick={() => setDelTarget(null)} />
          <div className="sg-keymodal sg-confirm">
            <div className="sg-keymodal-title">학생을 삭제할까요?</div>
            <p className="sg-keymodal-desc">
              <b>{delTarget.name || "이 학생"}</b> 학생과 작성한 <b>모든 생기부 항목·초안</b>이 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.
            </p>
            <div className="sg-keymodal-row">
              <div className="sg-keymodal-spacer" />
              <button className="sg-ghost" onClick={() => setDelTarget(null)}>취소</button>
              <button className="sg-dangerbtn" onClick={() => { const id = delTarget.id; setDelTarget(null); deleteStudent(id); }}>삭제</button>
            </div>
          </div>
        </>
      )}

      {/* ───────────── 학생 정보 수정 모달 ───────────── */}
      {editOpen && student && (
        <>
          <div className="sg-overlay" onClick={() => setEditOpen(false)} />
          <div className="sg-keymodal">
            <div className="sg-keymodal-title">학생 정보 수정</div>
            <div className="sg-edit-grid">
              <div className="sg-field span2">
                <label>이름</label>
                <input className="sg-input sm" value={edit.name} autoFocus
                       onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                       onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
              </div>
              <div className="sg-field span2">
                <label>학교</label>
                <input className="sg-input sm" value={edit.school}
                       onChange={(e) => setEdit({ ...edit, school: e.target.value })}
                       onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
              </div>
              <div className="sg-field">
                <label>학년</label>
                <input className="sg-input sm" value={edit.grade}
                       onChange={(e) => setEdit({ ...edit, grade: e.target.value })}
                       onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
              </div>
              <div className="sg-field">
                <label>반</label>
                <input className="sg-input sm" value={edit.klass}
                       onChange={(e) => setEdit({ ...edit, klass: e.target.value })}
                       onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
              </div>
              <div className="sg-field">
                <label>번호</label>
                <input className="sg-input sm" value={edit.number}
                       onChange={(e) => setEdit({ ...edit, number: e.target.value })}
                       onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
              </div>
            </div>
            <p className="sg-edit-hint"><b>과목</b>은 각 세특 항목의 <b>과목</b> 칸에서 항목별로 수정할 수 있어요.</p>
            {error && <div className="sg-error" style={{ marginTop: 12 }}>{error}</div>}
            <div className="sg-keymodal-row">
              <div className="sg-keymodal-spacer" />
              <button className="sg-ghost" onClick={() => setEditOpen(false)}>취소</button>
              <button className="sg-addbtn" onClick={saveEdit} disabled={!edit.name.trim()}>저장</button>
            </div>
          </div>
        </>
      )}

      {/* ───────────── API 키 모달 ───────────── */}
      {keyOpen && (
        <>
          <div className="sg-overlay" onClick={() => setKeyOpen(false)} />
          <div className="sg-keymodal sg-keymodal-wide">
            <div className="sg-keymodal-title">AI API 키</div>
            <div className="sg-keymodal-tabs">
              {PROVIDER_KEYS.map((p) => (
                <button key={p} className={"sg-tab" + (keyProvider === p ? " on" : "")}
                        onClick={() => { setKeyProvider(p); setKeyInput(""); }} type="button">
                  {PROVIDERS[p].label}{keys[p].length ? ` ${keys[p].length}` : ""}
                </button>
              ))}
            </div>
            <p className="sg-keymodal-desc">
              키는 이 브라우저에만 저장되며(localStorage) 서버에 보관되지 않습니다.
              {" "}<b>한 제공자에 키를 여러 개</b> 등록할 수 있어요. 생성 시 <b>키 → 모델 → 다른 제공자</b> 순서로 자동 전환하므로,
              무료 등급 일일 한도가 걸려도 다른 키·모델로 곧바로 이어서 작성됩니다.
            </p>

            <div className="sg-keylist">
              {keys[keyProvider].length === 0 ? (
                <div className="sg-keylist-empty">등록된 {PROVIDERS[keyProvider].label} 키가 없습니다.</div>
              ) : keys[keyProvider].map((k, i) => (
                <div className="sg-keyrow" key={k}>
                  <span className="sg-keyrow-no">{i + 1}</span>
                  <span className="sg-keyrow-tag">{keyTag(k)}</span>
                  <span className="sg-keyrow-state">
                    {modelsCooled(keyProvider, k) || "사용 가능"}
                  </span>
                  <button className="sg-keyrow-x" onClick={() => removeKey(keyProvider, k)} aria-label="키 삭제">✕</button>
                </div>
              ))}
            </div>

            <div className="sg-keyadd">
              <input className="sg-input" type="password" placeholder={PROVIDERS[keyProvider].placeholder} value={keyInput}
                     onChange={(e) => setKeyInput(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && addKey()} autoFocus />
              <button className="sg-addbtn" onClick={addKey} disabled={!keyInput.trim()}>＋ 추가</button>
            </div>
            <a className="sg-keymodal-link" href={PROVIDERS[keyProvider].linkHref} target="_blank" rel="noopener noreferrer">
              키가 없으신가요? {PROVIDERS[keyProvider].linkLabel}
            </a>

            <div className="sg-keyprimary">
              <span className="sg-keyprimary-label">먼저 시도할 제공자</span>
              {PROVIDER_KEYS.map((p) => (
                <button key={p} type="button"
                        className={"sg-chip" + (provider === p ? " on" : "")}
                        onClick={() => pickPrimary(p)}>{PROVIDERS[p].label}</button>
              ))}
            </div>

            <div className="sg-keyplan">
              <div className="sg-keyplan-head">시도 순서 ({attemptCount}단계)</div>
              <ol className="sg-keyplan-list">
                {attemptPlan.map((c, i) => {
                  const until = cooldowns[candId(c)];
                  const cooled = until > Date.now();
                  return (
                    <li key={candId(c) + i} className={cooled ? "cooled" : ""}>
                      {candLabel(c)}
                      {cooled && <span className="sg-keyplan-cd">건너뜀 · {untilText(until)} 후 복귀</span>}
                    </li>
                  );
                })}
              </ol>
              {cooledCount > 0 && (
                <button className="sg-ghost sg-keyplan-reset" onClick={resetCooldowns}>건너뛰기 초기화</button>
              )}
            </div>

            <div className="sg-keymodal-row">
              <div className="sg-keymodal-spacer" />
              <button className="sg-addbtn" onClick={() => setKeyOpen(false)}>완료</button>
            </div>
          </div>
        </>
      )}

      {/* ───────────── 일괄 생성 모달 ───────────── */}
      {batchOpen && (
        <>
          <div className="sg-overlay" onClick={closeBatch} />
          <div className="sg-batchmodal">
            <div className="sg-keymodal-title">일괄 생성</div>

            {!batchProgress ? (
              <>
                <p className="sg-keymodal-desc">
                  조건에 맞는 학생을 목록 순서대로 처리합니다. 활동 내용이 채워진 항목만 대상이 되며,
                  이미 등록된 API 키·모델 자동 전환이 그대로 적용됩니다.
                </p>

                <div className="sg-batchrow">
                  <span className="sg-batchrow-label">대상 상태</span>
                  <div className="sg-batchchips">
                    <button className={"sg-chip" + (batchStatus === "all" ? " on" : "")} onClick={() => setBatchStatus("all")}>전체</button>
                    {STUDENT_STATUSES.map((st) => (
                      <button key={st.key} className={"sg-chip" + (batchStatus === st.key ? " on" : "")}
                              onClick={() => setBatchStatus(st.key)}>
                        <span className="sg-statuschip-dot" style={{ background: st.dot }} />{st.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="sg-batchcheck">
                  <input type="checkbox" checked={batchOnlyEmpty} onChange={(e) => setBatchOnlyEmpty(e.target.checked)} />
                  이미 초안이 있는 항목은 건너뛰기
                </label>
                <label className="sg-batchcheck">
                  <input type="checkbox" checked={batchAutoReview} onChange={(e) => setBatchAutoReview(e.target.checked)} />
                  생성 완료 후 학생 상태를 &apos;검토 필요&apos;로 자동 변경
                </label>

                <div className="sg-batchrow">
                  <span className="sg-batchrow-label">처리할 학생 수</span>
                  <input className="sg-batchcount" type="number" min={1} max={Math.max(batchMax, 1)}
                         value={batchCount}
                         onChange={(e) => setBatchCount(Math.max(1, Math.min(Number(e.target.value) || 1, Math.max(batchMax, 1))))} />
                  <span className="sg-batchrow-hint">/ 조건에 맞는 학생 {batchMax}명</span>
                </div>

                {batchMax === 0 ? (
                  <div className="sg-list-empty">조건에 맞으면서 생성할 활동 내용이 있는 학생이 없습니다.</div>
                ) : (
                  <div className="sg-batchpreview">
                    {batchTargets.slice(0, batchCount).map((s, i) => (
                      <span className="sg-batchpreview-item" key={s.id}>{i + 1}. {s.name}</span>
                    ))}
                    {batchMax > batchCount && <span className="sg-batchpreview-more">외 {batchMax - batchCount}명 제외</span>}
                  </div>
                )}

                <div className="sg-keymodal-row">
                  <div className="sg-keymodal-spacer" />
                  <button className="sg-ghost" onClick={closeBatch}>취소</button>
                  <button className="sg-addbtn" onClick={runBatch} disabled={batchMax === 0}>
                    {Math.min(batchCount, batchMax)}명 시작
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="sg-batchbar">
                  <div className="sg-batchbar-fill" style={{ width: `${Math.round(((batchProgress.index + (batchProgress.done ? 1 : 0)) / batchProgress.total) * 100)}%` }} />
                </div>
                <div className="sg-batchnow">
                  {batchProgress.done
                    ? (batchProgress.cancelled ? "중단됨" : "완료됨")
                    : `(${batchProgress.index + 1}/${batchProgress.total}) ${batchProgress.name} 처리 중…`}
                </div>
                {!batchProgress.done && batchProgress.sub && <div className="sg-batchsub">{batchProgress.sub}</div>}

                <div className="sg-batchlog">
                  {batchProgress.log.map((l, i) => (
                    <div className={"sg-batchlog-row" + (l.ok ? "" : " fail")} key={l.id + i}>
                      <span className="sg-batchlog-mark">{l.ok ? "✓" : "✕"}</span>
                      <span className="sg-batchlog-name">{l.name}</span>
                      <span className="sg-batchlog-msg">{l.msg}</span>
                    </div>
                  ))}
                </div>

                <div className="sg-keymodal-row">
                  <div className="sg-keymodal-spacer" />
                  {!batchProgress.done ? (
                    <button className="sg-dangerbtn" onClick={cancelBatch}>중단</button>
                  ) : (
                    <button className="sg-addbtn" onClick={closeBatch}>닫기</button>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ───────────── 데이터 보관 설정 모달 ───────────── */}
      {retentionOpen && (
        <>
          <div className="sg-overlay" onClick={() => setRetentionOpen(false)} />
          <div className="sg-keymodal">
            <div className="sg-keymodal-title">데이터 보관 설정</div>
            <p className="sg-keymodal-desc">
              학기 종료일을 지정하면 그 날짜로부터 <b>3개월 뒤</b>에 학생 데이터가 자동 삭제됩니다.
              삭제 <b>7일 전</b> 가입하신 이메일로 안내 메일을 보내드리며, 삭제 시에는 그 시점의 전체 데이터를
              JSON 백업 파일로 함께 보내드립니다. 안내를 받은 뒤 앱에서 연장하면 3개월 더 미룰 수 있습니다.
            </p>

            <div className="sg-batchrow">
              <span className="sg-batchrow-label">학기 종료일</span>
              <input className="sg-input" type="date" value={semesterEndInput}
                     onChange={(e) => setSemesterEndInput(e.target.value)} style={{ maxWidth: 170 }} />
            </div>

            {semesterEndInput && (
              <p className="sg-keymodal-desc" style={{ margin: "2px 0 14px" }}>
                → 삭제 예정일: <b>{fmtDate(computeDeleteAt(semesterEndInput))}</b>
              </p>
            )}

            {retention && (
              <div className="sg-retstatus">
                <span>현재 설정된 삭제 예정일 <b>{fmtDate(retention.delete_at)}</b> ({Math.max(retentionDaysLeft, 0)}일 남음)</span>
                {retention.reminder_sent_at && <span className="sg-retstatus-sub">안내 메일 발송됨 · {fmtDate(retention.reminder_sent_at)}</span>}
                {retention.extended_count > 0 && <span className="sg-retstatus-sub">지금까지 {retention.extended_count}회 연장함</span>}
                <button className="sg-ghost" onClick={extendRetention} disabled={retentionSaving}>지금 3개월 연장</button>
              </div>
            )}

            <div className="sg-keymodal-row">
              <div className="sg-keymodal-spacer" />
              <button className="sg-ghost" onClick={() => setRetentionOpen(false)}>닫기</button>
              <button className="sg-addbtn" onClick={saveSemesterEnd} disabled={!semesterEndInput || retentionSaving}>
                {retentionSaving ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
