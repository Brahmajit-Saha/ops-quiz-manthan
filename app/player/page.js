'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, rpc } from '../../lib/supabaseClient';

export default function Player() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [ctrl, setCtrl] = useState(null);        // game_control row
  const [question, setQuestion] = useState(null); // current question row
  const [passesLeft, setPassesLeft] = useState(3);
  const [acted, setActed] = useState(null);       // {type:'buzz'|'pass', t?} for current Q
  const [now, setNow] = useState(Date.now());
  const actedForQ = useRef(null);                 // question_id we've already acted on

  // --- identity ---
  useEffect(() => {
    const raw = typeof window !== 'undefined' && localStorage.getItem('ops_identity');
    if (!raw) { router.replace('/'); return; }
    const id = JSON.parse(raw);
    if (id.role !== 'player') { router.replace('/'); return; }
    setMe(id);
    supabase.from('teams').select('passes_remaining').eq('id', id.team_id).single()
      .then(({ data }) => data && setPassesLeft(data.passes_remaining));
  }, [router]);

  // --- live game_control ---
  useEffect(() => {
    let active = true;
    async function pull() {
      const { data } = await supabase.from('game_control').select('*').eq('id', true).single();
      if (active && data) applyCtrl(data);
    }
    pull();
    const ch = supabase.channel('gc-player')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_control' },
        payload => applyCtrl(payload.new))
      .subscribe();
    return () => { active = false; supabase.removeChannel(ch); };
  }, []);

  async function applyCtrl(gc) {
    setCtrl(gc);
    // new question? reset our per-question action state and fetch text
    if (gc.current_question_id && gc.current_question_id !== actedForQ.current?.qid) {
      actedForQ.current = { qid: gc.current_question_id };
      setActed(null);
    }
    if (gc.current_question_id) {
      const { data } = await supabase.from('questions')
        .select('id, question_text, time_limit_seconds, base_points')
        .eq('id', gc.current_question_id).single();
      setQuestion(data || null);
    } else {
      setQuestion(null);
    }
  }

  // --- display-only ticker (buzz uses precise Date.now(), not this) ---
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(t);
  }, []);

  const startedMs = ctrl?.question_started_at ? Date.parse(ctrl.question_started_at) : null;
  const L = question?.time_limit_seconds ?? 10;
  const remaining = startedMs ? Math.max(0, L - (now - startedMs) / 1000) : L;
  const windowOpen = ctrl?.question_phase === 'open' && remaining > 0;
  const showText = ctrl?.show_questions_to_players !== false;

  async function buzz() {
    if (!windowOpen || acted) return;
    const t = Math.max(0, (Date.now() - startedMs) / 1000);
    setActed({ type: 'buzz', t });                 // optimistic lock
    try {
      const res = await rpc('submit_buzz', { p_team: me.team_id, p_question: question.id, p_client_t: t });
      if (!res?.ok && res?.reason === 'window_closed') setActed({ type: 'late' });
      else if (res?.ok && res.reaction_time != null) setActed({ type: 'buzz', t: Number(res.reaction_time) }); // show the server-measured time
    } catch { /* keep optimistic lock; server is source of truth */ }
  }

  async function pass() {
    if (!windowOpen || acted || passesLeft <= 0) return;
    setActed({ type: 'pass' });
    try {
      const res = await rpc('submit_pass', { p_team: me.team_id, p_question: question.id });
      if (res?.ok) setPassesLeft(res.passes_remaining);
      else if (res?.reason === 'window_closed') setActed({ type: 'late' });
      else if (res?.reason === 'no_passes_left') { setPassesLeft(0); setActed(null); }
    } catch { /* keep optimistic */ }
  }

  if (!me) return null;

  // ---------- render states ----------
  const waiting = !ctrl?.current_question_id || ctrl?.question_phase === 'idle' || ctrl?.status === 'setup';
  const closed = ctrl?.question_phase && ['buzzing_closed','resolved','voided'].includes(ctrl.question_phase);

  return (
    <div className="screen">
      <div className="brandbar">
        <span className="brand"><span className="dot" /> Team {me.team_number}</span>
        <span>{me.email}</span>
      </div>

      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center' }}>
        {waiting && (
          <div className="panel center" style={{ padding: 34 }}>
            <div className="display" style={{ fontSize: 22 }}>Get ready</div>
            <p style={{ color: 'var(--muted)', marginTop: 8 }}>Waiting for the next question&hellip;</p>
          </div>
        )}

        {!waiting && (
          <>
            {/* question */}
            <div className="panel">
              <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
                {question?.segment_name || 'Question'} · worth up to {question?.base_points ?? '?'} × time left
              </div>
              <div style={{ fontSize: showText ? 22 : 18, lineHeight: 1.35 }}>
                {showText ? (question?.question_text || '\u2026')
                          : 'Read the question on the main screen \u2192'}
              </div>
            </div>

            {/* timer */}
            <div className="center">
              <div className="mono" style={{
                fontSize: 68, fontWeight: 700,
                color: windowOpen ? (remaining < 3 ? 'var(--bad)' : 'var(--cyan)') : 'var(--muted)'
              }}>
                {remaining.toFixed(1)}s
              </div>
            </div>

            {/* action zone */}
            {windowOpen && !acted && (
              <>
                <button className="btn btn-block" onClick={buzz}
                  style={{ background: 'var(--buzz)', color: '#fff', border: 'none',
                           fontSize: 30, fontWeight: 700, padding: '34px 0',
                           boxShadow: '0 10px 0 var(--buzz-dk)' }}>
                  BUZZ
                </button>
                <button className="btn btn-block" onClick={pass} disabled={passesLeft <= 0}>
                  Use a PASS &nbsp;
                  <span aria-hidden>{'\u25CF'.repeat(passesLeft)}{'\u25CB'.repeat(Math.max(0,3-passesLeft))}</span>
                  &nbsp;({passesLeft} left)
                </button>
              </>
            )}

            {acted?.type === 'buzz' && (
              <div className="panel center" style={{ borderColor: 'var(--buzz)' }}>
                <div className="display" style={{ fontSize: 24, color: 'var(--buzz)' }}>Buzzed!</div>
                <p style={{ color: 'var(--muted)', marginTop: 6 }}>
                  Your time: <b className="mono" style={{ color: 'var(--text)' }}>{acted.t.toFixed(2)}s</b>. Listen for your team name.
                </p>
              </div>
            )}
            {acted?.type === 'pass' && (
              <div className="panel center">
                <div className="display" style={{ fontSize: 22 }}>Passed</div>
                <p style={{ color: 'var(--muted)', marginTop: 6 }}>{passesLeft} PASS card{passesLeft===1?'':'s'} left.</p>
              </div>
            )}
            {acted?.type === 'late' && (
              <div className="panel center"><p style={{ color: 'var(--muted)' }}>Time was up before that registered.</p></div>
            )}

            {closed && !acted && (
              <div className="panel center"><p style={{ color: 'var(--muted)' }}>Buzzing closed. Sit tight for the next one.</p></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
