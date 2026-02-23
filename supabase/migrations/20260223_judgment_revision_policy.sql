-- 심사 수정 정책: 마감 전 1회만 수정 가능

ALTER TABLE public.judgments
ADD COLUMN IF NOT EXISTS revision_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.enforce_judgment_revision_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_status text;
BEGIN
  SELECT e.status
  INTO event_status
  FROM public.submissions s
  JOIN public.events e ON e.id = s.event_id
  WHERE s.id = NEW.submission_id;

  IF event_status = 'closed' THEN
    RAISE EXCEPTION '마감된 이벤트의 평가는 수정할 수 없습니다.';
  END IF;

  IF OLD.revision_count >= 1 THEN
    RAISE EXCEPTION '평가 수정은 1회만 가능합니다.';
  END IF;

  NEW.revision_count := OLD.revision_count + 1;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_judgment_revision_policy ON public.judgments;
CREATE TRIGGER trg_enforce_judgment_revision_policy
BEFORE UPDATE ON public.judgments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_judgment_revision_policy();
