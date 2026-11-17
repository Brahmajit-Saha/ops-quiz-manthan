-- ============================================================================
-- Patch v5: VALIDATION + AUTOMATIC ROUND NUMBERS
-- Run ONCE in the Supabase SQL Editor (after patch-v4). Keeps all your data.
--
--   1. Question base points must be 1..10 (1,000 etc. are rejected)
--   2. Round numbers are always 1,2,3... in play order. Deleting or reordering
--      rounds renumbers them automatically. The "name" is now only an OPTIONAL
--      title shown after the number ("Round 3 · Semi-final").
--   3. Eliminations per round: at least 1, at most 50% of the teams still in
--      (rounded down). Checked when the round is set up AND when it is confirmed.
-- ============================================================================

-- ---- 1. points ------------------------------------------------------------
-- NOT VALID = don't re-check old rows (the sample placeholders use 12/14), but
-- enforce the rule on everything added or edited from now on.
alter table questions drop constraint if exists questions_base_points_check;
alter table questions drop constraint if exists questions_base_points_range;
alter table questions add constraint questions_base_points_range
  check (base_points between 1 and 10) not valid;

create or replace function add_question(p_text text, p_base int, p_limit int, p_segment text, p_round uuid)
returns json language plpgsql security definer set search_path = public as $$
declare nextord int;
begin
  if p_base is null or p_base < 1 or p_base > 10 then
    return json_build_object('ok', false, 'reason', 'points_must_be_between_1_and_10'); end if;
  if p_limit not in (5,10) then return json_build_object('ok', false, 'reason', 'limit_must_be_5_or_10'); end if;
  if not exists (select 1 from rounds where id = p_round) then
    return json_build_object('ok', false, 'reason', 'unknown_round'); end if;
  select coalesce(max(order_index),0)+1 into nextord from questions;
  insert into questions (question_text, base_points, time_limit_seconds, segment_name, order_index, round_id)
  values (p_text, p_base, p_limit, p_segment, nextord, p_round);
  return json_build_object('ok', true);
end $$;

create or replace function update_question(p_id uuid, p_text text, p_base int, p_limit int, p_segment text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if p_base is null or p_base < 1 or p_base > 10 then
    return json_build_object('ok', false, 'reason', 'points_must_be_between_1_and_10'); end if;
  if p_limit not in (5,10) then return json_build_object('ok', false, 'reason', 'limit_must_be_5_or_10'); end if;
  update questions set question_text = p_text, base_points = p_base,
    time_limit_seconds = p_limit, segment_name = p_segment, is_placeholder = false
  where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ---- 2. round numbers & optional titles ------------------------------------
-- Old names like "Round 4" were fixed text. Turn them into "no title".
alter table rounds alter column name set default '';
update rounds set name = '' where name ~* '^\s*round\s*[0-9]+\s*$';

-- Make round_number exactly 1,2,3... in the current order.
create or replace function _renumber_rounds()
returns void language plpgsql security definer set search_path = public as $$
begin
  update rounds set round_number = -round_number;               -- park out of the way (UNIQUE column)
  update rounds r set round_number = x.rn
  from (select id, row_number() over (order by round_number desc) as rn from rounds) x
  where r.id = x.id;
end $$;
select _renumber_rounds();

-- A title typed as just "Round 3" is dropped (the number is shown anyway).
create or replace function _clean_round_title(p text)
returns text language sql immutable as $$
  select case when p is null or p ~* '^\s*round\s*[0-9]+\s*$' then '' else trim(p) end
$$;

-- Largest allowed number of eliminations = 50% of the teams still in, rounded down.
-- "Teams still in" = teams that have logged in and are not eliminated; before anyone has
-- logged in (setting up), it falls back to all team slots.
create or replace function _max_eliminations()
returns int language sql security definer set search_path = public as $$
  select floor(coalesce(
           nullif(count(*) filter (where not eliminated and display_name is not null), 0),
           count(*) filter (where not eliminated)
         ) / 2.0)::int
  from teams
$$;

create or replace function add_round(p_name text, p_eliminate boolean, p_count int)
returns json language plpgsql security definer set search_path = public as $$
declare nextn int; rid uuid; mx int := _max_eliminations();
begin
  if p_eliminate and (coalesce(p_count,0) < 1 or p_count > mx) then
    return json_build_object('ok', false,
      'reason', 'teams_to_eliminate_must_be_between_1_and_'||mx||'_(50%_of_teams_still_in)');
  end if;
  select coalesce(max(round_number),0)+1 into nextn from rounds;
  insert into rounds (round_number, name, eliminate_enabled, eliminate_count)
  values (nextn, _clean_round_title(p_name), p_eliminate, case when p_eliminate then p_count else 0 end)
  returning id into rid;
  return json_build_object('ok', true, 'round_id', rid);
end $$;

create or replace function update_round(p_id uuid, p_name text, p_eliminate boolean, p_count int)
returns json language plpgsql security definer set search_path = public as $$
declare done boolean; mx int := _max_eliminations();
begin
  select eliminations_applied into done from rounds where id = p_id;
  if done then return json_build_object('ok', false, 'reason', 'eliminations_already_applied'); end if;
  if p_eliminate and (coalesce(p_count,0) < 1 or p_count > mx) then
    return json_build_object('ok', false,
      'reason', 'teams_to_eliminate_must_be_between_1_and_'||mx||'_(50%_of_teams_still_in)');
  end if;
  update rounds set
    name = _clean_round_title(p_name),
    eliminate_enabled = p_eliminate,
    eliminate_count = case when p_eliminate then p_count else 0 end
  where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function delete_round(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from rounds) <= 1 then
    return json_build_object('ok', false, 'reason', 'cannot_delete_the_only_round'); end if;
  if exists (select 1 from marks m join questions q on q.id = m.question_id where q.round_id = p_id) then
    return json_build_object('ok', false, 'reason', 'round_already_has_scores'); end if;
  if exists (select 1 from game_control where id and current_round_id = p_id) then
    return json_build_object('ok', false, 'reason', 'round_is_current'); end if;
  delete from rounds where id = p_id;          -- its questions go with it
  perform _renumber_rounds();                  -- later rounds move up: 4 becomes 3
  return json_build_object('ok', true);
end $$;

-- ---- 3. confirm-time limit --------------------------------------------------
create or replace function apply_elimination(p_round uuid, p_team_ids uuid[])
returns json language plpgsql security definer set search_path = public as $$
declare r rounds%rowtype; n int; mx int := _max_eliminations();
begin
  select * into r from rounds where id = p_round;
  if r.id is null then return json_build_object('ok', false, 'reason', 'unknown_round'); end if;
  if not r.eliminate_enabled then return json_build_object('ok', false, 'reason', 'round_has_no_elimination'); end if;
  if r.eliminations_applied then return json_build_object('ok', false, 'reason', 'already_applied'); end if;
  if r.eliminate_count > mx then
    return json_build_object('ok', false,
      'reason', 'only_'||mx||'_can_go_out_now_(50%_of_teams_still_in)._Pause_and_edit_the_round');
  end if;
  n := coalesce(array_length(p_team_ids, 1), 0);
  if n <> r.eliminate_count then
    return json_build_object('ok', false, 'reason', 'pick_exactly_'||r.eliminate_count||'_teams');
  end if;
  update teams set eliminated = true, eliminated_in_round = r.round_number
    where id = any(p_team_ids) and not eliminated;
  update rounds set eliminations_applied = true where id = p_round;
  update game_control set updated_at = now() where id;
  return json_build_object('ok', true);
end $$;
