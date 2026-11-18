-- OPS in One Word: ONE ROW PER TEAM PER QUESTION (flat export for a scoring calculator)
-- Supabase > SQL Editor > paste > Run > "Download CSV" under the results.  READ-ONLY, safe any time.
-- Run it BEFORE "Restart game" (restart deletes all buzzes and marks).
with pos as (   -- where the game currently is, so we can tell played from never-reached questions
  select
    coalesce((select r.round_number from game_control g join questions q on q.id = g.current_question_id
                join rounds r on r.id = q.round_id where g.id),
             (select r.round_number from game_control g join rounds r on r.id = g.current_round_id where g.id), 0) as p_round,
    coalesce((select q.order_index from game_control g join questions q on q.id = g.current_question_id where g.id),
             case when (select current_round_id from game_control where id) is not null then 1000000 else 0 end) as p_ord
),
bz as (
  select b.*, case when b.action_type = 'buzz'
           then row_number() over (partition by b.question_id, b.action_type
                                   order by b.client_reaction_time, b.server_seq) end as buzz_rank
  from buzzes b
)
select
  t.team_number,
  coalesce(t.display_name, 'Team ' || t.team_number)                  as team_name,
  r.round_number,
  q.order_index,
  q.id                                                                 as question_id,
  q.segment_name,
  q.base_points,
  q.time_limit_seconds,
  case when t.eliminated_in_round is not null and r.round_number > t.eliminated_in_round
       then false else true end                                        as team_in_game,        -- false = already eliminated, did not face it
  ((exists (select 1 from buzzes x where x.question_id = q.id) or exists (select 1 from marks x where x.question_id = q.id)
    or (r.round_number, q.order_index) <= ((select p_round from pos), (select p_ord from pos))))        as question_played,
  coalesce(bz.action_type, 'none')                                     as action,               -- buzz | pass | none
  bz.client_reaction_time                                              as buzz_time_s,          -- server-measured seconds since start
  bz.buzz_rank,                                                                                 -- 1 = fastest buzzer on this question
  case when m.id is not null then (case when m.is_correct then 'correct' else 'wrong' end)
       when bz.action_type = 'buzz' then 'buzzed_not_called'
       when bz.action_type = 'pass' then 'passed'
       else 'no_response' end                                          as outcome,
  coalesce(m.points_awarded, 0)                                        as points_awarded,
  t.passes_remaining,
  t.eliminated,
  t.eliminated_in_round
from teams t
cross join questions q
join rounds r on r.id = q.round_id
left join bz on bz.question_id = q.id and bz.team_id = t.id
left join marks m on m.question_id = q.id and m.team_id = t.id
where t.display_name is not null
order by t.team_number, r.round_number, q.order_index;
