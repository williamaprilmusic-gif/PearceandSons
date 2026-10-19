-- ============================================================================
-- RLS CUTOVER — STAGE 2: recipient/role scoping for `notifications`
-- ============================================================================
-- Requires Stage 0 helpers (app_uid / app_is_admin).
--
-- A notification targets either a specific user (`userid`) or a set of roles
-- (`forroles[]`, e.g. a broadcast to all AGENTs). Scoping needs only the JWT
-- claims (app_user_id, app_role) — no table join.
--
-- READ: admin sees all; everyone else sees notifications addressed to them or
-- broadcast to their role. (Supersedes the Stage 1 authenticated-only read.)
--
-- WRITE: left as "logged in" — the app legitimately INSERTs notifications FOR
-- OTHER users (e.g. admin dispatch → driver), so INSERT cannot be recipient-
-- scoped. UPDATE is the "mark read" toggle; tightening it to recipient-only is
-- a later refinement (low risk today: notification bodies are not sensitive
-- beyond what the owning user already sees).
--
-- VERIFIED 2026-10-19 (rolled-back txn, real data, 2,581 rows):
--   agent#52 → 1,170 visible   driver#51 → 49 visible   admin#26 → 2,581 (all)
-- ============================================================================

drop policy if exists "allow read - notifications" on public.notifications;
drop policy if exists "read: authenticated - notifications" on public.notifications;
create policy "read: recipient-or-role - notifications" on public.notifications
  for select to public
  using (
    public.app_is_admin()
    or userid = public.app_uid()
    or ( select auth.jwt()->>'app_role' ) = any(forroles)
  );

-- INSERT / UPDATE / DELETE policies are unchanged (still require a logged-in
-- session via the existing "authenticated insert/update/delete - notifications"
-- policies). This migration only narrows SELECT.

-- ---------------------------------------------------------------------------
-- ROLLBACK (down):
--   drop policy if exists "read: recipient-or-role - notifications" on public.notifications;
--   create policy "read: authenticated - notifications" on public.notifications
--     for select to public using ( ((select auth.jwt())->>'app_user_id') is not null );
-- ---------------------------------------------------------------------------
