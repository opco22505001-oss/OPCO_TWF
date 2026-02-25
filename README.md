# OPCO_TWF

오리엔탈정공 `Two Weeks Focus` 이벤트 관리 시스템입니다.

## 로컬 점검

PowerShell에서 아래를 실행하면 기본 문법 검사를 수행합니다.

```powershell
.\scripts\verify.ps1
```

SQL 파일 존재/공백 체크까지 포함하려면:

```powershell
.\scripts\verify.ps1 -WithSql
```

## 운영 반영 체크리스트

1. `supabase/migrations` 신규 SQL 실행
2. 변경된 Edge Function 재배포
3. 관리자 탭/로그인/제출 흐름 회귀 확인

## 인코딩 규칙

- 전체 파일은 UTF-8 기준
- 줄바꿈은 LF 기준 (`.editorconfig`, `.gitattributes` 적용)
