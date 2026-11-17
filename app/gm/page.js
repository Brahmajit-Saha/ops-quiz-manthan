'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, rpc } from '../../lib/supabaseClient';

const rl = r => (r ? `Round ${r.round_number}${r.name ? ' \u00b7 ' + r.name : ''}` : '');

export default function GameMaster() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [ctrl, setCtrl] = useState(null);
  const [questions, setQuestions] = useState([]);   // whole bank, in PLAY order (round, then question)
  const [rounds, setRounds] = useState([]);
  const [currentQ, setCurrentQ] = useState(null);
  const [ranking, setRanking] = useState([]);
  const [now, setNow] = useState(Date.now());
  const closedFor = useRef(null);                    // qid we've already auto-closed

  useEffect(() => {
    const raw = typeof window !== 'undefined' && localStorage.getItem('ops_identity');
    if (!raw) { router.replace('/'); return; }
    if (JSON.parse(raw).role !== 'gm') { router.replace('/'); return; }
    setOk(true);
    loadBank();
  }, [router]);

  // Fetch rounds + questions and put questions in play order. Returns the ordered list.
  async function loadBank() {
    const [r, q] = await Promise.all([
      supabase.from('rounds').select('*').order('round_number'),
      supabase.from('questions').select('*').order('order_index'),
    ]);
    if (r.error || q.error) return questions;
    const rs = r.data || [];
    const ordered = rs.flatMap(rd => (q.data || []).filter(x => x.round_id === rd.id));
    setRounds(rs); setQuestions(ordered);
    return ordered;
  }

  // On the "round complete" screen, keep checking whether the Admin has confirmed eliminations.
  useEffect(() => {
    if (ctrl?.round_state !== 'between') return;
    const t = setInterval(loadBank, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl?.round_state]);

  useEffect(() => {
    if (!ok) return;
    let active = true;
    async function pull() {
      const { data } = await supabase.from('game_control').select('*').eq('id', true).single();
      if (active && data) applyCtrl(data);
    }
    pull();
    const ch = supabase.channel('gc-gm')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_control' },
        p => applyCtrl(p.new)).subscribe();
    return () => { active = false; supabase.removeChannel(ch); };
  }, [ok]);

  async function applyCtrl(gc) {
    setCtrl(gc);
    if (gc.current_question_id) {
      const { data } = await supabase.from('questions').select('*')
        .eq('id', gc.current_question_id).single();
      setCurrentQ(data || null);
    } else { setCurrentQ(null); }
    if (gc.question_phase === 'buzzing_closed' && gc.current_question_id) {
      const res = await rpc('get_ranking', { p_question: gc.current_question_id });
      setRanking(res?.ranking || []);
    }
    if (gc.question_phase !== 'buzzing_closed') setRanking([]);
  }

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 80); return () => clearInterval(t); }, []);

  const startedMs = ctrl?.question_started_at ? Date.parse(ctrl.question_started_at) : null;
  const L = currentQ?.time_limit_seconds ?? 10;
  const remaining = startedMs ? Math.max(0, L - (now - startedMs) / 1000) : L;

  // auto-close when the window elapses (server already rejects late buzzes)
  useEffect(() => {
    if (ctrl?.question_phase === 'open' && remaining <= 0 && closedFor.current !== ctrl.current_question_id) {
      closedFor.current = ctrl.current_question_id;
      rpc('close_buzzing', { p_question: ctrl.current_question_id }).catch(() => {});
    }
  }, [remaining, ctrl]);

  if (!ok) return null;

  const idx = questions.findIndex(q => q.id === ctrl?.current_question_id);
  const curRound = rounds.find(r => r.id === (currentQ?.round_id ?? ctrl?.current_round_id));
  const inRound = curRound ? questions.filter(q => q.round_id === curRound.id) : [];
  const qNum = currentQ ? inRound.findIndex(q => q.id === currentQ.id) + 1 : null;   // number within the round
  const total = inRound.length;
  const phase = ctrl?.question_phase;
  const between = ctrl?.round_state === 'between' && ctrl?.status !== 'finished';
  const nextRound = curRound ? rounds.find(r => r.round_number > curRound.round_number && questions.some(q => q.round_id === r.id)) : null;
  const waitingForAdmin = !!(curRound?.eliminate_enabled && !curRound?.eliminations_applied);

  async function loadFirst() {
    const bank = await loadBank();
    if (!bank.length) return;
    await rpc('set_status', { p_status: 'running' });
    await rpc('set_current_question', { p_question: bank[0].id });
  }
  async function startNextRound() {
    const res = await rpc('start_next_round');
    if (res && res.ok === false) alert('Cannot start yet: ' + String(res.reason).replace(/_/g, ' '));
  }
  async function startQ() {
    closedFor.current = null;
    await rpc('start_question', { p_question: ctrl.current_question_id });
  }
  async function mark(team, correct) {
    await rpc('mark_attempt', { p_question: ctrl.current_question_id, p_team: team, p_correct: correct });
  }
  async function undo(team) {
    await rpc('undo_mark', { p_question: ctrl.current_question_id, p_team: team });
  }
  async function next() {
    const nextQ = idx >= 0 ? questions[idx + 1] : null;
    if (nextQ && nextQ.round_id === currentQ?.round_id) await rpc('set_current_question', { p_question: nextQ.id });
    else await rpc('end_round');                       // last question of this round
  }

  return (
    <div className="stage">
      <div className="brandbar">
        <span className="brand"><span className="dot" /> Game Master</span>
        <span>{qNum ? `${rl(curRound)} \u00b7 Question ${qNum} of ${total}` : ctrl?.status === 'finished' ? 'Game complete' : between ? `${rl(curRound)} complete` : 'Ready to start'}</span>
      </div>

      {/* NO CURRENT QUESTION */}
      {!ctrl?.current_question_id && !between && ctrl?.status !== 'finished' && (
        <Center>
          <h1 className="display" style={{ fontSize: 'clamp(28px,4vw,52px)' }}>OPS in One Word</h1>
          <p style={{ color: 'var(--muted)', margin: '10px 0 26px' }}>{rounds.length} round{rounds.length === 1 ? '' : 's'} · {questions.length} questions loaded</p>
          <button className="btn btn-amber" style={{ fontSize: 22, padding: '18px 34px' }}
            onClick={loadFirst} disabled={!questions.length}>Load first question</button>
        </Center>
      )}

      {ctrl?.status === 'finished' && (
        <Center><h1 className="display" style={{ fontSize: 'clamp(30px,5vw,64px)' }}>That&rsquo;s a wrap</h1>
          <p style={{ color: 'var(--muted)', marginTop: 12 }}>Final scores are on the Admin screen.</p></Center>
      )}

      {/* ROUND COMPLETE */}
      {between && (
        <Center>
          <div className="display" style={{ fontSize: 'clamp(30px,5vw,64px)' }}>{rl(curRound)} complete</div>
          {waitingForAdmin ? (
            <p style={{ color: 'var(--muted)', margin: '14px 0 0', fontSize: 20 }}>
              Waiting for the Admin to confirm eliminations&hellip;
            </p>
          ) : (
            <p style={{ color: 'var(--muted)', margin: '14px 0 0', fontSize: 18 }}>
              {curRound?.eliminate_enabled ? 'Eliminations confirmed.' : 'No elimination this round.'}
            </p>
          )}
          {nextRound ? (
            <button className="btn btn-go" style={{ marginTop: 26, fontSize: 24, padding: '18px 40px' }}
              onClick={startNextRound} disabled={waitingForAdmin}>
              Start {rl(nextRound)} &rarr;
            </button>
          ) : (
            <button className="btn btn-amber" style={{ marginTop: 26, fontSize: 24, padding: '18px 40px' }}
              onClick={() => rpc('set_status', { p_status: 'finished' })} disabled={waitingForAdmin}>
              Finish game
            </button>
          )}
        </Center>
      )}

      {/* READY (room sees number only) */}
      {phase === 'idle' && ctrl?.current_question_id && (
        <Center>
          <div style={{ color: 'var(--muted)', fontSize: 20 }}>{currentQ?.segment_name}</div>
          <div style={{ color: 'var(--muted)', fontSize: 18 }}>{rl(curRound)}</div>
          <div className="display" style={{ fontSize: 'clamp(40px,8vw,96px)', margin: '6px 0 4px' }}>Question {qNum}</div>
          <div style={{ color: 'var(--muted)', marginBottom: 30 }}>
            {currentQ?.time_limit_seconds}s to buzz · up to {currentQ?.base_points} pts
          </div>
          <button className="btn btn-go" style={{ fontSize: 26, padding: '20px 44px' }} onClick={startQ}>
            Start question
          </button>
        </Center>
      )}

      {/* OPEN — room mode: giant question + timer */}
      {phase === 'open' && (
        <div className="grow" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '4vh' }}>
          <div className="mono center" style={{
            fontSize: 'clamp(88px,15vw,220px)', fontWeight: 700, lineHeight: 1,
            color: remaining < 3 ? 'var(--bad)' : 'var(--cyan)'
          }}>{remaining.toFixed(1)}</div>
          <div className="center" style={{ fontSize: 'clamp(26px,4vw,56px)', lineHeight: 1.3, maxWidth: 1100, margin: '0 auto' }}>
            {currentQ?.question_text}
          </div>
        </div>
      )}

      {/* BUZZING CLOSED — operate mode: ranked top 3 + mark */}
      {phase === 'buzzing_closed' && (
        <div className="grow" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16, maxWidth: 820, margin: '0 auto', width: '100%' }}>
          <div className="center" style={{ color: 'var(--muted)', fontSize: 20 }}>Buzzing closed — call the teams in order</div>
          {ranking.length === 0 && (
            <div className="panel center" style={{ padding: 30 }}>
              <div className="display" style={{ fontSize: 26 }}>No one buzzed</div>
              <button className="btn btn-amber" style={{ marginTop: 18, fontSize: 20, padding: '14px 30px' }} onClick={next}>{questions[idx + 1]?.round_id === currentQ?.round_id ? 'Next question \u2192' : 'Finish round'}</button>
            </div>
          )}
          {ranking.map(r => {
            const isUp = r.rank === ctrl.current_attempt_rank;
            return (
              <div key={r.team_id} className="panel" style={{
                display: 'flex', alignItems: 'center', gap: 18, padding: 18,
                borderColor: isUp ? 'var(--amber)' : 'var(--line)',
                borderWidth: isUp ? 2 : 1, background: isUp ? 'var(--panel-2)' : 'var(--panel)',
                opacity: r.rank < ctrl.current_attempt_rank ? 0.55 : 1
              }}>
                <div className="mono" style={{ fontSize: 34, width: 42, color: 'var(--amber)' }}>{r.rank}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: isUp ? 30 : 22, fontWeight: 600 }}>
                    {r.team_name}
                    {r.suspect && <span title="Timing looks off — check this buzz" style={{ color: 'var(--stop)', fontSize: 15, marginLeft: 10 }}>&#9888; check</span>}
                  </div>
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: 15 }}>buzzed at {Number(r.client_reaction_time).toFixed(2)}s</div>
                </div>
                {isUp ? (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-go" style={{ fontSize: 20, padding: '14px 22px' }} onClick={() => mark(r.team_id, true)}>&#10003; Correct</button>
                    <button className="btn btn-stop" style={{ fontSize: 20, padding: '14px 22px' }} onClick={() => mark(r.team_id, false)}>&#10007; Wrong</button>
                  </div>
                ) : r.rank < ctrl.current_attempt_rank ? (
                  <button className="btn" onClick={() => undo(r.team_id)}>Undo</button>
                ) : <span style={{ color: 'var(--muted)' }}>waiting</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* RESOLVED / VOIDED */}
      {(phase === 'resolved' || phase === 'voided') && (
        <Center>
          <div className="display" style={{ fontSize: 'clamp(30px,5vw,60px)' }}>
            {phase === 'voided' ? 'Question voided' : 'Answered'}
          </div>
          <button className="btn btn-amber" style={{ marginTop: 26, fontSize: 24, padding: '18px 40px' }} onClick={next}>
            {questions[idx + 1]?.round_id === currentQ?.round_id ? 'Next question \u2192' : 'Finish round'}
          </button>
        </Center>
      )}
    </div>
  );
}

function Center({ children }) {
  return <div className="grow center" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>{children}</div>;
}
