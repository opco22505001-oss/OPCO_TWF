-- 이벤트 결과 확정 상태 컬럼 추가
ALTER TABLE public.events
ADD COLUMN IF NOT EXISTS result_finalized boolean NOT NULL DEFAULT false;

ALTER TABLE public.events
ADD COLUMN IF NOT EXISTS results_finalized_at timestamptz;

-- 결과 확정된 이벤트는 심사 등록/수정을 막는다.
CREATE OR REPLACE FUNCTION public.block_judgment_when_result_finalized()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  finalized boolean;
BEGIN
  SELECT e.result_finalized
    INTO finalized
  FROM public.submissions s
  JOIN public.events e ON e.id = s.event_id
  WHERE s.id = NEW.submission_id;

  IF COALESCE(finalized, false) THEN
    RAISE EXCEPTION '결과 확정된 이벤트는 심사 등록/수정이 불가능합니다.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_judgment_insert_when_result_finalized ON public.judgments;
CREATE TRIGGER trg_block_judgment_insert_when_result_finalized
BEFORE INSERT ON public.judgments
FOR EACH ROW
EXECUTE FUNCTION public.block_judgment_when_result_finalized();

DROP TRIGGER IF EXISTS trg_block_judgment_update_when_result_finalized ON public.judgments;
CREATE TRIGGER trg_block_judgment_update_when_result_finalized
BEFORE UPDATE ON public.judgments
FOR EACH ROW
EXECUTE FUNCTION public.block_judgment_when_result_finalized();
