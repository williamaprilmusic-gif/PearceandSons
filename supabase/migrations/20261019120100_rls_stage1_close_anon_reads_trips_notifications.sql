-- ============================================================================
-- RLS CUTOVER — STAGE 1 (proof-of-pattern): close anonymous reads on the two
-- biggest leaks, `trips` and `notifications`.
-- ============================================================================
-- CURRENT STATE (verified live 2026-10-19): both tables have a SELECT policy
-- with `qual = true`, TO public — so anyone holding the (necessarily public)
-- anon key can read them directly via PostgREST with no login:
--   * trips       — 84 rows incl. pickup/dropoff/start/dest coordinates AND
--                   the per-trip `phone` column.
--   * notifications — 2,581 rows.
--
-- THIS CHANGE: replace `qual = true` with the SAME logged-in check every other
-- table's write policies in this project already use
-- ( auth.jwt()->>'app_user_id' IS NOT NULL ), keeping TO public so the
-- mechanism is identical to the rest of the schema. Anonymous requests (anon
-- role, no app_user_id claim) are denied; any logged-in session is unaffected.
--
-- This is deliberately STILL broad for authenticated users (every logged-in
-- user keeps seeing all rows) — narrowing to owner/role/company scope is
-- Stage 2/3 and ships separately. Stage 1 is the low-risk anon-leak closure.
--
-- SHARE LINKS: the public /share/:token viewer is a separate, not-yet-wired
-- deployment concern and reads driver GPS (driver_positions, already
-- authenticated-gated) — there is no live logged-out reader of `trips` today,
-- so no carve-out is needed. When that page is built it must be served via a
-- token-scoped edge function (service_role), not anon PostgREST.
--
-- VERIFIED 2026-10-19 (rolled-back txn, real data): under this predicate an
-- anon/no-token request sees 0 trips and 0 notifications; a sample agent token
-- still sees all 84 / 2,581 (expected until Stage 2).
--
-- REALTIME: `trips` and `notifications` feed Supabase Realtime subscriptions.
-- After applying, confirm a logged-in driver/admin still receives live
-- postgres_changes events (RLS applies to realtime too). Anon realtime
-- subscribers will correctly stop receiving these.
-- ============================================================================

-- wrap in (select ...) so PostgREST caches the claim once per statement
-- (matches this project's fix_rls_auth_initplan_performance convention).

drop policy if exists "allow read - trips" on public.trips;
create policy "read: authenticated - trips" on public.trips
  for select to public
  using ( ( ( select auth.jwt() ) ->> 'app_user_id' ) is not null );

drop policy if exists "allow read - notifications" on public.notifications;
create policy "read: authenticated - notifications" on public.notifications
  for select to public
  using ( ( ( select auth.jwt() ) ->> 'app_user_id' ) is not null );

-- ---------------------------------------------------------------------------
-- ROLLBACK (down) — restores the previous allow-all read:
--   drop policy if exists "read: authenticated - trips" on public.trips;
--   create policy "allow read - trips" on public.trips
--     for select to public using ( true );
--   drop policy if exists "read: authenticated - notifications" on public.notifications;
--   create policy "allow read - notifications" on public.notifications
--     for select to public using ( true );
-- ---------------------------------------------------------------------------
