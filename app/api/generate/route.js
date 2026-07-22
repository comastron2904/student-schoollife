// 서버 측 AI 생성 라우트 — AI 키는 여기서만 사용(브라우저 비노출). Gemini / ChatGPT(OpenAI) 지원
// 가동률: 요청 타임아웃 + 429/5xx 지수 백오프 재시도. 재시도로 풀리지 않는 원인(한도 소진·키 오류)은
// 즉시 코드로 반환해, 클라이언트가 다음 후보(다른 키·모델·제공자)로 곧바로 넘어가도록 한다.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { catOf, prioOf, activityTree } from "@/lib/categories";
import { normProvider, providerLabel, isAllowedModel, defaultModel } from "@/lib/ai";

export const maxDuration = 60; // Vercel 함수 실행 한도 — 재시도 여유 확보

// 초안 분량에 충분하면서 분당 토큰(TPM) 한도 소모를 줄이는 값. 429의 상당수가 TPM 기준이다.
const MAX_OUTPUT_TOKENS = 2048;


function buildSystem(cat, subject, target) {
  return `당신은 대한민국 고등학교 학교생활기록부(생기부) 작성을 돕는 전문 보조자입니다. 교사가 입력한 학생 활동 관찰 기록을 바탕으로 교육부 학교생활기록부 기재요령에 부합하는 '${cat.label}'${cat.needsSubject && subject ? ` (과목: ${subject})` : ""} 초안을 작성합니다.

[문체 규칙]
- 명사형 종결('~함', '~음', '~을 보임', '~을 기름' 등)으로 종결한다.
- 학생 이름이나 '나' 등 주어를 쓰지 않는다. 1인칭·구어체·감상문체 금지.
- 관찰 가능한 사실과 구체적 행동을 중심으로, 활동 → 노력·과정 → 역량·성장의 흐름으로 연결한다.
- 추상적 미사여구·과장을 피하고 담백하고 구체적으로 쓴다.
- 여러 활동을 자연스러운 하나의 흐름으로 엮되 단순 나열이 되지 않게 한다.

[영역 관점]
${cat.guide}

[활동별 비중 — 우선순위]
- 일부 활동에는 우선순위가 표시될 수 있다.
- '우선순위: 높음'으로 표시된 활동은 분량과 서술의 비중을 늘려 본문의 중심으로 구체적으로 다룬다.
- '우선순위: 낮음'으로 표시된 활동은 핵심만 간략히 보조적으로 언급하며, 전체 흐름상 자연스럽지 않으면 생략해도 된다.
- 표시가 없는 활동은 보통 비중으로 다룬다.
- 단, 우선순위에 따른 비중 조절이 글의 자연스러움을 해치지 않도록 전체를 하나의 매끄러운 흐름으로 엮는다.

[활동 간 연계 — 심화 탐구]
- 입력에서 어떤 활동이 '(활동 X의 심화 탐구)'로 표시되어 있으면, 그 활동은 원 활동 X에서 출발해 이어진 후속·심화 탐구이다.
- 이런 활동은 반드시 원 활동 바로 뒤에 이어서, 하나의 연결된 탐구 서사로 서술한다. 두 활동을 서로 무관한 별개 문장으로 나열하지 않는다.
- 원 활동에서 생긴 의문·관심·한계가 무엇이었고, 그것이 심화 탐구로 어떻게 확장·구체화되었으며, 그 결과 무엇을 알게 되었는지의 인과 흐름이 드러나게 쓴다.
- '~을 계기로', '~에서 나아가', '~ 과정에서 생긴 의문을 해결하고자', '이를 바탕으로' 같은 연결 표현을 활용하되 상투적 반복은 피한다.
- 연계가 2단계 이상(1차 → 2차 심화)으로 이어질 수 있다. 이 경우 단계가 깊어질수록 탐구의 구체성·전문성과 학생의 자기주도성이 심화되는 과정으로 서술한다.
- 심화 탐구로 이어진 활동 묶음은 하나의 서사 단위로 다루며, 학생의 지적 호기심이 단발성에 그치지 않고 확장되었다는 점이 자연스럽게 드러나도록 본문의 중심축으로 삼는다.

[반드시 제외할 항목 — 기재 금지]
- 특정 대상을 식별할 수 있는 고유명사 전체: 대학명(예: OO대학교), 기관·단체·업체명(상호명), 학원명, 강사·강연자·교수 등 특정 인물의 실명, 교외 기관·대회명
- 교외 수상 실적, 어학시험·인증시험 점수/급수, 모의고사·교내외 시험 성적
- 부모/친인척의 사회·경제적 지위, 특정 상품명·브랜드명
- 논문 등재, 발명·특허 등 미기재 항목
입력에 이런 내용이 있으면 그 대상을 특정하는 이름은 절대 본문에 쓰지 않는다. 가능하면 "지역 전문가", "외부 강사", "관련 기관", "인근 대학" 처럼 대상이 특정되지 않는 일반화된 표현으로 자연스럽게 바꿔 서술하고, 자연스럽게 녹이기 어려우면 그 부분만 생략한다. 무엇을 제외했거나 어떻게 일반화했는지 notes에 간단히 알린다.

[분량] 권장 분량은 한글 약 ${Math.round(target / 3)}자 내외이다. 분량에 억지로 맞추려 하지 말고 활동 내용을 충실하고 자연스럽게 서술하되, 위 권장 글자수를 대략적인 기준으로만 참고한다.

반드시 JSON 형식으로만 출력한다: {"draft": "<생기부 본문>", "notes": "<교사 검토 포인트나 제외한 내용을 1~2문장으로. 없으면 빈 문자열>"}`;
}

