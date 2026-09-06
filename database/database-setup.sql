-- ============================================================================
-- OPSPHERE — Round 2 "OPS in One Word" (digital buzzer game)
-- database-setup.sql  —  run ONCE in Supabase SQL Editor on a fresh project.
--
-- This single script builds every table, every security rule, and all the
-- server-authoritative game logic (buzz / pass / mark / advance). It mirrors
-- the Supply Chain game's "one setup script" convention so the same admin
-- team is on familiar ground.
--
-- Safe to re-run: it drops and rebuilds its own objects. On a fresh project
-- any "destructive operation" warning is expected — run it anyway.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Clean slate (idempotent re-run support)
-- ----------------------------------------------------------------------------
drop table if exists marks          cascade;
drop table if exists buzzes         cascade;
drop table if exists questions      cascade;
drop table if exists teams          cascade;
drop table if exists game_control   cascade;
drop table if exists app_config     cascade;

-- ----------------------------------------------------------------------------
-- 1. app_config  — single row. Domain + the three ROLE-PASSWORD gates.
--    NOTE: the email (admin@, gm@, teamN@) is NOT a credential. It only maps a
--    login to a role. Security of the admin/GM roles rests on these passwords.
--    Keep them non-trivial and OFF the projector (the GM laptop IS the room
--    display now, so anything on that screen is handed to the room).
-- ----------------------------------------------------------------------------
create table app_config (
  id                boolean primary key default true check (id),   -- forces one row
  login_domain      text    not null default 'ops.ibsb.gg',
  admin_email       text    not null default 'admin@ops.ibsb.gg',
  gm_email          text    not null default 'gm@ops.ibsb.gg',
  admin_password    text    not null default 'CHANGE-ME-admin',
  gm_password       text    not null default 'CHANGE-ME-gm',
  player_password   text    not null default 'CHANGE-ME-player',
  updated_at        timestamptz not null default now()
);
insert into app_config (id) values (true);

