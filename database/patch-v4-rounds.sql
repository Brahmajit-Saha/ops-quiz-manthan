-- ============================================================================
-- Patch v4: ROUNDS + ELIMINATION
--
-- Run ONCE in the Supabase SQL Editor on your existing project (after the setup
-- script and patches v2/v3). It does NOT delete any existing question, team or
-- score. All your current questions are placed into "Round 1".
--
-- What it adds
--   * rounds table: any number of rounds, each with its own questions
--   * per-round option: eliminate teams (yes/no) and how many
--   * teams.eliminated flag (eliminated teams are locked out)
--   * game flow: after a round's last question the game pauses on a
--     "round complete" screen; Admin confirms eliminations; GM starts the next round
--   * scores carry over across rounds; PASS cards also carry over
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. rounds
-- ----------------------------------------------------------------------------
create table if not exists rounds (
  id                    uuid primary key default gen_random_uuid(),
  round_number          int  not null unique,            -- play order: 1, 2, 3 ...
  name                  text not null default 'Round',
  eliminate_enabled     boolean not null default false,
  eliminate_count       int  not null default 0 check (eliminate_count >= 0),
  eliminations_applied  boolean not null default false,
  created_at            timestamptz not null default now()
);

insert into rounds (round_number, name)
select 1, 'Round 1' where not exists (select 1 from rounds);

-- ----------------------------------------------------------------------------
-- 2. questions belong to a round; teams can be eliminated; game_control tracks round
-- ----------------------------------------------------------------------------
alter table questions add column if not exists round_id uuid references rounds(id) on delete cascade;
update questions set round_id = (select id from rounds order by round_number limit 1) where round_id is null;
alter table questions alter column round_id set not null;
create index if not exists questions_round_idx on questions (round_id, order_index);

alter table teams add column if not exists eliminated boolean not null default false;
alter table teams add column if not exists eliminated_in_round int;

alter table game_control add column if not exists current_round_id uuid references rounds(id) on delete set null;
alter table game_control add column if not exists round_state text not null default 'playing';
alter table game_control drop constraint if exists game_control_round_state_check;
alter table game_control add constraint game_control_round_state_check
  check (round_state in ('playing','between'));
update game_control set current_round_id = (select round_id from questions where id = game_control.current_question_id)
  where current_question_id is not null;

-- ----------------------------------------------------------------------------
-- 3. permissions (same pattern as the other public tables)
-- ----------------------------------------------------------------------------
alter table rounds enable row level security;
drop policy if exists rounds_read on rounds;
create policy rounds_read on rounds for select using (true);
grant select on public.rounds to anon, authenticated;
grant select on public.questions, public.teams, public.game_control to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Round management (Admin)
-- ----------------------------------------------------------------------------
create or replace function add_round(p_name text, p_eliminate boolean, p_count int)
returns json language plpgsql security definer set search_path = public as $$
declare nextn int; rid uuid;
begin
  if p_eliminate and coalesce(p_count,0) < 1 then
    return json_build_object('ok', false, 'reason', 'enter_how_many_teams_to_eliminate');
  end if;
  select coalesce(max(round_number),0)+1 into nextn from rounds;
  insert into rounds (round_number, name, eliminate_enabled, eliminate_count)
  values (nextn, coalesce(nullif(trim(p_name),''), 'Round '||nextn), p_eliminate,
          case when p_eliminate then p_count else 0 end)
  returning id into rid;
  return json_build_object('ok', true, 'round_id', rid);
end $$;

create or replace function update_round(p_id uuid, p_name text, p_eliminate boolean, p_count int)
returns json language plpgsql security definer set search_path = public as $$
declare done boolean;
begin
  select eliminations_applied into done from rounds where id = p_id;
  if done then return json_build_object('ok', false, 'reason', 'eliminations_already_applied'); end if;
  if p_eliminate and coalesce(p_count,0) < 1 then
    return json_build_object('ok', false, 'reason', 'enter_how_many_teams_to_eliminate');
  end if;
  update rounds set
    name = coalesce(nullif(trim(p_name),''), name),
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
  return json_build_object('ok', true);
end $$;

