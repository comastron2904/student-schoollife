// Resend API로 트랜잭션 메일 발송 — 서버(크론 라우트)에서만 사용.
// 필요 환경변수: RESEND_API_KEY, RESEND_FROM (예: "생기부 도우미 <noreply@yourdomain.com>")
export async function sendEmail({ to, subject, html, attachments }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) throw new Error("RESEND_API_KEY 또는 RESEND_FROM이 설정되지 않았습니다.");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from, to: [to], subject, html,
      // Resend 첨부 형식: content는 base64 문자열(접두어 없이)
      ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.contentBase64 })) } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend 발송 실패 (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

export function reminderEmailHtml({ appUrl, deleteDateText, daysLeft }) {
  return `
  <div style="font-family:'Pretendard',sans-serif;max-width:520px;margin:0 auto;padding:28px;color:#1c2321">
    <h2 style="margin:0 0 14px">생기부 도우미 — 데이터 삭제 안내</h2>
    <p style="line-height:1.7">
      등록하신 학생 데이터가 <b>${deleteDateText}</b>(${daysLeft}일 후)에 자동 삭제될 예정입니다.
      계속 사용하시려면 앱에 접속해 보관 기간을 연장해 주세요.
    </p>
    <p style="line-height:1.7">
      삭제 시에는 그 시점까지의 전체 데이터를 JSON 파일로 만들어 이 메일 주소로 함께 보내드립니다.
    </p>
    <a href="${appUrl}" style="display:inline-block;margin-top:10px;background:#2fb573;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:9px">
      지금 접속해서 연장하기
    </a>
    <p style="margin-top:24px;font-size:12.5px;color:#8b93a1">
      이 메일은 생기부 도우미 자동 발송 메일입니다. 별도 조치를 하지 않으면 안내된 날짜에 데이터가 삭제됩니다.
    </p>
  </div>`;
}

export function deletedEmailHtml({ studentCount, deleteDateText }) {
  return `
  <div style="font-family:'Pretendard',sans-serif;max-width:520px;margin:0 auto;padding:28px;color:#1c2321">
    <h2 style="margin:0 0 14px">생기부 도우미 — 데이터 삭제 완료</h2>
    <p style="line-height:1.7">
      안내드린 대로 <b>${deleteDateText}</b> 기준 학생 데이터(총 ${studentCount}명)가 삭제되었습니다.
      삭제 직전 전체 데이터를 JSON 백업 파일로 첨부해 드립니다. 이 파일은 안전한 곳에 보관해 주세요.
    </p>
    <p style="line-height:1.7">
      다음 학기에 다시 사용하실 때는 앱의 [데이터 보관 설정]에서 새 학기 종료일을 다시 지정해 주세요.
    </p>
    <p style="margin-top:24px;font-size:12.5px;color:#8b93a1">이 메일은 생기부 도우미 자동 발송 메일입니다.</p>
  </div>`;
}
