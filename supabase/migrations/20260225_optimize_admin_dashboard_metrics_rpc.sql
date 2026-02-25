-- 관리자 대시보드 집계 최적화 RPC
-- 목적: 대용량 데이터에서 이벤트별 집계를 DB에서 선계산하여
-- Edge Function으로 전송되는 row 수를 줄인다.

CREATE OR REPLACE FUNCTION public.admin_dashboard_metrics_snapshot()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
WITH submission_counts AS (
  SELECT s.event_id, COUNT(*)::int AS cnt
  FROM public.submissions s
  GROUP BY s.event_id
),
judge_counts AS (
  SELECT ej.event_id, COUNT(*)::int AS cnt
  FROM public.event_judges ej
  GROUP BY ej.event_id
),
judgment_counts AS (
  SELECT s.event_id, COUNT(j.id)::int AS cnt
  FROM public.submissions s
  LEFT JOIN public.judgments j ON j.submission_id = s.id
  GROUP BY s.event_id
),
dept_counts AS (
  SELECT
    s.event_id,
    COALESCE(NULLIF(TRIM(u.department), ''), '부서 미지정') AS department,
    COUNT(*)::int AS cnt
  FROM public.submissions s
  LEFT JOIN public.users u ON u.id = s.submitter_id
  GROUP BY s.event_id, COALESCE(NULLIF(TRIM(u.department), ''), '부서 미지정')
),
dept_by_event AS (
  SELECT
    dc.event_id,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'department', dc.department,
          'count', dc.cnt
        )
        ORDER BY dc.cnt DESC, dc.department ASC
      ),
      '[]'::jsonb
    ) AS departments,
    SUM(dc.cnt)::int AS total_submissions
  FROM dept_counts dc
  GROUP BY dc.event_id
)
SELECT jsonb_build_object(
  'submissionCounts',
  COALESCE(
    (
      SELECT jsonb_object_agg(sc.event_id::text, sc.cnt)
      FROM submission_counts sc
    ),
    '{}'::jsonb
  ),
  'judgeCounts',
  COALESCE(
    (
      SELECT jsonb_object_agg(jc.event_id::text, jc.cnt)
      FROM judge_counts jc
    ),
    '{}'::jsonb
  ),
  'judgmentCounts',
  COALESCE(
    (
      SELECT jsonb_object_agg(jdc.event_id::text, jdc.cnt)
      FROM judgment_counts jdc
    ),
    '{}'::jsonb
  ),
  'eventDepartmentStats',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'eventId', dbe.event_id,
          'departments', dbe.departments,
          'totalSubmissions', dbe.total_submissions
        )
      )
      FROM dept_by_event dbe
    ),
    '[]'::jsonb
  )
);
$$;
