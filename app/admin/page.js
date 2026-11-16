'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, rpc } from '../../lib/supabaseClient';

export default function Admin() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [ctrl, setCtrl] = useState(null);
  const [board, setBoard] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [draft, setDraft] = useState({ text: '', base: 10, limit: 10, segment: '' });
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    const raw = typeof window !== 'undefined' && localStorage.getItem('ops_identity');
    if (!raw) { router.replace('/'); return; }
    if (JSON.parse(raw).role !== 'admin') { router.replace('/'); return; }
    setOk(true);
  }, [router]);

  const loadQuestions = useCallback(async () => {
    const { data } = await supabase.from('questions').select('*').order('order_index');
    setQuestions(data || []);
  }, []);
  const loadBoard = useCallback(async () => {
    try { setBoard(await rpc('get_scoreboard')); } catch {}
  }, []);

  useEffect(() => {
    if (!ok) return;
    loadQuestions(); loadBoard();
    supabase.from('game_control').select('*').eq('id', true).single().then(({ data }) => setCtrl(data));
    const ch = supabase.channel('gc-admin')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_control' },
        p => { setCtrl(p.new); loadBoard(); }).subscribe();
    const poll = setInterval(() => { loadBoard(); loadQuestions(); }, 3000);       // scores aren't realtime-pushed; poll
    return () => { supabase.removeChannel(ch); clearInterval(poll); };
  }, [ok, loadQuestions, loadBoard]);

  if (!ok) return null;

  const running = ctrl?.status === 'running';
  const idx = questions.findIndex(q => q.id === ctrl?.current_question_id);
  const qNum = idx >= 0 ? idx + 1 : null;

  async function toggleStatus() { await rpc('set_status', { p_status: running ? 'paused' : 'running' }); }
  async function toggleShow() { await rpc('set_show_questions', { p_show: !(ctrl?.show_questions_to_players !== false) }); }
  async function resetQ() {
    if (!ctrl?.current_question_id) return;
    if (confirm('Clear buzzes + marks for the CURRENT question and re-open it? Other questions keep their scores.'))
      await rpc('reset_round', { p_question: ctrl.current_question_id });
  }
  async function voidQ() {
    if (!ctrl?.current_question_id) return;
    if (confirm('Void the current question? Nobody scores it.'))
      await rpc('void_question', { p_question: ctrl.current_question_id });
  }
  async function restart() {
    if (confirm('RESTART THE WHOLE GAME? Wipes every score and sends it back to question 1. Cannot be undone.'))
      { await rpc('restart_game'); loadBoard(); }
  }

  async function saveDraft() {
    if (!draft.text.trim()) return;
    try {
      const res = editing
        ? await rpc('update_question', { p_id: editing, p_text: draft.text, p_base: +draft.base, p_limit: +draft.limit, p_segment: draft.segment })
        : await rpc('add_question', { p_text: draft.text, p_base: +draft.base, p_limit: +draft.limit, p_segment: draft.segment });
      if (res && res.ok === false) { alert('Could not save: ' + (res.reason || 'unknown error')); return; }
    } catch (e) { alert('Could not save the question: ' + (e.message || e)); return; }
    setDraft({ text: '', base: 10, limit: 10, segment: '' }); setEditing(null);
    await loadQuestions();
  }
  function editRow(q) { setEditing(q.id); setDraft({ text: q.question_text, base: q.base_points, limit: q.time_limit_seconds, segment: q.segment_name || '' }); }
  async function delRow(q) { if (confirm('Delete this question?')) { try { await rpc('delete_question', { p_id: q.id }); } catch (e) { alert('Could not delete: ' + (e.message || e)); } await loadQuestions(); } }
  async function move(q, dir) { try { await rpc('move_question', { p_id: q.id, p_dir: dir }); } catch (e) { alert('Could not move: ' + (e.message || e)); } await loadQuestions(); }

  const showingQ = ctrl?.show_questions_to_players !== false;

  return (
    <div className="stage" style={{ maxWidth: 1000, margin: '0 auto', width: '100%' }}>
      <div className="brandbar">
        <span className="brand"><span className="dot" /> Admin control</span>
        <span>
          <b style={{ color: running ? 'var(--go)' : 'var(--amber)' }}>{ctrl?.status || '\u2026'}</b>
          {qNum ? ` · Q${qNum}/${questions.length} · ${ctrl?.question_phase}` : ''}
        </span>
      </div>

      {/* CONTROLS */}
      <div className="panel admin-controls">
        <button className={'btn ' + (running ? 'btn-stop' : 'btn-go')} onClick={toggleStatus}>
          {running ? 'Pause game' : 'Resume game'}
        </button>
        <button className="btn" onClick={toggleShow}>
          {showingQ ? 'Hide questions from players' : 'Show questions to players'}
        </button>
        <button className="btn" onClick={resetQ} disabled={!ctrl?.current_question_id}>Reset current question</button>
        <button className="btn" onClick={voidQ} disabled={!ctrl?.current_question_id}>Void current question</button>
        <button className="btn btn-stop" onClick={restart} style={{ marginLeft: 'auto' }}>Restart game</button>
      </div>

      <div className="admin-grid">
        {/* SCOREBOARD */}
        <div className="panel">
          <h2 className="display" style={{ fontSize: 20, marginBottom: 12 }}>Live scorecard</h2>
          {board.length === 0 && <p style={{ color: 'var(--muted)' }}>No teams have joined yet.</p>}
          {board.map((t, i) => (
            <div key={t.team_number} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="mono" style={{ width: 26, color: 'var(--muted)' }}>{i + 1}</span>
              <span style={{ flex: 1, fontWeight: 500 }}>{t.team_name}</span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>{t.passes_remaining} pass</span>
              <span className="mono" style={{ fontSize: 20, width: 60, textAlign: 'right', color: t.total < 0 ? 'var(--stop)' : 'var(--text)' }}>{t.total}</span>
            </div>
          ))}
        </div>

        {/* QUESTION EDITOR */}
        <div className="panel">
          <h2 className="display" style={{ fontSize: 20, marginBottom: 4 }}>Questions ({questions.length})</h2>
          {running
            ? <p style={{ color: 'var(--amber)', fontSize: 13, marginBottom: 10 }}>Pause the game to add, edit, or reorder questions.</p>
            : <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 10 }}>Add, edit, and reorder freely. Timer must be 5 or 10.</p>}

          {!running && (
            <div style={{ display: 'grid', gap: 8, marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
              <input className="input" placeholder="Question text" value={draft.text}
                onChange={e => setDraft({ ...draft, text: e.target.value })} />
              <div className="qform-row">
                <input className="input" type="number" style={{ width: 90 }} value={draft.base}
                  onChange={e => setDraft({ ...draft, base: e.target.value })} title="Base points" />
                <select className="input" style={{ width: 90 }} value={draft.limit}
                  onChange={e => setDraft({ ...draft, limit: e.target.value })}>
                  <option value={5}>5s</option><option value={10}>10s</option>
                </select>
                <input className="input" placeholder="Segment" value={draft.segment}
                  onChange={e => setDraft({ ...draft, segment: e.target.value })} />
              </div>
              <button className="btn btn-amber" onClick={saveDraft}>{editing ? 'Save changes' : 'Add question'}</button>
              {editing && <button className="btn" onClick={() => { setEditing(null); setDraft({ text: '', base: 10, limit: 10, segment: '' }); }}>Cancel edit</button>}
            </div>
          )}

          <div className="qlist">
            {questions.map((q, i) => (
              <div key={q.id} className="qrow">
                <span className="mono" style={{ width: 22, color: 'var(--muted)', fontSize: 14 }}>{i + 1}</span>
                <div className="qtext">
                  <div className="qtitle">
                    {q.is_placeholder && <span style={{ color: 'var(--amber)' }}>[placeholder] </span>}{q.question_text}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>{q.segment_name} · {q.time_limit_seconds}s · {q.base_points}pts</div>
                </div>
                {!running && <div className="qactions">
                  <button className="btn" style={{ padding: '6px 9px' }} onClick={() => move(q, 'up')} disabled={i === 0} aria-label="Move up">&uarr;</button>
                  <button className="btn" style={{ padding: '6px 9px' }} onClick={() => move(q, 'down')} disabled={i === questions.length - 1} aria-label="Move down">&darr;</button>
                  <button className="btn" style={{ padding: '6px 9px' }} onClick={() => editRow(q)}>Edit</button>
                  <button className="btn" style={{ padding: '6px 9px' }} onClick={() => delRow(q)} aria-label="Delete">&times;</button>
                </div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