function buildUser(cat, activities) {
  // 내용이 있는 활동만 남긴 뒤 트리(심화 탐구 연계) 순서로 정렬한다.
  // 부모가 비어 있어 걸러졌다면 자식은 자동으로 독립 활동으로 취급된다.
  const filled = (activities || []).filter(
    (a) => a.title?.trim() || a.detail?.trim() || a.meaning?.trim()
  );
  const nodes = activityTree(filled);

  const lines = nodes
    .map(({ act: a, label, parent }) => {
      const pr = prioOf(a.priority ?? 1);
      const tag = pr.v === 1 ? "" : ` [우선순위: ${pr.label} — ${pr.emph}]`;
      const rel = parent
        ? ` (활동 ${parent.label}${parent.title ? ` '${parent.title}'` : ""}의 심화 탐구)`
        : "";
      const p = [`활동 ${label}: ${a.title || "(제목 없음)"}${rel}${tag}`];
      if (a.detail?.trim()) p.push(`  - 한 일/관찰: ${a.detail.trim()}`);
      if (a.meaning?.trim()) p.push(`  - 의미/성장: ${a.meaning.trim()}`);
      return p.join("\n");
    })
    .join("\n\n");

  // 심화 탐구 사슬(2개 이상 연결된 흐름)을 따로 요약해 흐름을 명확히 전달
  const chains = nodes
    .filter((n) => n.depth === 0 && nodes.some((m) => m.label.startsWith(n.label + "-")))
    .map((n) => {
      const chain = nodes.filter((m) => m.label === n.label || m.label.startsWith(n.label + "-"));
      return "- " + chain.map((m) => `활동 ${m.label}(${m.act.title || "제목 없음"})`).join(" → ");
    });
  const chainBlock = chains.length
    ? `\n\n[탐구 심화 흐름] 아래 활동들은 앞 활동에서 이어진 심화 탐구입니다. 각 흐름은 하나의 연결된 탐구 서사로 엮어 서술해 주세요.\n${chains.join("\n")}`
    : "";

  return `다음은 한 학생의 활동 관찰 기록입니다.\n\n${lines}${chainBlock}\n\n위 내용을 종합해 '${cat.label}' 초안을 작성해 주세요.`;
}

