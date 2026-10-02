# 오늘, 할 일

검정 테마의 개인용 투두리스트입니다. 달력에서 날짜별 할 일을 보고, 하위 주제·메모·우선순위를 관리할 수 있습니다.

## 실행

```sh
npm run dev
```

브라우저에서 `http://localhost:4173`을 엽니다.

## 저장 방식과 기기 간 동기화

로그인 전에는 할 일이 현재 브라우저의 `localStorage`에 저장됩니다. 클라우드 동기화를 켜려면 Supabase 프로젝트를 연결해야 합니다. 로그인 후에는 사용자별 문서를 Supabase에 저장하고 다른 기기에서도 같은 계정으로 로그인해 불러옵니다. 데이터베이스 접근은 Supabase Auth와 Row Level Security 정책으로 로그인한 사용자 본인에게만 허용합니다.

Supabase 대시보드의 SQL Editor에서 [`supabase/schema.sql`](supabase/schema.sql)을 실행한 다음, Auth 설정의 Site URL과 Redirect URL에 GitHub Pages 주소를 추가하세요. GitHub 저장소의 **Settings → Secrets and variables → Actions → Variables**에 `SUPABASE_URL`과 `SUPABASE_PUBLISHABLE_KEY`를 설정하면 배포 workflow가 공개 브라우저 설정 파일을 생성합니다. Publishable key는 브라우저에 포함되므로 `service_role` 키를 넣지 마세요.

여러 기기에서 동시에 같은 목록을 수정하면 마지막 저장이 우선 적용됩니다. 앱은 열려 있는 동안 10초마다 클라우드 변경을 확인합니다.

## GitHub Pages 배포

`main` 브랜치에 push하면 GitHub Actions가 사이트를 배포합니다. 저장소 설정의 **Settings → Pages → Build and deployment**에서 **GitHub Actions**를 배포 소스로 선택하세요. 배포가 끝나면 Pages 설정 화면과 Actions 로그에 사이트 주소가 표시됩니다.
