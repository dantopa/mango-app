-- Performance: RLS evaluated once per query, indexes on foreign keys, and one
-- duplicate index dropped. Behaviour is unchanged: every policy keeps its exact
-- condition, only `auth.uid()` becomes `(select auth.uid())`, which Postgres
-- evaluates once as an init plan instead of once per row (Supabase advisor
-- auth_rls_initplan, 38 policies).

-- --- RLS: auth.uid() -> (select auth.uid()) ----------------------------------

alter policy "accounts: owner read"   on public.accounts using ((select auth.uid()) = user_id);
alter policy "accounts: owner write"  on public.accounts with check ((select auth.uid()) = user_id);
alter policy "accounts: owner update" on public.accounts using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "accounts: owner delete" on public.accounts using ((select auth.uid()) = user_id);

alter policy "categories: owner read"   on public.categories using ((select auth.uid()) = user_id);
alter policy "categories: owner write"  on public.categories with check ((select auth.uid()) = user_id);
alter policy "categories: owner update" on public.categories using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "categories: owner delete" on public.categories using ((select auth.uid()) = user_id);

alter policy "goals: owner read"   on public.goals using ((select auth.uid()) = user_id);
alter policy "goals: owner write"  on public.goals with check ((select auth.uid()) = user_id);
alter policy "goals: owner update" on public.goals using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "goals: owner delete" on public.goals using ((select auth.uid()) = user_id);

alter policy "monthly_close: owner read"   on public.monthly_close using ((select auth.uid()) = user_id);
alter policy "monthly_close: owner write"  on public.monthly_close with check ((select auth.uid()) = user_id);
alter policy "monthly_close: owner update" on public.monthly_close using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "monthly_close: owner delete" on public.monthly_close using ((select auth.uid()) = user_id);

alter policy "snapshots: owner read"   on public.net_worth_snapshots using ((select auth.uid()) = user_id);
alter policy "snapshots: owner write"  on public.net_worth_snapshots with check ((select auth.uid()) = user_id);
alter policy "snapshots: owner update" on public.net_worth_snapshots using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "snapshots: owner delete" on public.net_worth_snapshots using ((select auth.uid()) = user_id);

alter policy "transactions: owner read"   on public.transactions using ((select auth.uid()) = user_id);
alter policy "transactions: owner write"  on public.transactions with check ((select auth.uid()) = user_id);
alter policy "transactions: owner update" on public.transactions using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "transactions: owner delete" on public.transactions using ((select auth.uid()) = user_id);

alter policy "user_settings: owner read"   on public.user_settings using ((select auth.uid()) = user_id);
alter policy "user_settings: owner write"  on public.user_settings with check ((select auth.uid()) = user_id);
alter policy "user_settings: owner update" on public.user_settings using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "user_settings: owner delete" on public.user_settings using ((select auth.uid()) = user_id);

alter policy "close_items: owner read"   on public.monthly_close_items using ((select auth.uid()) = user_id);
alter policy "close_items: owner write"  on public.monthly_close_items with check ((select auth.uid()) = user_id);
alter policy "close_items: owner update" on public.monthly_close_items using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "close_items: owner delete" on public.monthly_close_items using ((select auth.uid()) = user_id);

alter policy owner_all on public.merchant_category_rules using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy owner_all on public.push_ingest_log using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy owner_all on public.push_parser_templates using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy owner_all on public.push_subscriptions using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy owner_all on public.transfer_classification_rules using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter policy "reconcile_log: owner read" on public.transaction_reconcile_log using ((select auth.uid()) = user_id);

-- --- Foreign keys without a covering index ------------------------------------
-- push_ingest_log.transaction_id is the hot one: the ingest pipeline and the
-- reconciler look up log rows by transaction on every notification.
create index if not exists idx_push_ingest_log_transaction_id
  on public.push_ingest_log (transaction_id);
create index if not exists idx_push_ingest_log_raw_log_id
  on public.push_ingest_log (raw_log_id);
create index if not exists idx_transactions_duplicate_of
  on public.transactions (duplicate_of);
create index if not exists idx_transactions_paired_with
  on public.transactions (paired_with);
create index if not exists idx_reconcile_log_ref_transaction_id
  on public.transaction_reconcile_log (ref_transaction_id);
create index if not exists idx_categories_parent_id
  on public.categories (parent_id);
create index if not exists idx_merchant_category_rules_category_id
  on public.merchant_category_rules (category_id);
create index if not exists idx_monthly_close_items_user_id
  on public.monthly_close_items (user_id);

-- --- Duplicate index ------------------------------------------------------------
-- Identical to idx_transactions_account_id, which stays.
drop index if exists public.transactions_account_idx;
