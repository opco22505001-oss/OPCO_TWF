-- Fixes for:
-- 1) Storage upload RLS errors on event attachments and submission files
-- 2) notifications insert RLS errors during judge assignment
-- 3) Judge assignment for employees who have not logged in yet

-- 1) Storage upload policies
DROP POLICY IF EXISTS "Public Upload Event Attachments" ON storage.objects;
CREATE POLICY "Public Upload Event Attachments"
ON storage.objects
FOR INSERT
TO public
WITH CHECK (bucket_id = 'event-attachments');

DROP POLICY IF EXISTS "Public Upload Submission Files" ON storage.objects;
CREATE POLICY "Public Upload Submission Files"
ON storage.objects
FOR INSERT
TO public
WITH CHECK (bucket_id = 'submission-files');

-- 2) Notifications insert policy
DROP POLICY IF EXISTS "Allow insert notifications" ON public.notifications;
CREATE POLICY "Allow insert notifications"
ON public.notifications
FOR INSERT
TO public
WITH CHECK (user_id IS NOT NULL);

-- 3) Sync users from corporate_employees
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
ON public.users (lower(email))
WHERE email IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_user_from_corporate_employee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_email text;
  target_role public.user_role;
BEGIN
  target_email := NEW.empno || '@opco.internal';
  target_role := CASE
    WHEN NEW.role IN ('admin', 'judge', 'submitter') THEN NEW.role::public.user_role
    ELSE 'submitter'::public.user_role
  END;

  UPDATE public.users
  SET
    name = COALESCE(NEW.empnm, users.name),
    department = COALESCE(NEW.depnm, users.department),
    role = target_role,
    updated_at = NOW()
  WHERE lower(users.email) = lower(target_email);

  IF NOT FOUND THEN
    INSERT INTO public.users (email, name, department, role, created_at, updated_at)
    VALUES (target_email, NEW.empnm, NEW.depnm, target_role, NOW(), NOW());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_user_from_corporate_employee ON public.corporate_employees;
CREATE TRIGGER trg_sync_user_from_corporate_employee
AFTER INSERT OR UPDATE OF empno, empnm, depnm, role
ON public.corporate_employees
FOR EACH ROW
EXECUTE FUNCTION public.sync_user_from_corporate_employee();

-- Backfill existing rows
UPDATE public.users u
SET
  name = COALESCE(ce.empnm, u.name),
  department = COALESCE(ce.depnm, u.department),
  role = CASE
    WHEN ce.role IN ('admin', 'judge', 'submitter') THEN ce.role::public.user_role
    ELSE u.role
  END,
  updated_at = NOW()
FROM public.corporate_employees ce
WHERE lower(u.email) = lower(ce.empno || '@opco.internal');

INSERT INTO public.users (email, name, department, role, created_at, updated_at)
SELECT
  ce.empno || '@opco.internal' AS email,
  ce.empnm,
  ce.depnm,
  CASE
    WHEN ce.role IN ('admin', 'judge', 'submitter') THEN ce.role::public.user_role
    ELSE 'submitter'::public.user_role
  END AS role,
  NOW(),
  NOW()
FROM public.corporate_employees ce
WHERE NOT EXISTS (
  SELECT 1
  FROM public.users u
  WHERE lower(u.email) = lower(ce.empno || '@opco.internal')
);
