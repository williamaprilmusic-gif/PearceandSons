-- ============================================================================
-- RLS CUTOVER — STAGE 0: claim-reading helper functions
-- ============================================================================
-- Additive, zero behavior change. These SECURITY DEFINER helpers read the
-- current request's app_user_id / role / adminlevel / scoped companies from the
-- session JWT (issued by the session-login edge function, verified natively by
-- PostgREST against the project JWT secret).
--
-- WHY auth.jwt()->>'app_user_id' AND NOT auth.uid():
--   This app's `sub` claim is the integer users.id as text. auth.uid() casts
--   `sub` to uuid and would throw on every request. Every existing policy in
--   this project already keys off app_user_id for the same reason.
--
-- WHY SECURITY DEFINER:
--   Stage 2 policies on `users` will call app_is_admin()/app_admin_level(),
--   which themselves read `users`. Running them as the definer breaks the RLS
--   recursion that would otherwise occur when a users policy queries users.
--
-- Verified 2026-10-19 against production data in a rolled-back transaction:
-- functions compile, app_is_admin() resolves true for an ADMIN token, and the
-- owner-scoped predicates built on these return 38 trips for a sample agent,
-- 64 for a sample driver, 84 (all) for an admin.
-- ============================================================================

create or replace function public.app_uid() returns bigint
  language sql stable security definer set search_path = public as
$$ select nullif(auth.jwt()->>'app_user_id','')::bigint $$;

create or replace function public.app_is_admin() returns boolean
  language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.users u where u.id = public.app_uid() and u.role = 'ADMIN') $$;

create or replace function public.app_admin_level() returns text
  language sql stable security definer set search_path = public as
$$ select adminlevel from public.users where id = public.app_uid() $$;

create or replace function public.app_scoped_companies() returns text[]
  language sql stable security definer set search_path = public as
$$ select coalesce(scopedcompanyids, '{}') from public.users where id = public.app_uid() $$;

-- Callable only by signed-in users (and service_role, which bypasses RLS
-- anyway). Never by anon.
revoke execute on function
  public.app_uid(), public.app_is_admin(),
  public.app_admin_level(), public.app_scoped_companies()
  from public, anon;
grant execute on function
  public.app_uid(), public.app_is_admin(),
  public.app_admin_level(), public.app_scoped_companies()
  to authenticated;

-- ---------------------------------------------------------------------------
-- ROLLBACK (down):
--   drop function if exists public.app_scoped_companies();
--   drop function if exists public.app_admin_level();
--   drop function if exists public.app_is_admin();
--   drop function if exists public.app_uid();
-- ---------------------------------------------------------------------------