create or replace function move_round(p_id uuid, p_dir text)
returns json language plpgsql security definer set search_path = public as $$
declare cur int; nid uuid; nnum int;
begin
  select round_number into cur from rounds where id = p_id;
  if p_dir = 'up' then
    select id, round_number into nid, nnum from rounds where round_number < cur order by round_number desc limit 1;
  else
    select id, round_number into nid, nnum from rounds where round_number > cur order by round_number asc limit 1;
  end if;
  if nid is null then return json_build_object('ok', true); end if;
  -- swap via a temporary value (round_number is UNIQUE)
  update rounds set round_number = -1  where id = p_id;
  update rounds set round_number = cur where id = nid;
  update rounds set round_number = nnum where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ----------------------------------------------------------------------------
-- 5. Questions: now belong to a round
-- ----------------------------------------------------------------------------
drop function if exists add_question(text, int, int, text);
create or replace function add_question(p_text text, p_base int, p_limit int, p_segment text, p_round uuid)
returns json language plpgsql security definer set search_path = public as $$
declare nextord int;
begin
  if p_limit not in (5,10) then return json_build_object('ok', false, 'reason', 'limit_must_be_5_or_10'); end if;
  if not exists (select 1 from rounds where id = p_round) then
    return json_build_object('ok', false, 'reason', 'unknown_round'); end if;
  select coalesce(max(order_index),0)+1 into nextord from questions;
  insert into questions (question_text, base_points, time_limit_seconds, segment_name, order_index, round_id)
  values (p_text, greatest(p_base,1), p_limit, p_segment, nextord, p_round);
  return json_build_object('ok', true);
end $$;

-- reorder only within the same round
create or replace function move_question(p_id uuid, p_dir text)
returns json language plpgsql security definer set search_path = public as $$
declare cur int; rid uuid; neighbour_id uuid; neighbour_ord int;
begin
  select order_index, round_id into cur, rid from questions where id = p_id;
  if p_dir = 'up' then
    select id, order_index into neighbour_id, neighbour_ord from questions
      where round_id = rid and order_index < cur order by order_index desc limit 1;
  else
    select id, order_index into neighbour_id, neighbour_ord from questions
      where round_id = rid and order_index > cur order by order_index asc limit 1;
  end if;
  if neighbour_id is null then return json_build_object('ok', true); end if;
  update questions set order_index = neighbour_ord where id = p_id;
  update questions set order_index = cur where id = neighbour_id;
  return json_build_object('ok', true);
end $$;