// ── 파일(PDF/PPT) → 활동 내용 자동 채우기(extract 모드) ──
function buildExtractSystem(cat, subject) {
  return `당신은 대한민국 고등학교 학교생활기록부(생기부) 작성을 돕는 전문 보조자입니다. 교사가 업로드한 수업·활동 자료(발표자료, 활동지, 보고서 등)에서 추출한 텍스트를 읽고, 그 안에 담긴 학생 활동을 '${cat.label}'${cat.needsSubject && subject ? ` (과목: ${subject})` : ""} 항목의 활동 기록 입력칸에 넣을 수 있는 형태로 정리합니다.

[문체 규칙 — 실제 생기부 문장처럼 마무리한다]
- 각 문장은 명사형 종결('~함', '~음', '~을 보임', '~을 기름' 등)으로 끝맺는다. '~했다', '~였습니다' 같은 평서체·구어체로 끝내지 않는다.
- 학생 이름이나 '나' 등 주어를 쓰지 않는다. 1인칭·감상문체 금지.
- 관찰 가능한 사실과 구체적 행동 중심으로 담백하게 쓰고, 추상적 미사여구·과장은 피한다.

[작성할 항목]
- title: 활동을 간단히 나타내는 제목 (10~20자 내외, 명사구)
- detail: 문서에서 확인되는 '한 일 / 관찰' — 무엇을, 어떻게 했는지 구체적으로 (2~4문장, 위 문체 규칙 적용)
- meaning: 문서에서 드러나는 '의미 / 성장' 요소가 있다면 간단히 (1~2문장, 위 문체 규칙 적용). 근거가 부족하면 빈 문자열로 둔다.

[주의]
- 문서에 없는 내용을 지어내지 않는다. 확인되지 않는 부분은 과감히 생략한다.
- 이 항목들은 이후 AI가 여러 활동을 하나로 엮어 최종 생기부 문장을 생성할 때 참고할 '재료'이기도 하므로, 문체를 갖추더라도 실제 활동을 육하원칙에 가깝게 구체적으로 적는다.
- 대학명·기관명·강사 등 특정 인물 실명·수상명·점수 등 생기부 기재 금지 대상은 절대 쓰지 않는다. 가능하면 "지역 전문가", "외부 강사", "관련 기관"처럼 일반화된 표현으로 바꾸고, 자연스럽게 녹이기 어려우면 그 부분만 생략한다. 무엇을 바꾸거나 뺐는지 notes에 짧게 알린다.
- 문서 내용이 특정 학생의 활동이 아니라 일반 자료(예: 교사용 강의안 원본)로만 보이더라도, 그 자료로 무엇을 배우고 활동했을지 합리적으로 추정하지 말고 문서에서 확인되는 내용만 담는다.
- 문서 내용이 활동과 관련이 낮아 보이면 detail에 "문서 내용만으로는 활동을 파악하기 어렵습니다"라고 적고 나머지는 비워 둔다.

반드시 JSON 형식으로만 출력한다: {"title": "<활동 제목>", "detail": "<한 일/관찰, 명사형 종결체>", "meaning": "<의미/성장, 명사형 종결체, 없으면 빈 문자열>", "notes": "<교사 검토 포인트나 제외·일반화한 내용 1문장, 없으면 빈 문자열>"}`;
}

function buildExtractUser(fileText, existingTitle, isVision, imageCount = 1) {
  const titleHint = existingTitle?.trim()
    ? `\n\n참고로 현재 입력된 활동 제목은 "${existingTitle.trim()}"입니다. 문서 내용과 자연스럽게 어울리면 이 제목을 유지하거나 다듬어도 되고, 더 적절한 제목이 있다면 새로 지어도 됩니다.`
    : "";
  if (isVision) {
    const desc = imageCount > 1
      ? `첨부한 이미지들은 문서의 각 페이지(총 ${imageCount}장, 용량 문제로 압축됨)입니다. 텍스트가 아니라 이미지이니 직접 읽고`
      : `첨부한 문서는 스캔된 PDF입니다(텍스트가 아니라 이미지). 문서를 직접 읽고`;
    return `${desc} 활동 내용을 정리해 주세요.${titleHint}`;
  }
  return `다음은 업로드된 문서(PDF/PPT)에서 추출한 텍스트입니다.\n\n"""${fileText}"""${titleHint}\n\n위 문서를 바탕으로 활동 내용을 정리해 주세요.`;
}

