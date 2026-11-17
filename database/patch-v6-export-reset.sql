-- ============================================================================
-- Patch v6: FRESH SCORECARD ON RESTART + EXCEL EXPORT DATA
-- Run ONCE in the Supabase SQL Editor (after patch v4/v5).
--
--   1. Restart game now also clears the team sign-ins, so the live scorecard
--      starts completely empty. Teams sign in again (phones sign themselves out).
--   2. get_export_data(): everything the admin "Export Excel" button needs.
-- ============================================================================

create or replace function restart_game()
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from marks  where true;
  delete from buzzes where true;
  update teams  set passes_remaining = 3, eliminated = false, eliminated_in_round = null,
                    display_name = null where true;                -- fresh scorecard
  update rounds set eliminations_applied = false where true;
  update game_control set status = 'setup', current_question_id = null, current_round_id = null,
    round_state = 'playing', question_phase = 'idle', question_started_at = null,
    current_attempt_rank = 0, updated_at = now() where id;
  return json_build_object('ok', true);
end $$;

create or replace function get_export_data()
returns json language sql security definer set search_path = public as $$
  select json_build_object(
    'exported_at', now(),
    'status', (select status from game_control where id),
    'current_question_id', (select current_question_id from game_control where id),
    'current_round_id',     (select current_round_id from game_control where id),
    'round_state',          (select round_state from game_control where id),
    'question_phase',       (select question_phase from game_control where id),
    'rounds', (select coalesce(json_agg(row_to_json(r) order by r.round_number), '[]'::json) from (
                 select id, round_number, name, eliminate_enabled, eliminate_count, eliminations_applied
                 from rounds) r),
    'questions', (select coalesce(json_agg(row_to_json(q) order by q.order_index), '[]'::json) from (
                 select id, round_id, order_index, question_text, base_points, time_limit_seconds, segment_name
                 from questions) q),
    'teams', (select coalesce(json_agg(row_to_json(t) order by t.team_number), '[]'::json) from (
                 select id, team_number, display_name, passes_remaining, eliminated, eliminated_in_round
                 from teams where display_name is not null) t),
    'buzzes', (select coalesce(json_agg(row_to_json(b)), '[]'::json) from (
                 select question_id, team_id, action_type, client_reaction_time from buzzes) b),
    'marks', (select coalesce(json_agg(row_to_json(m)), '[]'::json) from (
                 select question_id, team_id, is_correct, points_awarded from marks) m)
  );
$$;
