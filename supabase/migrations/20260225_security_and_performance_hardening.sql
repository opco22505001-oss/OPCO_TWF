-- 보안/성능 하드닝
-- 1) Edge Function 레이트 리밋용 테이블/함수
-- 2) 제출 첨부파일 URL 서버측 검증 트리거
-- 3) 관리자 대시보드 집계용 인덱스 보강

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_sec integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer := 0;
  v_started timestamptz := v_now;
  v_retry_after integer := 0;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) = 0 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_KEY';
  END IF;
  IF COALESCE(p_limit, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_LIMIT';
  END IF;
  IF COALESCE(p_window_sec, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_WINDOW';
  END IF;

  INSERT INTO public.api_rate_limits (key, window_started_at, request_count, updated_at)
  VALUES (p_key, v_now, 1, v_now)
  ON CONFLICT (key) DO UPDATE
  SET
    request_count = CASE
      WHEN public.api_rate_limits.window_started_at + make_interval(secs => p_window_sec) <= v_now THEN 1
      ELSE public.api_rate_limits.request_count + 1
    END,
    window_started_at = CASE
      WHEN public.api_rate_limits.window_started_at + make_interval(secs => p_window_sec) <= v_now THEN v_now
      ELSE public.api_rate_limits.window_started_at
    END,
    updated_at = v_now
  RETURNING request_count, window_started_at INTO v_count, v_started;

  IF v_count > p_limit THEN
    v_retry_after := GREATEST(
      1,
      ceil(extract(epoch FROM (v_started + make_interval(secs => p_window_sec) - v_now)))::integer
    );
    RETURN jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after', v_retry_after
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'remaining', GREATEST(p_limit - v_count, 0),
    'retry_after', 0
  );
END;
$$;

-- 오래된 키 정리용 (수동 실행)
CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_keys(p_keep_minutes integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  DELETE FROM public.api_rate_limits
  WHERE updated_at < now() - make_interval(mins => GREATEST(p_keep_minutes, 1));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_allowed_public_file_url(
  p_url text,
  p_allowed_buckets text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    p_url ~* (
      '^https://[^/]+/storage/v1/object/public/('
      || array_to_string(p_allowed_buckets, '|')
      || ')/.+\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|hwp|hwpx|txt|png|jpg|jpeg|gif|webp)$'
    )
$$;

CREATE OR REPLACE FUNCTION public.validate_submission_files()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_file text;
BEGIN
  IF NEW.files IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH v_file IN ARRAY NEW.files
  LOOP
    IF NOT public.is_allowed_public_file_url(v_file, ARRAY['submission-files']) THEN
      RAISE EXCEPTION 'INVALID_SUBMISSION_FILE_URL'
        USING ERRCODE = '22023',
          DETAIL = left(coalesce(v_file, ''), 300);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_event_attachments()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_file text;
BEGIN
  IF NEW.attachments IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH v_file IN ARRAY NEW.attachments
  LOOP
    IF NOT public.is_allowed_public_file_url(v_file, ARRAY['event-attachments']) THEN
      RAISE EXCEPTION 'INVALID_EVENT_ATTACHMENT_URL'
        USING ERRCODE = '22023',
          DETAIL = left(coalesce(v_file, ''), 300);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_submission_files ON public.submissions;
CREATE TRIGGER trg_validate_submission_files
BEFORE INSERT OR UPDATE OF files ON public.submissions
FOR EACH ROW
EXECUTE FUNCTION public.validate_submission_files();

DROP TRIGGER IF EXISTS trg_validate_event_guide_files ON public.events;
DROP TRIGGER IF EXISTS trg_validate_event_attachments ON public.events;
CREATE TRIGGER trg_validate_event_attachments
BEFORE INSERT OR UPDATE OF attachments ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.validate_event_attachments();

CREATE INDEX IF NOT EXISTS idx_submissions_event_id ON public.submissions (event_id);
CREATE INDEX IF NOT EXISTS idx_event_judges_event_id ON public.event_judges (event_id);
CREATE INDEX IF NOT EXISTS idx_judgments_submission_id ON public.judgments (submission_id);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON public.users (lower(email));
