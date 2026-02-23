-- 한 심사자가 같은 제출물을 여러 번 평가하지 못하도록 강제

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY submission_id, judge_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM public.judgments
)
DELETE FROM public.judgments j
USING ranked r
WHERE j.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS judgments_submission_judge_unique_idx
ON public.judgments (submission_id, judge_id);
