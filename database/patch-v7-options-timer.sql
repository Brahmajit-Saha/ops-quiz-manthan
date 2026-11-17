-- ============================================================================
-- Patch v7: 4 ANSWER OPTIONS PER QUESTION + TIMER UP TO 60s (10s steps)
-- Run ONCE in the Supabase SQL Editor (after patch v6).
-- Old questions keep working; they just have no options until you edit them.
-- ============================================================================

-- 1. the timer used to be locked to 5 or 10 seconds: remove that lock
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.questions'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%time_limit_seconds%'
  loop
    execute format('alter table public.questions drop constraint %I', c.conname);
  end loop;
end $$;

-- 2. a place to keep the 4 options (A, B, C, D)
alter table questions add column if not exists options text[];

-- 3. add / edit a question: now takes the 4 options
drop function if exists add_question(text, int, int, text, uuid);
drop function if exists update_question(uuid, text, int, int, text);

create or replace function _check_question(p_base int, p_limit int, p_options text[])
returns json language plpgsql immutable as $$
declare i int;
begin
  if p_base is null or p_base < 1 or p_base > 10 then
    return json_build_object('ok', false, 'reason', 'points_must_be_between_1_and_10'); end if;
  if p_limit is null or p_limit < 10 or p_limit > 60 or p_limit % 10 <> 0 then
    return json_build_object('ok', false, 'reason', 'timer_must_be_10_20_30_40_50_or_60_seconds'); end if;
  if p_options is null or coalesce(array_length(p_options, 1), 0) <> 4 then
    return json_build_object('ok', false, 'reason', 'exactly_4_options_required'); end if;
  for i in 1..4 loop
    if p_options[i] is null or btrim(p_options[i]) = '' then
      return json_build_object('ok', false, 'reason', 'all_4_options_must_be_filled_in'); end if;
  end loop;
  return null;
end $$;

create or replace function add_question(p_text text, p_base int, p_limit int, p_segment text, p_round uuid, p_options text[])
returns json language plpgsql security definer set search_path = public as $$
declare nextord int; bad json;
begin
  bad := _check_question(p_base, p_limit, p_options);
  if bad is not null then return bad; end if;
  if not exists (select 1 from rounds where id = p_round) then
    return json_build_object('ok', false, 'reason', 'unknown_round'); end if;
  select coalesce(max(order_index),0)+1 into nextord from questions;
  insert into questions (question_text, base_points, time_limit_seconds, segment_name, order_index, round_id, options)
  values (p_text, p_base, p_limit, p_segment, nextord, p_round, p_options);
  return json_build_object('ok', true);
end $$;

create or replace function update_question(p_id uuid, p_text text, p_base int, p_limit int, p_segment text, p_options text[])
returns json language plpgsql security definer set search_path = public as $$
declare bad json;
begin
  bad := _check_question(p_base, p_limit, p_options);
  if bad is not null then return bad; end if;
  update questions set question_text = p_text, base_points = p_base, time_limit_seconds = p_limit,
    segment_name = p_segment, options = p_options, is_placeholder = false
  where id = p_id;
  return json_build_object('ok', true);
end $$;

