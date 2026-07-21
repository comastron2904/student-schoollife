// 업로드된 PDF/PPTX에서 텍스트만 뽑아내는 라우트 (AI 호출 없음, 순수 파싱)
// AI 요약은 /api/generate 의 mode:"extract" 에서 이 텍스트를 받아 처리한다.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import JSZip from "jszip";
// pdf-parse의 index.js 최상단에는 모듈 번들 환경에서 오작동하는 디버그 코드가 있어
// (module.parent 미존재 시 존재하지 않는 테스트 PDF를 읽으려다 실패) 내부 파서를 직접 불러온다.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export const maxDuration = 60;

const MAX_TEXT_CHARS = 9000;          // AI 프롬프트에 넣기 적당한 길이로 자름
// Vercel 서버리스 함수는 요청 본문 크기가 약 4.5MB로 제한된다(플랫폼 레벨, 설정으로 못 늘림).
// 이 라우트로의 업로드 자체와, 스캔본을 base64로 실어 /api/generate로 보내는 두 번째 요청 모두 이 한도 안에 들어야 한다.
const MAX_FILE_BYTES = 4 * 1024 * 1024;    // 4MB — 이 라우트로 올릴 수 있는 원본 파일 상한
const MAX_VISION_BYTES = 2.5 * 1024 * 1024; // 2.5MB — 스캔본을 이미지로 AI에 보낼 때의 상한(base64 변환 시 약 1.37배로 커짐)
const MIN_TEXT_LEN = 30; // 이보다 텍스트가 적게 뽑히면 스캔본(이미지)일 가능성이 높다고 판단

function truncate(text) {
  const t = (text || "").replace(/\u0000/g, "").trim();
  if (t.length <= MAX_TEXT_CHARS) return { text: t, truncated: false };
  return { text: t.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function extractPdf(buf) {
  const data = await pdfParse(buf);
  return data.text || "";
}

// pptx는 zip으로 압축된 XML 묶음 — 슬라이드별 <a:t> 텍스트 노드를 순서대로 뽑는다.
async function extractPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });

  const unescapeXml = (s) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
     .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

  const out = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async("text");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
    const slideText = texts.join(" ").replace(/\s+/g, " ").trim();
    if (slideText) out.push(`[슬라이드 ${i + 1}] ${slideText}`);
  }
  return out.join("\n");
}

export async function POST(request) {
  // 로그인 사용자만 호출 허용
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  let form;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: "잘못된 요청" }, { status: 400 }); }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "파일이 너무 큽니다 (4MB 이하만 가능 — 서버 요청 크기 제한)" }, { status: 400 });
  }

  const name = (file.name || "").toLowerCase();

  try {
    const buf = Buffer.from(await file.arrayBuffer());

    let rawText = "";
    if (name.endsWith(".pdf")) {
      rawText = await extractPdf(buf);
    } else if (name.endsWith(".pptx")) {
      rawText = await extractPptx(buf);
    } else if (name.endsWith(".ppt")) {
      return NextResponse.json(
        { error: "구 버전 .ppt 형식은 지원하지 않습니다. PowerPoint에서 .pptx로 저장한 뒤 다시 시도해 주세요." },
        { status: 400 }
      );
    } else {
      return NextResponse.json({ error: "PDF 또는 PPTX 파일만 지원합니다" }, { status: 400 });
    }

    const cleaned = rawText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

    if (cleaned.length < MIN_TEXT_LEN) {
      // 텍스트 레이어가 거의 없다 = 스캔된 이미지 위주의 문서일 가능성이 높다.
      // PDF는 파일 자체를 AI(Gemini)에 이미지로 넘겨 내용을 읽게 한다(별도 OCR 없이).
      if (name.endsWith(".pdf")) {
        if (buf.length > MAX_VISION_BYTES) {
          return NextResponse.json(
            { error: "텍스트가 없는(스캔된) PDF로 보이는데, 이미지 인식으로 처리하기엔 파일이 너무 큽니다. 2.5MB 이하 파일로 다시 시도하거나, 페이지를 나눠 올려 주세요." },
            { status: 400 }
          );
        }
        return NextResponse.json({
          scanned: true,
          fileBase64: buf.toString("base64"),
          mimeType: "application/pdf",
          fileName: file.name,
        });
      }
      return NextResponse.json(
        { error: "파일에서 텍스트를 찾지 못했습니다. 이미지 위주의 자료일 수 있어요. (PPT는 이미지 인식을 지원하지 않습니다)" },
        { status: 400 }
      );
    }

    const { text, truncated } = truncate(cleaned);
    return NextResponse.json({ text, truncated, fileName: file.name });
  } catch (e) {
    return NextResponse.json(
      { error: "파일을 읽는 중 문제가 발생했습니다. 손상된 파일이거나 지원하지 않는 형식일 수 있어요.", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