-- ----------------------------------------------------------------------------
-- 2. teams  — one login per team (Model A). The login account IS the buzzer.
--    passes_remaining starts at 3 (spec §3). Enforced server-side only.
-- ----------------------------------------------------------------------------
create table teams (
  id                uuid primary key default gen_random_uuid(),
  team_number       int  not null unique,
  login_email       text not null unique,          -- e.g. team1@ops.ibsb.gg
  display_name      text,                           -- entered by the team on join
  passes_remaining  int  not null default 3 check (passes_remaining >= 0),
  created_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 3. questions  — the bank, as DATA (spec §9). Reorderable without redeploy.
--    time_limit_seconds is the per-question L (5 or 10). base_points is B.
--    IMPORTANT: seed rows below are LABELLED PLACEHOLDERS. Replace with the
--    real bank from the source doc. Do not ship placeholders as final content.
-- ----------------------------------------------------------------------------
create table questions (
  id                  uuid primary key default gen_random_uuid(),
  question_text       text not null,
  base_points         int  not null default 10 check (base_points > 0),
  time_limit_seconds  int  not null default 10 check (time_limit_seconds in (5, 10)),
  segment_name        text,
  order_index         int  not null,
  is_placeholder      boolean not null default false,   -- true = not real content
  created_at          timestamptz not null default now()
);
create index questions_order_idx on questions (order_index);

-- ----------------------------------------------------------------------------
-- 4. game_control  — single row. The live state machine + admin toggles.
--    question lifecycle:  idle -> open -> buzzing_closed -> resolved | voided
-- ----------------------------------------------------------------------------
create table game_control (
  id                      boolean primary key default true check (id),
  status                  text not null default 'setup'
                            check (status in ('setup','running','paused','finished')),
  current_question_id     uuid references questions(id),
  question_phase          text not null default 'idle'
                            check (question_phase in ('idle','open','buzzing_closed','resolved','voided')),
  question_started_at     timestamptz,               -- server truth for the window
  current_attempt_rank    int not null default 0,    -- which of top-3 is "up now" (1..3)
  show_questions_to_players boolean not null default true,  -- admin toggle (§#4)
  updated_at              timestamptz not null default now()
);
insert into game_control (id) values (true);

-- ----------------------------------------------------------------------------
-- 5. buzzes  — one row per team-action per question. BUZZ or PASS.
--    UNIQUE(question_id, team_id) is the hard enforcement of BOTH:
--      * "first press per team per question only" (spec §2.4)
--      * "buzz and pass are mutually exclusive; first action wins" (spec §3)
--      * PASS double-tap idempotency (spec §8) — 2nd insert violates unique -> no-op
--    client_reaction_time = the client-computed t (spec §5, deliberate trade-off).
--    server_seq = monotonic server-receipt order, kept ONLY as tie-break (§8) and
--                 as the forgery-warning signal (compare claimed t vs arrival order).
-- ----------------------------------------------------------------------------
create sequence if not exists buzz_server_seq;
create table buzzes (
  id                    uuid primary key default gen_random_uuid(),
  question_id           uuid not null references questions(id) on delete cascade,
  team_id               uuid not null references teams(id) on delete cascade,
  action_type           text not null check (action_type in ('buzz','pass')),
  client_reaction_time  numeric(6,3),               -- t, seconds; null for pass
  server_seq            bigint not null default nextval('buzz_server_seq'),
  server_received_at    timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  unique (question_id, team_id)                      -- the load-bearing constraint
);
create index buzzes_question_idx on buzzes (question_id);

-- ----------------------------------------------------------------------------
-- 6. marks  — the GM's ✓/✗ adjudication + computed points. One row per attempt.
--    UNIQUE(question_id, team_id) so an undo/redo overwrites rather than stacks.
-- ----------------------------------------------------------------------------
create table marks (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null references questions(id) on delete cascade,
  team_id         uuid not null references teams(id) on delete cascade,
  is_correct      boolean not null,
  points_awarded  int not null,                      -- signed; already rounded
  marked_at       timestamptz not null default now(),
  unique (question_id, team_id)
);
create index marks_team_idx on marks (team_id);

-- ============================================================================
-- SERVER-AUTHORITATIVE LOGIC  (all SECURITY DEFINER so RLS can lock clients out
-- of the tables directly, while these functions are the only write path)
-- ============================================================================

-- Helper: is the buzz window currently open for a given question?
-- Server truth = now() within [started_at, started_at + L]. No pg_cron needed;
-- the window "closes itself" by arithmetic and every write re-checks it.
create or replace function _window_open(p_question uuid)
returns boolean language plpgsql stable as $$
declare
  gc  game_control%rowtype;
  lim int;
begin
  select * into gc from game_control where id;
  if gc.current_question_id is distinct from p_question then return false; end if;
  if gc.question_phase <> 'open' then return false; end if;
  if gc.question_started_at is null then return false; end if;
  select time_limit_seconds into lim from questions where id = p_question;
  return now() <= gc.question_started_at + make_interval(secs => lim);
end $$;

-- ----- SUBMIT BUZZ ----------------------------------------------------------
-- Rejects: wrong question, window closed, team already acted (buzz OR pass).
-- The unique constraint makes double-submits a no-op (idempotent).
create or replace function submit_buzz(p_team uuid, p_question uuid, p_client_t numeric)
returns json language plpgsql security definer set search_path = public as $$
declare row_id uuid;
begin
  if not _window_open(p_question) then
    return json_build_object('ok', false, 'reason', 'window_closed');
  end if;
  begin
    insert into buzzes (question_id, team_id, action_type, client_reaction_time)
    values (p_question, p_team, 'buzz', greatest(p_client_t, 0))
    returning id into row_id;
  exception when unique_violation then
    return json_build_object('ok', false, 'reason', 'already_acted');
  end;
  return json_build_object('ok', true, 'buzz_id', row_id);
end $$;

-- ----- SUBMIT PASS ----------------------------------------------------------
-- Rejects: wrong question, window closed, already acted, no passes left.
-- Decrement + insert in one transaction so a retry can't double-decrement (§8).
create or replace function submit_pass(p_team uuid, p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
declare remaining int;
begin
  if not _window_open(p_question) then
    return json_build_object('ok', false, 'reason', 'window_closed');
  end if;
  -- lock the team row so concurrent double-taps serialise
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

-- ----- SET CURRENT QUESTION (GM, ready state — no timer yet) ----------------
-- Points the game at a question and shows the "ready" panel to the GM. The room
-- sees only the question NUMBER here, never the text, so nothing leaks early.
create or replace function set_current_question(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  update game_control set
    current_question_id = p_question,
    question_phase = 'idle',
    question_started_at = null,
    current_attempt_rank = 0,
    updated_at = now()
  where id;
  return json_build_object('ok', true);
end $$;

-- ----- START QUESTION (GM) --------------------------------------------------
create or replace function start_question(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  update game_control set
    current_question_id = p_question,
    question_phase = 'open',
    question_started_at = now(),
    current_attempt_rank = 0,
    updated_at = now()
  where id;
  return json_build_object('ok', true, 'started_at', now());
end $$;

-- ----- CLOSE BUZZING + RANK (GM, when timer hits zero) ----------------------
-- Returns the top-3 buzzers fastest->slowest. Primary sort = client t (spec §5);
-- tie-break = server_seq (§8). Also flags forgery-suspect rows: a buzz whose
-- claimed t ranks it fast but whose server arrival order is late, or t<0 / t>L.
create or replace function close_buzzing(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
declare lim int; result json;
begin
  update game_control set question_phase = 'buzzing_closed', current_attempt_rank = 1,
    updated_at = now()
    where id and current_question_id = p_question and question_phase = 'open';
  select time_limit_seconds into lim from questions where id = p_question;
  select json_agg(row_to_json(r)) into result from (
    select
      b.team_id,
      t.team_number,
      coalesce(t.display_name, 'Team ' || t.team_number) as team_name,
      b.client_reaction_time,
      b.server_seq,
      row_number() over (order by b.client_reaction_time asc, b.server_seq asc) as rank,
      (b.client_reaction_time < 0 or b.client_reaction_time > lim
       or row_number() over (order by b.client_reaction_time asc)
          <> row_number() over (order by b.server_seq asc)) as suspect
    from buzzes b join teams t on t.id = b.team_id
    where b.question_id = p_question and b.action_type = 'buzz'
    order by b.client_reaction_time asc, b.server_seq asc
    limit 3
  ) r;
  return json_build_object('ok', true, 'ranking', coalesce(result, '[]'::json));
end $$;

-- ----- GET RANKING (read-only; safe to call any time, changes no state) ------
create or replace function get_ranking(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
declare lim int; result json;
begin
  select time_limit_seconds into lim from questions where id = p_question;
  select json_agg(row_to_json(r)) into result from (
    select
      b.team_id,
      t.team_number,
      coalesce(t.display_name, 'Team ' || t.team_number) as team_name,
      b.client_reaction_time,
      b.server_seq,
      row_number() over (order by b.client_reaction_time asc, b.server_seq asc) as rank,
      (b.client_reaction_time < 0 or b.client_reaction_time > lim
       or row_number() over (order by b.client_reaction_time asc)
          <> row_number() over (order by b.server_seq asc)) as suspect
    from buzzes b join teams t on t.id = b.team_id
    where b.question_id = p_question and b.action_type = 'buzz'
    order by b.client_reaction_time asc, b.server_seq asc
    limit 3
  ) r;
  return json_build_object('ok', true, 'ranking', coalesce(result, '[]'::json));
end $$;

-- ----- MARK ATTEMPT (GM ✓/✗) ------------------------------------------------
-- Computes points via the EXACT formula (spec §4), rounds with round() = JS
-- Math.round behaviour at .5 ties? NB: Postgres round() is half-away-from-zero.
-- We instead emulate Math.round (half toward +inf) to match §4a's chosen convention.
create or replace function _js_round(x numeric) returns int language sql immutable as $$
  select floor(x + 0.5)::int;
$$;

create or replace function mark_attempt(p_question uuid, p_team uuid, p_correct boolean)
returns json language plpgsql security definer set search_path = public as $$
declare b numeric; l int; t numeric; pts int; gc game_control%rowtype;
begin
  select * into gc from game_control where id;
  if gc.question_phase not in ('buzzing_closed') then
    return json_build_object('ok', false, 'reason', 'not_in_marking_phase');
  end if;
  select base_points, time_limit_seconds into b, l from questions where id = p_question;
  select client_reaction_time into t from buzzes
    where question_id = p_question and team_id = p_team and action_type = 'buzz';
  if t is null then return json_build_object('ok', false, 'reason', 'no_buzz'); end if;
  if p_correct then
    pts := _js_round(b * (l - t));
  else
    pts := _js_round(-(b * (l - t)) / 2.0);
  end if;
  insert into marks (question_id, team_id, is_correct, points_awarded)
  values (p_question, p_team, p_correct, pts)
  on conflict (question_id, team_id)
    do update set is_correct = excluded.is_correct,
                  points_awarded = excluded.points_awarded,
                  marked_at = now();
  if p_correct then
    update game_control set question_phase = 'resolved', updated_at = now() where id;
  else
    -- advance to next attempt, but stop at the smaller of (top 3) or (# who buzzed)
    declare n_buzz int;
    begin
      select count(*) into n_buzz from buzzes
        where question_id = p_question and action_type = 'buzz';
      if gc.current_attempt_rank >= least(3, n_buzz) then
        update game_control set question_phase = 'resolved', updated_at = now() where id;
      else
        update game_control set current_attempt_rank = current_attempt_rank + 1,
          updated_at = now() where id;
      end if;
    end;
  end if;
  return json_build_object('ok', true, 'points', pts);
end $$;

-- ----- UNDO CURRENT MARK (GM in-flow, Admin backstop) -----------------------
create or replace function undo_mark(p_question uuid, p_team uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from marks where question_id = p_question and team_id = p_team;
  update game_control set question_phase = 'buzzing_closed', updated_at = now()
    where id and current_question_id = p_question;
  return json_build_object('ok', true);
end $$;

-- ----- VOID QUESTION (Admin safety net, §8) ---------------------------------
create or replace function void_question(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from marks where question_id = p_question;   -- nobody scores it
  update game_control set question_phase = 'voided', updated_at = now() where id;
  return json_build_object('ok', true);
end $$;

-- ----- PAUSE / RESUME / RESET ROUND / RESTART GAME (Admin) -------------------
create or replace function set_status(p_status text)
returns json language plpgsql security definer set search_path = public as $$
begin
  update game_control set status = p_status, updated_at = now() where id;
  return json_build_object('ok', true, 'status', p_status);
end $$;

-- reset_round: clear the CURRENT question's buzzes+marks and re-open nothing
-- (scores for other questions untouched). Refunds passes spent on this question.
create or replace function reset_round(p_question uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  update teams t set passes_remaining = passes_remaining + 1
    from buzzes b where b.team_id = t.id
      and b.question_id = p_question and b.action_type = 'pass';
  delete from buzzes where question_id = p_question;
  delete from marks  where question_id = p_question;
  update game_control set question_phase = 'idle', question_started_at = null,
    current_attempt_rank = 0, updated_at = now() where id;
  return json_build_object('ok', true);
end $$;

-- restart_game: wipe ALL progress back to question 1; restore all PASS cards.
create or replace function restart_game()
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from marks  where true;
  delete from buzzes where true;
  update teams set passes_remaining = 3 where true;
  update game_control set status = 'setup', current_question_id = null,
    question_phase = 'idle', question_started_at = null,
    current_attempt_rank = 0, updated_at = now() where id;
  return json_build_object('ok', true);
end $$;

-- ----- ADMIN SCOREBOARD (read path; players are still blocked from marks) ---
-- Returns claimed teams (those that logged in / set a name) with running totals,
-- highest first. Empty spare slots are excluded so the leaderboard stays clean.
create or replace function get_scoreboard()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(row_to_json(s)), '[]'::json) from (
    select t.team_number, coalesce(t.display_name, 'Team '||t.team_number) as team_name,
           t.passes_remaining,
           coalesce(sum(m.points_awarded), 0) as total
    from teams t
    left join marks m on m.team_id = t.id
    where t.display_name is not null
    group by t.id
    order by total desc, t.team_number asc
  ) s;
$$;

-- ----- AUTHORING (Admin question editor — no SQL needed) --------------------
create or replace function add_question(p_text text, p_base int, p_limit int, p_segment text)
returns json language plpgsql security definer set search_path = public as $$
declare nextord int;
begin
  if p_limit not in (5,10) then return json_build_object('ok', false, 'reason', 'limit_must_be_5_or_10'); end if;
  select coalesce(max(order_index),0)+1 into nextord from questions;
  insert into questions (question_text, base_points, time_limit_seconds, segment_name, order_index)
  values (p_text, greatest(p_base,1), p_limit, p_segment, nextord);
  return json_build_object('ok', true);
end $$;

create or replace function update_question(p_id uuid, p_text text, p_base int, p_limit int, p_segment text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if p_limit not in (5,10) then return json_build_object('ok', false, 'reason', 'limit_must_be_5_or_10'); end if;
  update questions set question_text = p_text, base_points = greatest(p_base,1),
    time_limit_seconds = p_limit, segment_name = p_segment, is_placeholder = false
  where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function delete_question(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from questions where id = p_id;
  return json_build_object('ok', true);
end $$;

-- move a question up/down one slot by swapping order_index with its neighbour
create or replace function move_question(p_id uuid, p_dir text)
returns json language plpgsql security definer set search_path = public as $$
declare cur int; neighbour_id uuid; neighbour_ord int;
begin
  select order_index into cur from questions where id = p_id;
  if p_dir = 'up' then
    select id, order_index into neighbour_id, neighbour_ord from questions
      where order_index < cur order by order_index desc limit 1;
  else
    select id, order_index into neighbour_id, neighbour_ord from questions
      where order_index > cur order by order_index asc limit 1;
  end if;
  if neighbour_id is null then return json_build_object('ok', true); end if;  -- at an edge
  update questions set order_index = neighbour_ord where id = p_id;
  update questions set order_index = cur where id = neighbour_id;
  return json_build_object('ok', true);
end $$;

-- ----- TOGGLE PLAYER QUESTION DISPLAY (Admin, §#4) --------------------------
create or replace function set_show_questions(p_show boolean)
returns json language plpgsql security definer set search_path = public as $$
begin
  update game_control set show_questions_to_players = p_show, updated_at = now() where id;
  return json_build_object('ok', true, 'show', p_show);
end $$;

-- ----- REVISE A QUESTION'S TIMER MID-GAME (Admin, gated on pause) ------------
create or replace function set_question_timer(p_question uuid, p_limit int)
returns json language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from game_control where id;
  if st = 'running' then
    return json_build_object('ok', false, 'reason', 'pause_first');  -- §#4 gate
  end if;
  if p_limit not in (5,10) then
    return json_build_object('ok', false, 'reason', 'limit_must_be_5_or_10');
  end if;
  update questions set time_limit_seconds = p_limit where id = p_question;
  return json_build_object('ok', true);
end $$;

-- ----- PUBLIC CONFIG (login screen needs only the domain) -------------------
create or replace function get_public_config()
returns json language sql security definer set search_path = public as $$
  select json_build_object('login_domain', login_domain) from app_config where id;
$$;

-- ----- LOGIN (server-side password gate; passwords never leave the DB) -------
-- role: 'admin' | 'gm' | 'player'. For 'player', p_name is the team display name;
-- we bind the login to the next free team row (Model A: one login per team).
-- Returns identity the client stores; on wrong password returns ok=false.
create or replace function login(p_role text, p_password text, p_name text default null)
returns json language plpgsql security definer set search_path = public as $$
declare cfg app_config%rowtype; tm teams%rowtype;
begin
  select * into cfg from app_config where id;
  if p_role = 'admin' then
    if p_password <> cfg.admin_password then
      return json_build_object('ok', false, 'reason', 'bad_password'); end if;
    return json_build_object('ok', true, 'role', 'admin', 'email', cfg.admin_email);
  elsif p_role = 'gm' then
    if p_password <> cfg.gm_password then
      return json_build_object('ok', false, 'reason', 'bad_password'); end if;
    return json_build_object('ok', true, 'role', 'gm', 'email', cfg.gm_email);
  elsif p_role = 'player' then
    if p_password <> cfg.player_password then
      return json_build_object('ok', false, 'reason', 'bad_password'); end if;
    -- claim the lowest-numbered team without a display name yet
    select * into tm from teams where display_name is null
      order by team_number for update skip locked limit 1;
    if tm.id is null then
      return json_build_object('ok', false, 'reason', 'no_free_team'); end if;
    update teams set display_name = coalesce(nullif(trim(p_name),''), 'Team '||team_number)
      where id = tm.id;
    return json_build_object('ok', true, 'role', 'player',
      'team_id', tm.id, 'team_number', tm.team_number,
      'email', 'team'||tm.team_number||'@'||cfg.login_domain);
  end if;
  return json_build_object('ok', false, 'reason', 'unknown_role');
end $$;

-- ============================================================================
-- ROW LEVEL SECURITY
--   Everything below runs under the publishable/anon key. Players must NOT be
--   able to read rankings, other teams' buzzes, or scores (spec §7). They read
--   only: config (domain), their own team row, the current question (if shown),
--   and the public parts of game_control. All writes go through the RPCs above.
-- ============================================================================
alter table app_config    enable row level security;
alter table teams         enable row level security;
alter table questions     enable row level security;
alter table game_control  enable row level security;
alter table buzzes        enable row level security;
alter table marks         enable row level security;

-- config: NO direct client read (it holds the role passwords). Clients reach
-- only the domain via get_public_config(), and log in via login() — both RPCs.
-- (No select policy = deny-all select under RLS.)

-- teams: a client may read team rows (needed to resolve login->team + show
-- "N passes left"). Buzz/score data is NOT here, so this leaks nothing sensitive.
create policy teams_read on teams for select using (true);

-- questions: readable. (Text only; base_points/L are not competitive intel.)
-- The "hide from players" toggle is enforced in the client + game_control flag;
-- if you want it DB-enforced too, gate this select on show_questions_to_players.
create policy q_read on questions for select using (true);

-- game_control: readable (drives every client's phase/timer). Writes via RPC only.
create policy gc_read on game_control for select using (true);

-- buzzes + marks: NO direct client read. Rankings/scores reach GM & Admin only
-- through SECURITY DEFINER RPCs / the service role, never raw to a player device.
-- (No select policy = deny-all select under RLS.)

-- ----------------------------------------------------------------------------
-- Realtime: publish game_control so clients get phase/timer/question pushes.
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table game_control;

-- ============================================================================
-- SEED DATA  —  LABELLED PLACEHOLDERS ONLY. Replace before the real event.
--   Segments/timers mirror the source-doc structure (spec §9) so the shape is
--   right; the TEXT is filler and must not be used as final content.
-- ============================================================================
insert into questions (question_text, base_points, time_limit_seconds, segment_name, order_index, is_placeholder) values
  ('[PLACEHOLDER] Ops Basics Q1 — replace me',            8,  10, 'Operations Basics',   1, true),
  ('[PLACEHOLDER] Ops Basics Q2 — replace me',            8,  10, 'Operations Basics',   2, true),
  ('[PLACEHOLDER] Ops Basics Q3 — replace me',            8,  10, 'Operations Basics',   3, true),
  ('[PLACEHOLDER] 5-Second Challenge Q1 — replace me',   12,   5, '5-Second Challenge',  4, true),
  ('[PLACEHOLDER] 5-Second Challenge Q2 — replace me',   12,   5, '5-Second Challenge',  5, true),
  ('[PLACEHOLDER] Identify the Concept Q1 — replace me', 12,  10, 'Identify the Concept',6, true),
  ('[PLACEHOLDER] Identify the Concept Q2 — replace me', 12,  10, 'Identify the Concept',7, true),
  ('[PLACEHOLDER] Picture/Clue Q1 — replace me',         12,  10, 'Picture / Clue',      8, true),
  ('[PLACEHOLDER] Final Buzzer Q1 — replace me',         14,   5, 'Final Buzzer',        9, true),
  ('[PLACEHOLDER] Final Buzzer Q2 — replace me',         14,   5, 'Final Buzzer',       10, true);

-- Example teams (adjust count to your real 15). One login per team (Model A).
insert into teams (team_number, login_email) values
  (1,'team1@ops.ibsb.gg'),(2,'team2@ops.ibsb.gg'),(3,'team3@ops.ibsb.gg'),
  (4,'team4@ops.ibsb.gg'),(5,'team5@ops.ibsb.gg');

-- ============================================================================
-- DONE. Expect green Success. Next: set your real role passwords with —
--   update app_config set admin_password='…', gm_password='…', player_password='…' where id;
-- ============================================================================
