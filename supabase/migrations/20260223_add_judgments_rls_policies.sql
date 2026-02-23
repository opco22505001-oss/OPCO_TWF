-- judgments RLS policies for judge submission flow

DROP POLICY IF EXISTS "Judges can insert assigned judgments" ON public.judgments;
DROP POLICY IF EXISTS "Judges can view own judgments" ON public.judgments;
DROP POLICY IF EXISTS "Judges can update own judgments" ON public.judgments;
DROP POLICY IF EXISTS "Admins can view all judgments" ON public.judgments;

CREATE POLICY "Judges can insert assigned judgments"
ON public.judgments
FOR INSERT
TO public
WITH CHECK (
  auth.uid() = judge_id
  AND EXISTS (
    SELECT 1
    FROM public.submissions s
    JOIN public.event_judges ej ON ej.event_id = s.event_id
    WHERE s.id = judgments.submission_id
      AND ej.judge_id = auth.uid()
  )
);

CREATE POLICY "Judges can view own judgments"
ON public.judgments
FOR SELECT
TO public
USING (auth.uid() = judge_id);

CREATE POLICY "Judges can update own judgments"
ON public.judgments
FOR UPDATE
TO public
USING (auth.uid() = judge_id)
WITH CHECK (auth.uid() = judge_id);

CREATE POLICY "Admins can view all judgments"
ON public.judgments
FOR SELECT
TO public
USING (
  EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = auth.uid()
      AND u.role = 'admin'
  )
);
