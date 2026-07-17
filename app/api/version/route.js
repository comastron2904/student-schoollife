// 현재 배포된 빌드 버전을 반환한다.
// 브라우저는 자신이 로드할 때 번들에 박힌 NEXT_PUBLIC_BUILD_ID와 이 응답을 비교해
// 값이 다르면(= 새 배포가 떴으면) 업데이트 알림을 띄운다.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // 항상 현재 배포의 값을 내려준다(캐시 금지)
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_BUILD_ID || "dev" },
    { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } }
  );
}
