-- 관리자 이벤트 삭제 백업/정리 처리
-- 목적:
-- 1) 이벤트 삭제 전에 연계 데이터 스냅샷 백업
-- 2) FK 제약을 피하도록 자식 테이블부터 순서대로 삭제

CREATE TABLE IF NOT EXISTS public.event_delete_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  deleted_by uuid,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  snapshot jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS event_delete_backups_event_id_idx
ON public.event_delete_backups (event_id, deleted_at DESC);

CREATE OR REPLACE FUNCTION public.admin_delete_event_with_backup(
  p_event_id uuid,
  p_actor_user_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event jsonb;
  v_submissions jsonb := '[]'::jsonb;
  v_judgments jsonb := '[]'::jsonb;
  v_event_judges jsonb := '[]'::jsonb;
  v_submission_revisions jsonb := '[]'::jsonb;
  v_comments jsonb := '[]'::jsonb;
  v_likes jsonb := '[]'::jsonb;
  v_backup_id uuid;
  v_deleted_judgments int := 0;
  v_deleted_revisions int := 0;
  v_deleted_submissions int := 0;
  v_deleted_event_judges int := 0;
  v_deleted_comments int := 0;
  v_deleted_likes int := 0;
  v_deleted_events int := 0;
BEGIN
  SELECT to_jsonb(e)
    INTO v_event
  FROM public.events e
  WHERE e.id = p_event_id;

  IF v_event IS NULL THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
    INTO v_submissions
  FROM public.submissions s
  WHERE s.event_id = p_event_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(j)), '[]'::jsonb)
    INTO v_judgments
  FROM public.judgments j
  WHERE j.submission_id IN (
    SELECT s.id FROM public.submissions s WHERE s.event_id = p_event_id
  );

  SELECT COALESCE(jsonb_agg(to_jsonb(ej)), '[]'::jsonb)
    INTO v_event_judges
  FROM public.event_judges ej
  WHERE ej.event_id = p_event_id;

  IF to_regclass('public.submission_revisions') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT COALESCE(jsonb_agg(to_jsonb(sr)), '[]'::jsonb)
      FROM public.submission_revisions sr
      WHERE sr.submission_id IN (
        SELECT s.id FROM public.submissions s WHERE s.event_id = $1
      )
    $sql$
    INTO v_submission_revisions
    USING p_event_id;
  END IF;

  IF to_regclass('public.comments') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
      FROM public.comments c
      WHERE c.target_type = 'event'
        AND c.target_id = $1::text
    $sql$
    INTO v_comments
    USING p_event_id;
  END IF;

  IF to_regclass('public.likes') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT COALESCE(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
      FROM public.likes l
      WHERE l.target_type = 'event'
        AND l.target_id = $1::text
    $sql$
    INTO v_likes
    USING p_event_id;
  END IF;

  INSERT INTO public.event_delete_backups (event_id, deleted_by, reason, snapshot)
  VALUES (
    p_event_id,
    p_actor_user_id,
    p_reason,
    jsonb_build_object(
      'event', v_event,
      'submissions', v_submissions,
      'judgments', v_judgments,
      'event_judges', v_event_judges,
      'submission_revisions', v_submission_revisions,
      'comments', v_comments,
      'likes', v_likes
    )
  )
  RETURNING id INTO v_backup_id;

  DELETE FROM public.judgments
  WHERE submission_id IN (
    SELECT s.id FROM public.submissions s WHERE s.event_id = p_event_id
  );
  GET DIAGNOSTICS v_deleted_judgments = ROW_COUNT;

  IF to_regclass('public.submission_revisions') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM public.submission_revisions
      WHERE submission_id IN (
        SELECT s.id FROM public.submissions s WHERE s.event_id = $1
      )
    $sql$
    USING p_event_id;
    GET DIAGNOSTICS v_deleted_revisions = ROW_COUNT;
  END IF;

  DELETE FROM public.submissions
  WHERE event_id = p_event_id;
  GET DIAGNOSTICS v_deleted_submissions = ROW_COUNT;

  DELETE FROM public.event_judges
  WHERE event_id = p_event_id;
  GET DIAGNOSTICS v_deleted_event_judges = ROW_COUNT;

  IF to_regclass('public.comments') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM public.comments
      WHERE target_type = 'event'
        AND target_id = $1::text
    $sql$
    USING p_event_id;
    GET DIAGNOSTICS v_deleted_comments = ROW_COUNT;
  END IF;

  IF to_regclass('public.likes') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM public.likes
      WHERE target_type = 'event'
        AND target_id = $1::text
    $sql$
    USING p_event_id;
    GET DIAGNOSTICS v_deleted_likes = ROW_COUNT;
  END IF;

  DELETE FROM public.events
  WHERE id = p_event_id;
  GET DIAGNOSTICS v_deleted_events = ROW_COUNT;

  IF v_deleted_events = 0 THEN
    RAISE EXCEPTION 'EVENT_DELETE_FAILED';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'backup_id', v_backup_id,
    'deleted', jsonb_build_object(
      'judgments', v_deleted_judgments,
      'submission_revisions', v_deleted_revisions,
      'submissions', v_deleted_submissions,
      'event_judges', v_deleted_event_judges,
      'comments', v_deleted_comments,
      'likes', v_deleted_likes,
      'events', v_deleted_events
    )
  );
END;
$$;
