# [통합 보고서] OPCO : TWF 이벤트 관리 시스템 구축 작업 대장

본 문서는 OPCO : TWF 프로젝트의 기획부터 구현, 보안 강화 및 최종 검증까지의 모든 과정을 상세히 기술합니다. 외부 환경 또는 타 개발자가 프로젝트를 인계받았을 때 시스템 구조를 즉시 이해할 수 있도록 구성되었습니다.

---

## 1. 프로젝트 개요
- **시스템 명칭**: OPCO : TWF (Technical Workflow & Event Management System)
- **주요 목적**: 사내 이벤트 생성, 임직원 아이디어 제안 수집, 심사위원 배정 및 평가 관리
- **개발 기간**: 2026년 2월
- **기술 스택**: 
  - **Frontend**: HTML5, Vanilla JavaScript, Tailwind CSS (CDN)
  - **Backend**: Supabase (PostgreSQL, Auth, Edge Functions, Realtime)
  - **Internal DB**: SQL Server (`iopco`) - 인사 데이터 연동용

---

## 2. 시스템 아키텍처 및 데이터 흐름

### 2.1 주요 컴포넌트 구조
- **정적 웹 페이지**: `login.html`, `dashboard.html`, `mypage.html` 등 6개의 핵심 UI 구성.
- **클라이언트 로직 (`js/main.js`)**: Supabase SDK 초기화, API 호출 전역화, 공통 UI 핸들링.
- **서버 사이드 로직 (Edge Functions)**: 사내 인사 DB 조회 및 하이브리드 인증 로직(`auth-login`) 처리.

### 2.2 데이터베이스 스키마
- `corporate_employees`: 사내 인사 데이터 동기화 테이블 (사번, 성함, 부서, 역할).
- `events`: 생성된 이벤트 정보 테이블.
- `event_judges`: 각 이벤트별 배정된 심사위원 관리 테이블.
- `submissions`: 임직원이 제출한 제안서/이벤트 응답 테이블.

---

## 3. 핵심 구현 내역 및 기술적 성과

### 3.1 하이브리드 인증 및 보안 프로세스
타 시스템과 차별화되는 고유의 인증 로직을 구현했습니다.
- **2중 검증 (사번 + 이름)**: 단순히 아이디만 입력하는 것이 아니라, 실제 인사 DB에 등록된 사번과 이름을 동시 검증합니다.
- **관리자 2차 인증 코드**: `admin` 역할의 사용자 로그인 시 별도의 공유 인증 코드(`OPCO_ADMIN_2024`)를 서버 사이드에서 검증.
- **Unicode 정규화 (NFC)**: 한글 성함 비교 시 발생할 수 있는 자음/모음 분리 현상을 방지하기 위해 정규화 로직 적용.

### 3.2 인사 데이터 실시간 동기화
- 사내 SQL Server의 데이터를 Supabase 클라우드 데이터베이스로 동기화하는 파이프라인 형성.
- 퇴직자를 제외한 100여 명 이상의 실제 임직원 데이터 반영 완료.

### 3.3 UI 동적화 및 사용자 경험 개선
- **Global Function Exposing**: 모든 핵심 함수(`fetchEvents`, `createEvent` 등)를 `window` 객체에 노출하여 HTML 인라인 스크립트와의 호환성 및 안정성 확보.
- **헤더 정보 동기화**: 모든 페이지 상단에 로그인한 사용자의 이름, 역할, 부서가 실시간으로 반영되도록 통합.
- **로그인 우회(Bypass) 기능**: 개발 및 테스트 시 서버 장애 대응을 위한 안전한 게스트 접속 모드 지원.

---

## 4. 주요 장애 대응 및 해결 과정 (Troubleshooting)

| 발생 문제 | 원인 분석 | 해결 방법 |
| :--- | :--- | :--- |
| **로그인 401 오류** | Edge Function의 JWT 검증 설정 오루 | `verify_jwt: false` 설정 및 커스텀 헤더 인증 로직 도입 |
| **SyntaxError** | `main.js` 내 `supabase` 변수 중복 선언 | `var supabaseClient` 및 전역 초기화 체크 방식으로 리팩토링 |
| **ReferenceError** | HTML에서 JS 함수 호출 시 로딩 시점 차이 | `window.` 객체에 명시적으로 함수를 할당하여 전역 접근 허용 |
| **이름 불일치 오류** | 한글 유니코드 인코딩(NFD/NFC) 차이 | 서버 사이드에서 `normalize('NFC')` 함수 적용 |

---

## 5. 관리 및 운영 지침

### 5.1 서버 환경 설정
- **Supabase URL/Key**: `js/main.js` 및 Edge Function 환경 변수에 설정됨.
- **관리자 인증 코드**: 보안상 주기적으로 Supabase Dashboard의 Edge Function 환경 변수(`ADMIN_CODE`)를 통해 갱신 권장.

### 5.2 장애 복구 및 캐시 관리
- UI 변경 시 브라우저 캐시로 인해 예전 이름(예: 김진우)이 보일 수 있으므로 **`Ctrl + F5`** 안내가 필수적임.
- Edge Function 수정 후에는 반드시 `supabase functions deploy [slug]`를 통한 재배포 필요.

---

## 6. 결언
본 프로젝트는 보안이 보장된 임직원 전용 환경에서 유연하게 각종 사내 이벤트를 관리할 수 있는 기반을 마련했습니다. 향후 모바일 최적화 및 결과 분석 대시보드 기능을 추가하여 확장할 수 있습니다.
