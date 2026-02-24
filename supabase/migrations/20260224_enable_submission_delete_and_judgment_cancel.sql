-- 제출물 삭제 + 심사 취소(삭제) 허용
-- 요구사항:
-- 1) 제출자가 자신의 제출물을 삭제할 수 있어야 함
-- 2) 심사자가 본인 평가를 취소(삭제)할 수 있어야 함
-- 3) 제출물 삭제 시 연계 judgments는 자동 정리

DO $$
DECLARE
  v_fk_name text;
BEGIN
  SELECT c.conname
    INTO v_fk_name
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.conrelid = 'public.judgments'::regclass
    AND c.confrelid = 'public.submissions'::regclass
  LIMIT 1;

  IF v_fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.judgments DROP CONSTRAINT %I', v_fk_name);
  END IF;

  BEGIN
    ALTER TABLE public.judgments
    ADD CONSTRAINT judgments_submission_id_fkey
    FOREIGN KEY (submission_id)
    REFERENCES public.submissions(id)
    ON DELETE CASCADE;
  EXCEPTION
    WHEN duplicate_object THEN
      NULL;
  END;
END;
$$;

DROP POLICY IF EXISTS "Submitters can delete own submissions before close" ON public.submissions;
CREATE POLICY "Submitters can delete own submissions before close"
ON public.submissions
FOR DELETE
TO public
USING (
  auth.uid() = submitter_id
  AND EXISTS (
    SELECT 1
    FROM public.events e
    WHERE e.id = submissions.event_id
      AND e.status <> 'closed'
      AND COALESCE(e.result_finalized, false) = false
  )
);

DROP POLICY IF EXISTS "Judges can delete own judgments before close" ON public.judgments;
CREATE POLICY "Judges can delete own judgments before close"
ON public.judgments
FOR DELETE
TO public
USING (
  auth.uid() = judge_id
  AND EXISTS (
    SELECT 1
    FROM public.submissions s
    JOIN public.events e ON e.id = s.event_id
    WHERE s.id = judgments.submission_id
      AND e.status <> 'closed'
      AND COALESCE(e.result_finalized, false) = false
  )
);
