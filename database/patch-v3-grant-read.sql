-- Patch v3: let the app READ the three public tables.
-- Fixes "permission denied for table questions" in the admin question list.
-- (The row-level policies already allow reading; the table-level permission was missing.)
-- Secret tables (app_config, buzzes, marks) are deliberately NOT granted.
grant usage on schema public to anon, authenticated;
grant select on public.questions    to anon, authenticated;
grant select on public.teams        to anon, authenticated;
grant select on public.game_control to anon, authenticated;
