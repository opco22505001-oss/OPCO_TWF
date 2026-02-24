-- 제출물 수정 시 기존 내용/파일 스냅샷 저장

CREATE TABLE IF NOT EXISTS public.submission_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  content jsonb,
  files jsonb,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version_no)
);

CREATE INDEX IF NOT EXISTS submission_revisions_submission_id_idx
ON public.submission_revisions (submission_id, version_no DESC);

ALTER TABLE public.submission_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Submitters and admins can view own submission revisions" ON public.submission_revisions;
CREATE POLICY "Submitters and admins can view own submission revisions"
ON public.submission_revisions
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.submissions s
    WHERE s.id = submission_revisions.submission_id
      AND s.submitter_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = auth.uid()
      AND u.role = 'admin'
  )
);

CREATE OR REPLACE FUNCTION public.snapshot_submission_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version_no integer;
BEGIN
  IF to_jsonb(OLD.content) IS DISTINCT FROM to_jsonb(NEW.content)
     OR to_jsonb(OLD.files) IS DISTINCT FROM to_jsonb(NEW.files) THEN
    SELECT COALESCE(MAX(sr.version_no), 0) + 1
    INTO next_version_no
    FROM public.submission_revisions sr
    WHERE sr.submission_id = OLD.id;

    INSERT INTO public.submission_revisions (
      submission_id,
      version_no,
      content,
      files,
      changed_by
    ) VALUES (
      OLD.id,
      next_version_no,
      to_jsonb(OLD.content),
      to_jsonb(OLD.files),
      auth.uid()
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_snapshot_submission_before_update ON public.submissions;
CREATE TRIGGER trg_snapshot_submission_before_update
BEFORE UPDATE ON public.submissions
FOR EACH ROW
EXECUTE FUNCTION public.snapshot_submission_before_update();
