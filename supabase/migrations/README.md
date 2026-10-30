# Supabase migrations — READ BEFORE ADDING OR RUNNING ANYTHING

**The live Supabase project is the source of truth for schema and RLS, not this folder.**

Migrations and RLS changes on this project have historically been applied
**directly against the live database** (via the Supabase MCP / dashboard),
**not** through `supabase db push` in CI. As a result this folder is **not** a
complete or ordered history of what is actually applied.

## Why this folder was emptied (2026-10-30)

It previously held five `20261019120*_rls_stage*.sql` **drafts** (commit
`6c5d25d`, labelled "not yet applied"). The real RLS rollout (stage0→stage3)
had already been applied live on **2026-10-21** under *different* version
timestamps, so those drafts were stale duplicates with the wrong versions and
policy names. Because their versions were absent from the live
`supabase_migrations.schema_migrations`, a `supabase db push` treated them as
pending and **replayed them out of order** — one ended with
`revoke execute ... from anon` on the RLS policy-helper functions, which the
app (running as the `anon` role with a custom app-JWT) needs in order to
evaluate its policies. That revoke **locked every user out**. The drafts were
removed to prevent any further accidental replay. They remain in git history at
commit `6c5d25d` if ever needed for reference.

## Before you touch RLS or schema again

1. `supabase migration list` (and inspect live `pg_policies` / function grants)
   to see what is ACTUALLY applied — never trust a file in this folder.
2. The policy-helper functions (`app_uid`, `app_is_admin`, `app_admin_level`,
   `app_scoped_companies`, `app_is_viewer`, `app_trip_in_viewer_scope`) **must**
   keep `GRANT EXECUTE ... TO anon`. Revoking it breaks login for everyone.
3. To rebuild a trustworthy baseline, run `supabase db pull` against the live
   project and commit the generated baseline as the real starting history.
   Until then, apply reviewed changes directly and record them.
