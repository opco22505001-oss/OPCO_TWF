-- 한 사용자가 같은 이벤트에 여러 번 제출 가능하도록 제약 제거

DO $$
DECLARE
  v_constraint_name text;
  v_index_name text;
BEGIN
  -- submissions(event_id, submitter_id) 형태 UNIQUE 제약 제거
  SELECT c.conname
    INTO v_constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'submissions'
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname ORDER BY arr.ord)
      FROM unnest(c.conkey) WITH ORDINALITY arr(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = arr.attnum
    ) = ARRAY['event_id', 'submitter_id'];

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.submissions DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  -- 동일 목적의 UNIQUE 인덱스가 있으면 제거
  SELECT idx.indexname
    INTO v_index_name
  FROM pg_indexes idx
  WHERE idx.schemaname = 'public'
    AND idx.tablename = 'submissions'
    AND idx.indexdef ILIKE 'CREATE UNIQUE INDEX%'
    AND idx.indexdef ILIKE '%(event_id, submitter_id)%'
  LIMIT 1;

  IF v_index_name IS NOT NULL THEN
    EXECUTE format('DROP INDEX IF EXISTS public.%I', v_index_name);
  END IF;
END;
$$;
