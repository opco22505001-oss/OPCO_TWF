-- 결과 확정 시점 순위 스냅샷 저장 컬럼
ALTER TABLE public.events
ADD COLUMN IF NOT EXISTS finalized_ranking_snapshot jsonb;