-- ----------------------------------------------------------------------------
-- 6. Game flow
-- ----------------------------------------------------------------------------
-- Pointing the game at a question also records which round it is in.
create or replace function set_current_question(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  update game_control set
    current_question_id = p_question,
    current_round_id = (select round_id from questions where id = p_question),
    round_state = 'playing',
    question_phase = 'idle',
    question_started_at = null,
    current_attempt_rank = 0,
    updated_at = now()
  where id;
  return json_build_object('ok', true);
end $$;

-- GM: the last question of the round is done -> go to the "round complete" screen.
create or replace function end_round()
returns json language plpgsql security definer set search_path = public as $$
begin
  update game_control set
    round_state = 'between',
    current_question_id = null,
    question_phase = 'idle',
    question_started_at = null,
    current_attempt_rank = 0,
    updated_at = now()
  where id and current_round_id is not null;
  return json_build_object('ok', true);
end $$;

-- Admin: confirm which teams go out. Must be exactly the number set for the round.
create or replace function apply_elimination(p_round uuid, p_team_ids uuid[])
returns json language plpgsql security definer set search_path = public as $$
declare r rounds%rowtype; n int;
begin
  select * into r from rounds where id = p_round;
  if r.id is null then return json_build_object('ok', false, 'reason', 'unknown_round'); end if;
  if not r.eliminate_enabled then return json_build_object('ok', false, 'reason', 'round_has_no_elimination'); end if;
  if r.eliminations_applied then return json_build_object('ok', false, 'reason', 'already_applied'); end if;
  n := coalesce(array_length(p_team_ids, 1), 0);
  if n <> r.eliminate_count then
    return json_build_object('ok', false, 'reason', 'pick_exactly_'||r.eliminate_count||'_teams');
  end if;
  update teams set eliminated = true, eliminated_in_round = r.round_number
    where id = any(p_team_ids) and not eliminated;
  update rounds set eliminations_applied = true where id = p_round;
  update game_control set updated_at = now() where id;   -- nudges every phone to refresh
  return json_build_object('ok', true);
end $$;

-- GM: begin the next round (blocked until this round's eliminations are confirmed).
create or replace function start_next_round()
returns json language plpgsql security definer set search_path = public as $$
declare cur rounds%rowtype; nxt rounds%rowtype; first_q uuid;
begin
  select r.* into cur from rounds r join game_control g on g.current_round_id = r.id where g.id;
  if cur.id is null then return json_build_object('ok', false, 'reason', 'no_current_round'); end if;
  if cur.eliminate_enabled and not cur.eliminations_applied then
    return json_build_object('ok', false, 'reason', 'admin_must_confirm_eliminations_first');
  end if;
  select r.* into nxt from rounds r
    where r.round_number > cur.round_number
      and exists (select 1 from questions q where q.round_id = r.id)
    order by r.round_number limit 1;
  if nxt.id is null then return json_build_object('ok', false, 'reason', 'no_more_rounds'); end if;
  select id into first_q from questions where round_id = nxt.id order by order_index limit 1;
  update game_control set
    current_question_id = first_q, current_round_id = nxt.id, round_state = 'playing',
    question_phase = 'idle', question_started_at = null, current_attempt_rank = 0,
    updated_at = now()
  where id;
  return json_build_object('ok', true);
end $$;

-- ----------------------------------------------------------------------------
-- 7. Eliminated teams cannot buzz or pass (server-enforced)
-- ----------------------------------------------------------------------------
create or replace function submit_buzz(p_team uuid, p_question uuid, p_client_t numeric)
returns json language plpgsql security definer set search_path = public as $$
declare row_id uuid; started timestamptz; t numeric;
begin
  if (select eliminated from teams where id = p_team) then
    return json_build_object('ok', false, 'reason', 'eliminated');
  end if;
  if not _window_open(p_question) then
    return json_build_object('ok', false, 'reason', 'window_closed');
  end if;
  select question_started_at into started from game_control where id;
  t := greatest(round(extract(epoch from (clock_timestamp() - started))::numeric, 3), 0);
  begin
    insert into buzzes (question_id, team_id, action_type, client_reaction_time)
    values (p_question, p_team, 'buzz', t)
    returning id into row_id;
  exception when unique_violation then
    return json_build_object('ok', false, 'reason', 'already_acted');
  end;
  return json_build_object('ok', true, 'buzz_id', row_id, 'reaction_time', t);
end $$;

create or replace function submit_pass(p_team uuid, p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
declare remaining int;
begin
  if (select eliminated from teams where id = p_team) then
    return json_build_object('ok', false, 'reason', 'eliminated');
  end if;
  if not _window_open(p_question) then
    return json_build_object('ok', false, 'reason', 'window_closed');
  end if;
  select passes_remaining into remaining from teams where id = p_team for update;
  if remaining <= 0 then
    return json_build_object('ok', false, 'reason', 'no_passes_left');
  end if;
  begin
    insert into buzzes (question_id, team_id, action_type)
    values (p_question, p_team, 'pass');
  exception when unique_violation then
    return json_build_object('ok', false, 'reason', 'already_acted');
  end;
  update teams set passes_remaining = passes_remaining - 1 where id = p_team;
  return json_build_object('ok', true, 'passes_remaining', remaining - 1);
end $$;

-- ----------------------------------------------------------------------------
-- 8. Scoreboard shows eliminated teams (at the bottom); restart clears rounds state
-- ----------------------------------------------------------------------------
create or replace function get_scoreboard()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(row_to_json(s)), '[]'::json) from (
    select t.id as team_id, t.team_number, coalesce(t.display_name, 'Team '||t.team_number) as team_name,
           t.passes_remaining, t.eliminated, t.eliminated_in_round,
           coalesce(sum(m.points_awarded), 0) as total
    from teams t
    left join marks m on m.team_id = t.id
    where t.display_name is not null
    group by t.id
    order by t.eliminated asc, total desc, t.team_number asc
  ) s;
$$;

create or replace function restart_game()
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from marks  where true;
  delete from buzzes where true;
  update teams  set passes_remaining = 3, eliminated = false, eliminated_in_round = null where true;
  update rounds set eliminations_applied = false where true;
  update game_control set status = 'setup', current_question_id = null, current_round_id = null,
    round_state = 'playing', question_phase = 'idle', question_started_at = null,
    current_attempt_rank = 0, updated_at = now() where id;
  return json_build_object('ok', true);
end $$;