// 구조화된 AI 오류 — code(원인)·keySource(개인/공용 키)·retryAfter(초)를 함께 전달
function aiError(code, keySource, detail = "", retryAfter = 0) {
  const e = new Error(code);
  e.code = code; e.keySource = keySource; e.detail = detail; e.retryAfter = retryAfter;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 한 번의 요청 타임아웃 — 응답이 늘어질 때 함수 타임아웃까지 끌려가지 않도록 끊고 다음 후보로 넘긴다.
const REQ_TIMEOUT_MS = 22000;
// 한 제공자 안에서 재시도에 쓸 수 있는 총 예산(이 시간을 넘기면 즉시 포기하고 클라이언트가 다음 후보로)
const RETRY_BUDGET_MS = 30000;
const MAX_ATTEMPTS = 3;

async function fetchTimeout(url, opts, ms = REQ_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// 429 응답에서 "얼마나 기다리라"는 값을 뽑아낸다.
// Gemini: error.details 의 RetryInfo.retryDelay("27s") / OpenAI: Retry-After 헤더
function retryAfterOf(res, body) {
  const h = res?.headers?.get?.("retry-after");
  if (h && !Number.isNaN(Number(h))) return Number(h);
  const hm = res?.headers?.get?.("retry-after-ms");
  if (hm && !Number.isNaN(Number(hm))) return Number(hm) / 1000;
  const m = (body || "").match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Number(m[1]);
  return 0;
}
const backoff = (attempt) => 900 * Math.pow(2, attempt) + Math.random() * 500; // 0.9s → 1.8s → 3.6s(+jitter)

// 제공자별 요청을 공통 재시도 루프로 감싼다.
//  - 5xx·네트워크·타임아웃 → 지수 백오프로 재시도
//  - 429 중 '일시적 혼잡'은 서버가 알려준 대기시간만큼 기다렸다 재시도(단, 예산 안에서)
//  - 429 중 '한도·크레딧 소진'과 키 오류는 재시도해도 소용없으므로 즉시 중단 → 클라이언트가 다음 후보(다른 키·모델·제공자)로 전환
async function withRetry(keySource, doFetch, classify) {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let lastCode = "AI_BUSY";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await doFetch();
    } catch (e) {
      lastCode = e?.name === "AbortError" ? "AI_BUSY" : "NETWORK";
      if (attempt === MAX_ATTEMPTS - 1 || Date.now() + backoff(attempt) > deadline) break;
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return res;

    const body = await res.text().catch(() => "");

    if (res.status >= 500) { // 일시적 서버 오류 → 백오프 재시도
      lastCode = "AI_BUSY";
      if (attempt === MAX_ATTEMPTS - 1 || Date.now() + backoff(attempt) > deadline) break;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.status === 429) {
      const ra = retryAfterOf(res, body);
      if (classify.isQuota(body)) throw aiError("QUOTA_EXHAUSTED", keySource, body.slice(0, 200), ra);
      // 일시적 rate limit: 서버가 알려준 시간(없으면 백오프)만큼 기다렸다 재시도
      const wait = ra ? ra * 1000 : backoff(attempt);
      if (attempt < MAX_ATTEMPTS - 1 && wait <= 8000 && Date.now() + wait < deadline) {
        await sleep(wait);
        lastCode = "RATE_LIMIT";
        continue;
      }
      throw aiError("RATE_LIMIT", keySource, body.slice(0, 200), ra || 60);
    }

    if (classify.isBadKey(res.status, body)) throw aiError("BAD_API_KEY", keySource, body.slice(0, 200));
    throw aiError("UNKNOWN", keySource, `${classify.name} ${res.status} ${body.slice(0, 200)}`);
  }
  throw aiError(lastCode, keySource); // 재시도 예산 소진
}

async function callGemini(systemText, userText, apiKey, model, fileParts) {
  const userKey = (apiKey || "").trim();
  const key = userKey || process.env.GEMINI_API_KEY;
  const keySource = userKey ? "user" : (process.env.GEMINI_API_KEY ? "server" : "none");
  if (!key) throw aiError("NO_API_KEY", keySource);

  // thinking 토큰이 maxOutputTokens를 잠식해 응답이 잘리는 문제 방지.
  const thinkingConfig = model.startsWith("gemini-3") ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  // fileParts가 있으면(스캔 PDF, 압축된 페이지 이미지 등) 파일을 이미지/문서로 함께 보내 Gemini가 직접 읽게 한다(별도 OCR 불필요).
  const parts = (fileParts && fileParts.length)
    ? [...fileParts.map((fp) => ({ inlineData: { mimeType: fp.mimeType || "application/pdf", data: fp.data } })), { text: userText }]
    : [{ text: userText }];
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      thinkingConfig,
    },
  });

  const res = await withRetry(keySource,
    () => fetchTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: payload,
    }),
    {
      name: "Gemini",
      isQuota: (t) => /PerDay|per day|daily limit|GenerateRequestsPerDay|exceeded your current quota/i.test(t),
      isBadKey: (status, t) => (status === 400 || status === 401 || status === 403) &&
        /API_?KEY|api key|PERMISSION_DENIED|credential/i.test(t),
    });

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

