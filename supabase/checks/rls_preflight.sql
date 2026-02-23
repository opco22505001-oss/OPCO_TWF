-- 배포 전 RLS 점검용 쿼리
-- 사용 예: Supabase SQL Editor에서 실행

-- 1) public 스키마에서 RLS가 비활성화된 테이블 목록
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname NOT LIKE 'pg_%'
ORDER BY c.relname;

-- 2) RLS는 켜져 있지만 정책이 없는 테이블 목록
SELECT
  c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p
  ON p.schemaname = n.nspname
 AND p.tablename = c.relname
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = true
GROUP BY c.relname
HAVING COUNT(p.policyname) = 0
ORDER BY c.relname;

-- 3) 테이블별 정책 요약
SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
