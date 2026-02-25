-- 첨부 URL 검증 보정 (fragment/query/따옴표/서명 URL 허용)

CREATE OR REPLACE FUNCTION public.is_allowed_public_file_url(
  p_url text,
  p_allowed_buckets text[]
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_clean text;
  v_lower text;
  v_bucket text;
  v_bucket_ok boolean := false;
BEGIN
  v_clean := coalesce(p_url, '');
  v_clean := split_part(split_part(v_clean, '#', 1), '?', 1);
  v_clean := btrim(v_clean);
  v_clean := replace(v_clean, E'\\\"', '');
  v_clean := trim(both '"' from v_clean);

  v_lower := lower(v_clean);

  IF v_lower = '' OR left(v_lower, 8) <> 'https://' THEN
    RETURN false;
  END IF;

  FOREACH v_bucket IN ARRAY p_allowed_buckets
  LOOP
    IF position('/storage/v1/object/public/' || v_bucket || '/' in v_lower) > 0
       OR position('/storage/v1/object/sign/' || v_bucket || '/' in v_lower) > 0
       OR position('/storage/v1/object/authenticated/' || v_bucket || '/' in v_lower) > 0 THEN
      v_bucket_ok := true;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_bucket_ok THEN
    RETURN false;
  END IF;

  RETURN v_lower ~ '\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|hwp|hwpx|txt|png|jpg|jpeg|gif|webp)$';
END;
$$;
