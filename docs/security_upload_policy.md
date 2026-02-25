# 업로드 보안 정책

`20260225_security_and_performance_hardening.sql` 적용 기준입니다.

## 검증 대상

- `events.attachments`
- `submissions.files`

DB 트리거에서 URL을 강제 검증합니다.

## 허용 버킷

- 이벤트 첨부: `event-attachments`
- 제출 첨부: `submission-files`

## 허용 확장자

- 문서: `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `txt`, `hwp`, `hwpx`
- 압축: `zip`
- 이미지: `png`, `jpg`, `jpeg`, `gif`, `webp`

## 차단 조건

- Supabase Public URL 형식이 아닌 값
- 허용되지 않은 버킷
- 허용되지 않은 확장자

## 운영 참고

- 차단 시 DB 예외 코드: `22023`
- 예외 메시지:
  - `INVALID_EVENT_ATTACHMENT_URL`
  - `INVALID_SUBMISSION_FILE_URL`
