-- 전산팀 전원(현재 4명)을 관리자 권한으로 승격
-- corporate_employees.role 갱신 시 기존 트리거가 public.users.role까지 동기화함

UPDATE public.corporate_employees
SET role = 'admin'
WHERE depnm ILIKE '전산%'
  AND role IS DISTINCT FROM 'admin';

-- 안전 보정: users 테이블이 아직 동기화되지 않은 경우 직접 반영
UPDATE public.users u
SET role = 'admin',
    updated_at = NOW()
FROM public.corporate_employees ce
WHERE lower(u.email) = lower(ce.empno || '@opco.internal')
  AND ce.depnm ILIKE '전산%'
  AND u.role IS DISTINCT FROM 'admin';
