-- ============================================================================
-- OPS in One Word — PATCH v2: server-measured reaction time
--
-- Run this ONCE in the Supabase SQL Editor on a project that is ALREADY set up.
-- It replaces ONE function (submit_buzz). It does NOT delete any teams,
-- questions, scores or passwords, so it is safe to run any time.
--
-- What changes: reaction time t = (server arrival time - question start time),
-- measured on the server clock. The time sent by the phone is ignored, so a
-- phone with a wrong clock can no longer gain or lose an advantage.
-- ============================================================================

create or replace function submit_buzz(p_team uuid, p_question uuid, p_client_t numeric)
returns json language plpgsql security definer set search_path = public as $$
declare row_id uuid; started timestamptz; t numeric;
begin
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
