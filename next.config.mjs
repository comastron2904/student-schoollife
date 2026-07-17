/** @type {import('next').NextConfig} */

// 배포마다 고유한 빌드 식별자 — Vercel이면 커밋 SHA, 아니면 빌드 시각.
// next.config는 빌드 시점에 1회 평가되므로 이 값은 해당 배포 전체에서 고정된다.
const BUILD_ID =
  (process.env.VERCEL_GIT_COMMIT_SHA && process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12)) ||
  process.env.NEXT_PUBLIC_BUILD_ID ||
  String(Date.now());

const nextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
};

export default nextConfig;
