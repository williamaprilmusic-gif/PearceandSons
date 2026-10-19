-- ============================================================================
-- RLS CUTOVER — STAGE 2: lock `trip_fee_rates` to ADMIN only
-- ============================================================================
-- Requires Stage 0 helpers (app_is_admin).
--
-- BEFORE: a single "authenticated only - trip_fee_rates" ALL policy — any
-- logged-in AGENT/DRIVER/CLIENT could read AND overwrite the trip-fee and
-- driver-payment rates directly via PostgREST.
--
-- AFTER: only ADMIN tokens can read or write. Safe because:
--   * The app reads fee rates ONLY inside admin-gated screens — per the code's
--     own note "no agent/driver/client-portal component reads state.fee_rates
--     at all" (TransitOS_web.jsx:13541). A non-admin boot-fetch simply gets an
--     empty result (null), which the app already tolerates.
--   * The monthly-billing-export edge function uses the service role, which
--     bypasses RLS — unaffected.
--
-- VERIFIED 2026-10-19 (rolled-back txn, real data): admin#26 → 1 row visible,
-- agent#52 → 0.
-- ============================================================================

drop policy if exists "authenticated only - trip_fee_rates" on public.trip_fee_rates;
create policy "rw: admin-only - trip_fee_rates" on public.trip_fee_rates
  for all to public
  using ( public.app_is_admin() )
  with check ( public.app_is_admin() );

-- ---------------------------------------------------------------------------
-- ROLLBACK (down):
--   drop policy if exists "rw: admin-only - trip_fee_rates" on public.trip_fee_rates;
--   create policy "authenticated only - trip_fee_rates" on public.trip_fee_rates
--     for all to public
--     using ( ((select auth.jwt())->>'app_user_id') is not null )
--     with check ( ((select auth.jwt())->>'app_user_id') is not null );
-- ---------------------------------------------------------------------------
