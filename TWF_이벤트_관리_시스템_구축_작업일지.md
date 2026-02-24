# OPCO : TWF 이벤트 관리 시스템 구축 작업일지

## 1. 프로젝트 개요
- 프로젝트명: `OPCO : TWF (Technical Workflow & Event Management)`
- 목적: 사내 이벤트 생성, 제출물 접수, 심사/집계, 관리자 운영 기능 통합
- 주요 스택
- 프론트엔드: `HTML`, `Vanilla JS`, `Tailwind CSS`
- 백엔드: `Supabase (PostgreSQL, Auth, Storage, Edge Functions)`
- 사내 인사 연동: `corporate_employees` 기반 로그인 검증

## 2. 핵심 기능 구현
### 2.1 인증/권한
- 사번+이름 기반 로그인(`auth-login` Edge Function)
- 관리자 2차 인증코드 검증(`ADMIN_CODE`)
- 로그인 시 `auth.users`/`public.users` 메타데이터 동기화
- 관리자 권한 변경 기능(`admin-manage-user-role`) 구현

### 2.2 이벤트/제출/심사
- 이벤트 생성/수정/삭제/즉시 마감
- 제출물 등록/수정(기존 첨부 유지/삭제/추가)
- 파일 업로드 검증(확장자/용량)
- 심사자 배정 기반 평가
- 동일 심사자-동일 제출물 중복 평가 방지
- 심사 수정 1회 제한(마감 전)

### 2.3 관리자 운영
- 관리자 탭 및 권한 관리 페이지 추가
- 심사 통계(건수/평균/표준편차) 대시보드
- 진행 이벤트 수, 평균 제출률/심사율 지표
- 마감 임박/평가 지연 이벤트 알림 목록

## 3. 데이터베이스/보안 보강
- RLS 정책 보강 및 심사/제출 접근 제어 정비
- 감사 로그(`admin_audit_logs`) 기록 추가
- 제출 수정 이력 스냅샷 테이블/트리거 추가
- 결과 확정 컬럼 추가
- `events.result_finalized`
- `events.results_finalized_at`
- 결과 확정 후 심사 등록/수정 차단 트리거 추가

## 4. Edge Function 현황
- `auth-login`: 인사 검증 + 세션 발급
- `admin-manage-user-role`: 관리자 권한 조회/변경
- `admin-event-action`: 마감/삭제/결과확정 + 감사로그
- `admin-judgment-analytics`: 심사 통계 집계
- `admin-dashboard-metrics`: 관리자 지표/지연 알림 집계

## 5. 최근 반영 사항
- `event-detail.html` 한글 깨짐 복구
- 결과 확정 버튼/배지 UI 추가
- 관리자 대시보드 지표 UI/로직 추가
- 결과 확정 후 심사 잠금 마이그레이션 적용

## 6. 확인된 이슈 및 대응
- 인코딩 깨짐(한글 mojibake): 파일별 UTF-8 정리 및 문구 복구
- 게스트 로그인 잔존 세션: 실제 세션 우선 처리로 정리
- 파일명 표시/업로드 이슈: 원본 파일명 인코딩 처리 및 검증 로직 보강

## 7. 다음 작업 후보
- 결과 확정 이후 최종 순위 고정 UI(공개 범위 설정 포함)
- 관리자 감사로그 조회 화면 추가
- 업로드 파일 바이러스 스캔/콘텐츠 타입 검증 강화
- 통합 E2E 점검 시나리오 문서화
