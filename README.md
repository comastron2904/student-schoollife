# 생활기록부 작성 도우미 (교사용)

학생 활동을 항목별로 입력하면 AI가 학교생활기록부 기재요령에 맞는 초안을 작성해 주는 교사용 웹앱입니다.
로그인 기반이며, **각 선생님은 본인이 만든 학생·초안만** 볼 수 있습니다(Supabase Auth + RLS).

- Next.js (App Router) + Supabase + Vercel
- 영역: 세특 / 자율 / 동아리 / 진로 / 봉사 / 행특
- NEIS 바이트 기준 분량 표시(한글 3 / 영문·숫자·공백 1 / 줄바꿈 2)
- AI 키는 **서버에서만** 사용 → 브라우저에 노출되지 않음

---

## 1. Supabase 설정

1. [supabase.com](https://supabase.com) 에서 프로젝트 생성
2. **SQL Editor** 에 `supabase/schema.sql` 전체를 붙여넣고 실행 (테이블 + RLS 생성)
3. **Project Settings → API** 에서 아래 두 값 복사
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - anon public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. (편의) **Authentication → Sign In / Providers → Email** 에서
   "Confirm email" 을 끄면 가입 즉시 로그인됩니다. 켜두면 확인 메일 링크를 눌러야 합니다.

## 2. AI 키 (Gemini / ChatGPT) — 가동률 우선 설계

교사는 앱 좌측 하단 [API 키]에서 **제공자당 키를 여러 개** 등록할 수 있습니다(브라우저 localStorage에만 저장, 서버 미보관).
생성 시 아래 순서로 **후보를 자동 전환**하며, 한도 소진·혼잡이 걸려도 다음 조합으로 즉시 이어서 작성합니다.

```
Gemini 2.5-flash (키1) → 2.5-flash (키2) → 2.5-flash-lite (키1) → … → ChatGPT gpt-4o-mini → …
```

- **다중 키**: 무료 등급 일일 한도는 키마다 따로 잡히므로, 다른 계정 키를 2~3개 등록하면 한도가 사실상 합산됩니다.
- **모델 폴백**: 무료 등급 쿼터는 모델별로도 따로 잡힙니다. 상위 모델이 429여도 lite 모델은 살아있는 경우가 많습니다.
- **쿨다운**: 한도 소진(3시간)·혼잡(30초~) 조합은 기록해 두었다가 다음 생성에서 건너뜁니다. [API 키] 모달에서 상태 확인·초기화 가능.
- **재시도**: 서버가 429의 `retryDelay`/`Retry-After`를 읽어 그만큼만 기다렸다 재시도하고, 5xx·타임아웃은 지수 백오프로 재시도합니다(요청당 22초 타임아웃).
- **요청 간격**: 연속 생성 시 최소 4.5초 간격을 자동으로 두어 분당 요청 한도(RPM) 초과를 예방합니다.

키를 하나도 등록하지 않으면 서버 환경변수(공용 키)로 폴백합니다.

- **Gemini**: [Google AI Studio](https://aistudio.google.com/app/apikey) → `GEMINI_API_KEY`
- **ChatGPT(OpenAI)**: [OpenAI Platform](https://platform.openai.com/api-keys) → `OPENAI_API_KEY`

사용 모델 목록은 `lib/ai.js` 의 `PROVIDERS[*].models` 에서 수정합니다(서버는 이 목록 안의 모델만 허용).

## 3. 로컬 실행

```bash
cp .env.local.example .env.local   # 값 채우기
npm install
npm run dev                        # http://localhost:3000
```

## 4. GitHub → Vercel 배포

1. 이 폴더를 GitHub 저장소로 push
2. [Vercel](https://vercel.com) 에서 해당 저장소 Import
3. **Environment Variables** 에 등록 (AI 키는 필요한 제공자만 등록해도 됨 — 교사가 본인 키를 등록하면 그걸 우선 사용):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`
4. Deploy

> ⚠️ `NEXT_PUBLIC_*` 는 브라우저에 노출되지만 anon 키는 RLS로 보호되어 안전합니다.
> `GEMINI_API_KEY`/`OPENAI_API_KEY` 는 `NEXT_PUBLIC_` 접두사가 없어 서버에서만 쓰이며 노출되지 않습니다.

---

## 5. 데이터 보관·자동 삭제 (학기 단위)

교사가 앱 하단 **⏳ 데이터 보관**에서 학기 종료일을 지정하면, 그 날짜 + **3개월** 뒤에 학생 데이터가
자동 삭제됩니다. 삭제 **7일 전** 가입 이메일로 안내 메일을 보내고(연장 가능), 실제 삭제 시에는
그 시점까지의 전체 데이터를 **JSON 백업 파일로 첨부**해 메일로 보낸 뒤 삭제합니다.

### 5-1. 테이블 생성 (Supabase SQL 편집기)

```sql
create table if not exists retention_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  semester_end_at date not null,
  delete_at timestamptz not null,
  reminder_sent_at timestamptz,
  status text not null default 'active', -- active | reminder_sent
  extended_count int not null default 0,
  created_at timestamptz not null default now()
);

alter table retention_settings enable row level security;

create policy "select own retention" on retention_settings
  for select using (owner_id = auth.uid());
create policy "insert own retention" on retention_settings
  for insert with check (owner_id = auth.uid());
create policy "update own retention" on retention_settings
  for update using (owner_id = auth.uid());
```

테이블이 없어도 앱은 정상 동작하며(보관 설정 기능만 비활성), 저장을 시도할 때만 오류가 뜹니다.

### 5-2. 메일 발송 — Resend

1. [resend.com](https://resend.com) 가입 → API Key 발급
2. 발신 도메인을 인증하거나(권장) 테스트 중에는 `onboarding@resend.dev` 사용 가능(단, 본인 인증 이메일로만 발송 가능)
3. 환경변수 등록:
   - `RESEND_API_KEY`
   - `RESEND_FROM` — 예: `생기부 도우미 <noreply@yourdomain.com>`

### 5-3. Vercel Cron

`vercel.json` 에 아래 크론이 이미 정의되어 있어 Vercel에 배포하면 자동으로 등록됩니다.

```json
{
  "crons": [
    { "path": "/api/cron/retention-remind", "schedule": "0 1 * * *" },
    { "path": "/api/cron/retention-delete", "schedule": "0 2 * * *" }
  ]
}
```

- `retention-remind`: 삭제 7일 이내로 남고 아직 안내 메일을 안 보낸 계정에 리마인더 발송
- `retention-delete`: 삭제 예정일이 지난 계정을 JSON 백업 메일 발송 후 삭제 (메일 발송 실패 시 그 회차는 건너뛰고 다음 날 재시도 — 백업 없이 지워지는 일 없음)

추가 환경변수:
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase **Project Settings → API → service_role** 키 (RLS 우회, 서버 전용, 절대 브라우저 노출 금지)
- `CRON_SECRET` — 임의의 긴 문자열. Vercel 프로젝트에 이 값을 등록해두면 Vercel이 크론 호출 시 자동으로
  `Authorization: Bearer <CRON_SECRET>` 헤더를 붙여 보내며, 라우트가 이 값으로 요청 주체를 검증합니다.
  (설정하지 않으면 검증 없이 동작 — 로컬 테스트용으로만 두고 배포 시엔 반드시 설정하세요.)
- `NEXT_PUBLIC_APP_URL` — 리마인더 메일의 "지금 접속해서 연장하기" 링크에 쓰일 배포 URL (없으면 `VERCEL_URL` 사용)

Hobby(무료) 플랜은 크론이 하루 1회 실행으로 제한되는데, 이 기능은 날짜 단위로만 판단하므로 문제없습니다.

## 구조

```
app/
  login/page.js        로그인·회원가입
  app/page.js          보호 페이지(서버: 인증 확인 + 데이터 로드)
  app/Workspace.jsx    메인 UI(학생 드롭다운/항목 탭/작성/결과)
  api/generate/route.js         서버 측 AI 호출(Gemini/ChatGPT, 키 비노출, 재시도·타임아웃)
  api/cron/retention-remind/route.js  삭제 7일 전 안내 메일 발송(크론)
  api/cron/retention-delete/route.js  삭제 예정일 경과 시 백업 메일 발송 후 삭제(크론)
lib/
  supabase/{client,server,middleware}.js
  supabase/admin.js    서비스 롤 클라이언트(크론 전용, RLS 우회)
  categories.js        영역 정의·바이트 계산·활동 트리(심화 탐구) 등 공용
  ai.js                제공자·모델 목록, 후보 큐, 쿨다운, 다중 키 저장
  retention.js         보관 기간 계산(월 덧셈)·백업 JSON 직렬화
  email.js             Resend 메일 발송 + 리마인더/삭제완료 메일 템플릿
middleware.js          세션 갱신 + 보호 경로 리다이렉트
vercel.json            보관 정책 크론 스케줄
supabase/schema.sql    테이블 + RLS
```

## 데이터 모델

- `students(id, owner_id, name, grade, klass, number, status, created_at)`
- `entries(id, owner_id, student_id, category, subject, activities(jsonb), target, draft, notes, updated_at)`
- `retention_settings(owner_id, semester_end_at, delete_at, reminder_sent_at, status, extended_count, created_at)`

`owner_id` 는 `auth.uid()` 가 기본값이며, RLS 정책이 `owner_id = auth.uid()` 인 행만 허용합니다.

### 학생 상태(색상 구분) 컬럼 추가

학생 목록에서 다 작성한 학생과 추후 작업이 필요한 학생을 색 점으로 구분하는 기능을 쓰려면
`students` 테이블에 `status` 컬럼을 한 번 추가해야 합니다(Supabase SQL 편집기에서 실행):

```sql
alter table students add column if not exists status text default 'none';
```

컬럼이 없어도 앱은 정상 동작하며(상태는 항상 '미지정'으로 표시), 저장 시도 시에만 안내 메시지가 뜹니다.
상태 종류는 `lib/categories.js` 의 `STUDENT_STATUSES` 에서 라벨·색을 자유롭게 바꿀 수 있습니다.

### 데이터 보관·자동 삭제(`retention_settings`)

`## 5. 데이터 보관·자동 삭제` 항목의 SQL로 테이블을 생성해야 사용할 수 있습니다. 자세한 내용은 해당 절 참고.

## 메모

- 초안은 AI 보조 결과입니다. 사실 여부·기재 가능 항목은 반드시 교사가 검토 후 사용하세요.
- 바이트 계산은 일반적인 NEIS 규칙으로 구현했습니다. 실제 NEIS 화면 카운트와 한 번 대조해 보시고,
  차이가 있으면 `lib/categories.js` 의 `neisBytes` 만 조정하면 됩니다.
- 다른 제공자를 추가하려면 `lib/ai.js` 의 `PROVIDERS` 에 항목을 추가하고,
  `app/api/generate/route.js` 에 `callXxx` 함수를 만들어 `callAI` 디스패처에 분기를 추가하세요.
- 활동은 서로 **심화 탐구 연계**로 묶을 수 있습니다(`activities[].parentId`). 연계된 활동은 AI가 하나의
  이어진 탐구 서사로 서술합니다. jsonb 컬럼이라 DB 마이그레이션은 필요 없습니다.