async function callOpenAI(systemText, userText, apiKey, model) {
  const userKey = (apiKey || "").trim();
  const key = userKey || process.env.OPENAI_API_KEY;
  const keySource = userKey ? "user" : (process.env.OPENAI_API_KEY ? "server" : "none");
  if (!key) throw aiError("NO_API_KEY", keySource);

  const url = "https://api.openai.com/v1/chat/completions";
  const payload = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userText },
    ],
    temperature: 0.7,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_object" },
  });

  const res = await withRetry(keySource,
    () => fetchTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: payload,
    }),
    {
      name: "OpenAI",
      isQuota: (t) => /insufficient_quota|exceeded your current quota|billing/i.test(t),
      isBadKey: (status) => status === 401 || status === 403,
    });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callAI(provider, model, systemText, userText, apiKey, fileParts) {
  if (provider === "openai") {
    if (fileParts && fileParts.length) throw aiError("UNKNOWN", "none", "OpenAI는 스캔 문서 이미지 인식을 지원하지 않습니다. Gemini API 키로 시도해 주세요.");
    return callOpenAI(systemText, userText, apiKey, model);
  }
  return callGemini(systemText, userText, apiKey, model, fileParts);
}

function parseResult(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();

  // 1) 정상 JSON
  try {
    const o = JSON.parse(clean);
    return { draft: o.draft || "", notes: o.notes || "" };
  } catch {}

  // 2) 잘린/깨진 JSON에서 draft·notes 문자열만 복구
  const grab = (re) => {
    const m = clean.match(re);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  };
  let draft =
    grab(/"draft"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"notes"/) ?? // notes 앞까지
    grab(/"draft"\s*:\s*"((?:[^"\\]|\\.)*)"/) ??               // 닫는 따옴표 있음
    grab(/"draft"\s*:\s*"((?:[^"\\]|\\.)*)$/);                 // 따옴표 없이 잘림
  if (draft != null) {
    const notes = grab(/"notes"\s*:\s*"((?:[^"\\]|\\.)*)"/) || "";
    return { draft, notes };
  }

  // 3) 최후: 원문 그대로
  return { draft: clean, notes: "" };
}

