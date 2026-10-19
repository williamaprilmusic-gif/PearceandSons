-- ============================================================================
-- RLS CUTOVER — STAGE 2: owner/role scoping for `trips` (closes Gap B here)
-- ============================================================================
-- Requires Stage 0 helpers (app_uid / app_is_admin).
--
-- BEFORE: every policy on trips only checked "is logged in"
-- (app_user_id IS NOT NULL), so any AGENT/DRIVER/CLIENT token could read,
-- update or delete ANY trip via PostgREST, bypassing assertAdminPermission.
--
-- AFTER: a row is visible/writable only to someone attached to it —
-- the booking agent, an extra agent, the assigned driver, or an ADMIN.
--
-- WRITE-PATH SAFETY (verified 2026-10-19, rolled-back txn, real data):
--   * assigned driver #51 passes the write-check on all 64 of their assigned
--     trips → pickup/drop-off/no-show confirmations keep working.
--   * owner-scoped reads return 38 (agent) / 64 (driver) / 84 all (admin).
--   * client-side trip DELETEs are agent self-cancel of UNASSIGNED_BOOKING and
--     week-booking rollback (TransitOS_web.jsx:9755/9783/10102/10407) plus
--     admin cancels → DELETE is scoped to admin-or-owning-agent to keep both.
--
-- NOTE (intentional Stage-2 limitation): RLS is row-level, so once someone is
-- attached to a trip they may write ANY column on it. Per-column / per-action
-- precision (e.g. a driver may set completed_dropoffs but not reassign the
-- agent) stays enforced in the app layer for now and can later move behind a
-- service-role edge function. This is still a large improvement over "any
-- logged-in user can write any trip."
-- ============================================================================

-- SELECT — owner scoped (supersedes the Stage 1 authenticated-only read)
drop policy if exists "allow read - trips" on public.trips;
drop policy if exists "read: authenticated - trips" on public.trips;
create policy "read: owner-scoped - trips" on public.trips
  for select to public
  using (
    public.app_is_admin()
    or (agentid)::text = ( select auth.jwt()->>'app_user_id' )
    or (driverid)::text = ( select auth.jwt()->>'app_user_id' )
    or public.app_uid() = any(extraagentids)
  );

-- INSERT — admin, or an agent booking their own trip
drop policy if exists "authenticated insert - trips" on public.trips;
create policy "insert: admin-or-own-agent - trips" on public.trips
  for insert to public
  with check (
    public.app_is_admin()
    or (agentid)::text = ( select auth.jwt()->>'app_user_id' )
  );

-- UPDATE — admin or anyone attached to the trip (driver confirms, agent cancels)
drop policy if exists "authenticated update - trips" on public.trips;
create policy "update: owner-scoped - trips" on public.trips
  for update to public
  using (
    public.app_is_admin()
    or (agentid)::text = ( select auth.jwt()->>'app_user_id' )
    or (driverid)::text = ( select auth.jwt()->>'app_user_id' )
    or public.app_uid() = any(extraagentids)
  )
  with check (
    public.app_is_admin()
    or (agentid)::text = ( select auth.jwt()->>'app_user_id' )
    or (driverid)::text = ( select auth.jwt()->>'app_user_id' )
    or public.app_uid() = any(extraagentids)
  );

-- DELETE — admin or the owning agent (booking cancel / week rollback only)
drop policy if exists "authenticated delete - trips" on public.trips;
create policy "delete: admin-or-own-agent - trips" on public.trips
  for delete to public
  using (
    public.app_is_admin()
    or (agentid)::text = ( select auth.jwt()->>'app_user_id' )
  );

-- ---------------------------------------------------------------------------
-- ROLLBACK (down) — restore Stage 1 (authenticated-only) read + logged-in writes:
--   drop policy if exists "read: owner-scoped - trips"        on public.trips;
--   drop policy if exists "insert: admin-or-own-agent - trips" on public.trips;
--   drop policy if exists "update: owner-scoped - trips"       on public.trips;
--   drop policy if exists "delete: admin-or-own-agent - trips" on public.trips;
--   create policy "read: authenticated - trips" on public.trips for select to public
--     using ( ((select auth.jwt())->>'app_user_id') is not null );
--   create policy "authenticated insert - trips" on public.trips for insert to public
--     with check ( ((select auth.jwt())->>'app_user_id') is not null );
--   create policy "authenticated update - trips" on public.trips for update to public
--     using ( ((select auth.jwt())->>'app_user_id') is not null )
--     with check ( ((select auth.jwt())->>'app_user_id') is not null );
--   create policy "authenticated delete - trips" on public.trips for delete to public
--     using ( ((select auth.jwt())->>'app_user_id') is not null );
-- ---------------------------------------------------------------------------