function parseExtractResult(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  try {
    const o = JSON.parse(clean);
    return { title: o.title || "", detail: o.detail || "", meaning: o.meaning || "", notes: o.notes || "" };
  } catch {}
  // 잘린/깨진 JSON이면 최소한 detail이라도 원문에서 건져 온다.
  const m = clean.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const detail = m ? (() => { try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } })() : clean;
  return { title: "", detail, meaning: "", notes: "" };
}

export async function POST(request) {
  // 로그인 사용자만 호출 허용
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "잘못된 요청" }, { status: 400 }); }

  const {
    category, subject = "", target = 1500, activities = [], mode = "generate",
    draft = "", instruction = "", apiKey = "", provider: providerRaw = "gemini", model: modelRaw = "",
    fileText = "", existingTitle = "", fileBase64 = "", fileMime = "", fileImages = [],
  } = body;
  const cat = catOf(category);
  const provider = normProvider(providerRaw);
  const label = providerLabel(provider);
  // 모델은 화이트리스트 안에서만 허용(임의 모델 주입 방지). 없거나 허용 밖이면 기본 모델.
  const model = isAllowedModel(provider, modelRaw) ? modelRaw : defaultModel(provider);

  // 스캔 PDF(단일 base64) + 브라우저에서 미리 압축한 여러 페이지 이미지(fileImages)를 하나의 목록으로 합친다.
  const imageParts = [
    ...(fileBase64.trim() ? [{ data: fileBase64, mimeType: fileMime || "application/pdf" }] : []),
    ...(Array.isArray(fileImages) ? fileImages.filter((im) => im?.data).map((im) => ({ data: im.data, mimeType: im.mimeType || "image/jpeg" })) : []),
  ];

  if (mode === "extract" && !fileText.trim() && imageParts.length === 0) {
    return NextResponse.json({ error: "파일에서 읽은 내용이 없습니다" }, { status: 400 });
  }

  try {
    let systemText, userText, fileParts;
    if (mode === "extract") {
      const isVision = !fileText.trim() && imageParts.length > 0;
      systemText = buildExtractSystem(cat, subject);
      userText = buildExtractUser(fileText, existingTitle, isVision, imageParts.length);
      if (isVision) fileParts = imageParts;
    } else {
      systemText = buildSystem(cat, subject, target);
      userText = mode === "refine"
        ? `다음은 작성된 '${cat.label}' 초안입니다.\n\n"""${draft}"""\n\n[요청] ${instruction}\n같은 JSON 형식으로만 출력해 주세요.`
        : buildUser(cat, activities);
    }

    const text = await callAI(provider, model, systemText, userText, apiKey, fileParts);
    const parsed = mode === "extract" ? parseExtractResult(text) : parseResult(text);
    return NextResponse.json({ ...parsed, provider, model });
  } catch (e) {
    const code = e?.code || "UNKNOWN";
    const keySource = e?.keySource || "none"; // user = 본인 키, server = 배포 공용 키
    const j = (error, status) =>
      NextResponse.json({
        error, code, keySource, provider, model,
        retryAfter: e?.retryAfter || 0, // 클라이언트 쿨다운 계산에 사용
        detail: e?.detail || String(e?.message || e),
      }, { status });

    if (code === "NO_API_KEY")  return j(`${label} API 키가 필요합니다`, 400);
    if (code === "BAD_API_KEY") return j(`${label} API 키가 올바르지 않습니다`, 400);
    if (code === "QUOTA_EXHAUSTED") return j(`${label} 사용량(한도·크레딧)이 소진되었습니다`, 429);
    if (code === "RATE_LIMIT")  return j(`${label} 요청이 일시적으로 몰렸습니다`, 429);
    if (code === "AI_BUSY")     return j(`${label} 서버가 일시적으로 혼잡합니다`, 503);
    if (code === "NETWORK")     return j(`${label} 연결이 불안정합니다`, 503);
    return j("생성 실패", 500);
  }
}
