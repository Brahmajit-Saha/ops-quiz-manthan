'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, rpc } from '../../lib/supabaseClient';

const EMPTY_Q = { text: '', base: 10, limit: 10, segment: '', round_id: '' };
const EMPTY_R = { name: '', eliminate: false, count: 1 };

// Round label: the number is automatic; the name is only an optional title.
const rl = r => (r ? `Round ${r.round_number}${r.name ? ' \u00b7 ' + r.name : ''}` : '');

// "Could not ..." pop-up for any RPC that returns {ok:false} or throws.
async function call(fn, args) {
  try {
    const res = await rpc(fn, args);
    if (res && res.ok === false) { alert('Could not do that: ' + String(res.reason || 'unknown').replace(/_/g, ' ')); return false; }
    return true;
  } catch (e) { alert('Something went wrong: ' + (e.message || e)); return false; }
}

export default function Admin() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  const [ctrl, setCtrl] = useState(null);
  const [board, setBoard] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [draft, setDraft] = useState(EMPTY_Q);
  const [editing, setEditing] = useState(null);          // question id being edited
  const [rDraft, setRDraft] = useState(EMPTY_R);          // new-round form
  const [editingRound, setEditingRound] = useState(null); // round id being edited
  const [rEdit, setREdit] = useState(EMPTY_R);
  const [loadErr, setLoadErr] = useState('');
  const [teamRows, setTeamRows] = useState([]);
  const [picked, setPicked] = useState(new Set());        // teams ticked for elimination

  useEffect(() => {
    const raw = typeof window !== 'undefined' && localStorage.getItem('ops_identity');
    if (!raw) { router.replace('/'); return; }
    if (JSON.parse(raw).role !== 'admin') { router.replace('/'); return; }
    setOk(true);
  }, [router]);

  const loadQuestions = useCallback(async () => {
    const [q, r, t] = await Promise.all([
      supabase.from('questions').select('*').order('order_index'),
      supabase.from('rounds').select('*').order('round_number'),
      supabase.from('teams').select('id, display_name, eliminated'),
    ]);
    const err = q.error || r.error || t.error;
    if (err) { setLoadErr(err.message || String(err)); return; }   // keep the old list on error
    setLoadErr('');
    setQuestions(q.data || []);
    setRounds(r.data || []);
    setTeamRows(t.data || []);
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
    const poll = setInterval(() => { loadBoard(); loadQuestions(); }, 3000);
    return () => { supabase.removeChannel(ch); clearInterval(poll); };
  }, [ok, loadQuestions, loadBoard]);

  // ----- derived -----
  const running = ctrl?.status === 'running';
  const roundOf = id => rounds.find(r => r.id === id);
  const qsIn = rid => questions.filter(q => q.round_id === rid);
  const curQ = questions.find(q => q.id === ctrl?.current_question_id);
  const curRound = roundOf(ctrl?.current_round_id);
  const posInRound = curQ ? qsIn(curQ.round_id).findIndex(q => q.id === curQ.id) + 1 : null;
  const between = ctrl?.round_state === 'between' && curRound;
  const stillIn = teamRows.filter(t => !t.eliminated);
  const joinedIn = stillIn.filter(t => t.display_name);
  const maxElim = Math.floor((joinedIn.length || stillIn.length) / 2);

  // Elimination helper data: active teams, lowest totals first.
  const active = board.filter(t => !t.eliminated);
  const lowFirst = [...active].sort((a, b) => a.total - b.total || b.team_number - a.team_number);
  const N = curRound?.eliminate_count || 0;
  const tieAtCut = N > 0 && lowFirst.length > N && lowFirst[N - 1].total === lowFirst[N].total;
  const elimKey = between && curRound.eliminate_enabled && !curRound.eliminations_applied
    ? curRound.id + ':' + lowFirst.map(t => t.team_id).join(',') : '';

  // Tick the bottom N automatically when the round-complete screen opens.
  useEffect(() => {
    if (!elimKey) { setPicked(new Set()); return; }
    setPicked(prev => {
      const stillValid = [...prev].filter(id => lowFirst.some(t => t.team_id === id));
      if (stillValid.length === N) return new Set(stillValid);          // keep admin's own choice
      return new Set(lowFirst.slice(0, N).map(t => t.team_id));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elimKey]);

  useEffect(() => {
    if (draft.round_id === '' && rounds.length) setDraft(d => ({ ...d, round_id: rounds[rounds.length - 1].id }));
  }, [rounds, draft.round_id]);

  if (!ok) return null;

  // ----- game controls -----
  async function toggleStatus() { await call('set_status', { p_status: running ? 'paused' : 'running' }); }
  async function toggleShow() { await call('set_show_questions', { p_show: !(ctrl?.show_questions_to_players !== false) }); }
  async function resetQ() {
    if (!ctrl?.current_question_id) return;
    if (confirm('Clear buzzes + marks for the CURRENT question and re-open it? Other questions keep their scores.'))
      await call('reset_round', { p_question: ctrl.current_question_id });
  }
  async function voidQ() {
    if (!ctrl?.current_question_id) return;
    if (confirm('Void the current question? Nobody scores it.'))
      await call('void_question', { p_question: ctrl.current_question_id });
  }
  async function restart() {
    if (confirm('RESTART THE WHOLE GAME? Wipes every score, brings back eliminated teams, and sends it back to round 1, question 1. Cannot be undone.'))
      { await call('restart_game'); loadBoard(); loadQuestions(); }
  }

  // ----- questions -----
  async function saveDraft() {
    if (!draft.text.trim()) return;
    const pts = Number(draft.base);
    if (!Number.isInteger(pts) || pts < 1 || pts > 10) { alert('Base points must be a whole number from 1 to 10.'); return; }
    if (!editing && !draft.round_id) { alert('Add a round first.'); return; }
    const done = editing
      ? await call('update_question', { p_id: editing, p_text: draft.text, p_base: +draft.base, p_limit: +draft.limit, p_segment: draft.segment })
      : await call('add_question', { p_text: draft.text, p_base: +draft.base, p_limit: +draft.limit, p_segment: draft.segment, p_round: draft.round_id });
    if (!done) return;
    setDraft({ ...EMPTY_Q, round_id: draft.round_id }); setEditing(null);
    await loadQuestions();
  }
  function editRow(q) { setEditing(q.id); setDraft({ text: q.question_text, base: q.base_points, limit: q.time_limit_seconds, segment: q.segment_name || '', round_id: q.round_id }); }
  async function delRow(q) { if (confirm('Delete this question?')) { await call('delete_question', { p_id: q.id }); await loadQuestions(); } }
  async function move(q, dir) { await call('move_question', { p_id: q.id, p_dir: dir }); await loadQuestions(); }

  // ----- rounds -----
  function elimProblem(v) {
    if (!v.eliminate) return '';
    const c = Number(v.count);
    if (!Number.isInteger(c) || c < 1 || c > maxElim) return `Teams to eliminate must be a whole number from 1 to ${maxElim} (50% of the teams still in).`;
    return '';
  }
  async function addRound() {
    const bad = elimProblem(rDraft); if (bad) { alert(bad); return; }
    const done = await call('add_round', { p_name: rDraft.name, p_eliminate: rDraft.eliminate, p_count: +rDraft.count || 0 });
    if (done) { setRDraft(EMPTY_R); await loadQuestions(); }
  }
  function editRoundRow(r) { setEditingRound(r.id); setREdit({ name: r.name, eliminate: r.eliminate_enabled, count: r.eliminate_count || 1 }); }
  async function saveRound() {
    const bad = elimProblem(rEdit); if (bad) { alert(bad); return; }
    const done = await call('update_round', { p_id: editingRound, p_name: rEdit.name, p_eliminate: rEdit.eliminate, p_count: +rEdit.count || 0 });
    if (done) { setEditingRound(null); await loadQuestions(); }
  }
  async function delRound(r) {
    if (confirm(`Delete ${rl(r)} and ALL ${qsIn(r.id).length} of its questions?`)) { await call('delete_round', { p_id: r.id }); await loadQuestions(); }
  }
  async function moveRound(r, dir) { await call('move_round', { p_id: r.id, p_dir: dir }); await loadQuestions(); }

  // ----- elimination -----
  function toggleTeam(id) {
    setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  async function confirmElimination() {
    const names = lowFirst.filter(t => picked.has(t.team_id)).map(t => t.team_name).join(', ');
    if (!confirm(`Eliminate ${picked.size} team(s): ${names}?\n\nThey are locked out immediately. This can only be undone by restarting the game.`)) return;
    await call('apply_elimination', { p_round: curRound.id, p_team_ids: [...picked] });
    loadBoard(); loadQuestions();
  }

  const showingQ = ctrl?.show_questions_to_players !== false;

  const roundFields = (v, set) => (
    <div className="qform-row" style={{ alignItems: 'center' }}>
      <input className="input" placeholder="Optional title, e.g. Semi-final" value={v.name} onChange={e => set({ ...v, name: e.target.value })} />
      <select className="input" style={{ width: 170 }} value={v.eliminate ? 'yes' : 'no'}
        onChange={e => set({ ...v, eliminate: e.target.value === 'yes' })}>
        <option value="no">Eliminate teams? No</option>
        <option value="yes">Eliminate teams? Yes</option>
      </select>
      {v.eliminate && (
        <input className="input" type="number" min="1" max={maxElim} step="1" style={{ width: 150 }} value={v.count}
          onChange={e => set({ ...v, count: e.target.value })} placeholder={`How many? (max ${maxElim})`} title="Number of teams to eliminate" />
      )}
    </div>
  );

  return (
    <div className="stage" style={{ maxWidth: 1000, margin: '0 auto', width: '100%' }}>
      <div className="brandbar">
        <span className="brand"><span className="dot" /> Admin control</span>
        <span>
          <b style={{ color: running ? 'var(--go)' : 'var(--amber)' }}>{ctrl?.status || '…'}</b>
          {curRound && curQ ? ` · ${rl(curRound)} · Q${posInRound}/${qsIn(curRound.id).length} · ${ctrl?.question_phase}` : ''}
          {between ? ` · ${rl(curRound)} complete` : ''}
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

      {/* ROUND COMPLETE / ELIMINATION */}
      {between && (
        <div className="panel" style={{ marginBottom: 14, borderColor: 'var(--amber)', borderWidth: 2 }}>
          <h2 className="display" style={{ fontSize: 20, marginBottom: 6 }}>{rl(curRound)} complete</h2>
          {!curRound.eliminate_enabled && (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No elimination in this round. The Game Master can start the next round.</p>
          )}
          {curRound.eliminate_enabled && curRound.eliminations_applied && (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>
              Eliminated: {board.filter(t => t.eliminated_in_round === curRound.round_number).map(t => t.team_name).join(', ') || '—'}.
              The Game Master can start the next round.
            </p>
          )}
          {curRound.eliminate_enabled && !curRound.eliminations_applied && (
            <>
              <p style={{ fontSize: 14, marginBottom: 4 }}>
                Eliminate the <b>{N}</b> lowest team{N === 1 ? '' : 's'}. The lowest totals are ticked for you.
                The Game Master can&rsquo;t start the next round until you confirm.
              </p>
              {tieAtCut && <p style={{ color: 'var(--amber)', fontSize: 14, marginBottom: 6 }}>Tie at the cut line &mdash; decide who goes out by changing the ticks.</p>}
              {N > Math.floor(active.length / 2) && <p style={{ color: 'var(--stop)', fontSize: 14, marginBottom: 6 }}>Too many: with {active.length} teams still in, at most {Math.floor(active.length / 2)} (50%) can go out. Pause the game and edit the round first.</p>}
              <div style={{ display: 'grid', gap: 6, margin: '10px 0' }}>
                {lowFirst.map(t => (
                  <label key={t.team_id} className="qrow" style={{ cursor: 'pointer', borderColor: picked.has(t.team_id) ? 'var(--stop)' : 'var(--line)' }}>
                    <input type="checkbox" checked={picked.has(t.team_id)} onChange={() => toggleTeam(t.team_id)} style={{ width: 20, height: 20 }} />
                    <span style={{ flex: 1, fontWeight: 500 }}>{t.team_name}</span>
                    <span className="mono" style={{ fontSize: 18 }}>{t.total}</span>
                  </label>
                ))}
              </div>
              <button className="btn btn-stop" disabled={picked.size !== N || N > Math.floor(active.length / 2)} onClick={confirmElimination}>
                Eliminate {picked.size} of {N} selected team{N === 1 ? '' : 's'}
              </button>
            </>
          )}
        </div>
      )}

      <div className="admin-grid">
        {/* SCOREBOARD */}
        <div className="panel">
          <h2 className="display" style={{ fontSize: 20, marginBottom: 12 }}>Live scorecard</h2>
          {board.length === 0 && <p style={{ color: 'var(--muted)' }}>No teams have joined yet.</p>}
          {board.map((t, i) => (
            <div key={t.team_number} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)', opacity: t.eliminated ? 0.45 : 1 }}>
              <span className="mono" style={{ width: 26, color: 'var(--muted)' }}>{t.eliminated ? '✕' : i + 1}</span>
              <span style={{ flex: 1, fontWeight: 500 }}>
                {t.team_name}
                {t.eliminated && <span style={{ color: 'var(--stop)', fontSize: 12, marginLeft: 8 }}>out R{t.eliminated_in_round}</span>}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>{t.passes_remaining} pass</span>
              <span className="mono" style={{ fontSize: 20, width: 60, textAlign: 'right', color: t.total < 0 ? 'var(--stop)' : 'var(--text)' }}>{t.total}</span>
            </div>
          ))}
        </div>

        {/* ROUNDS + QUESTION EDITOR */}
        <div className="panel">
          <h2 className="display" style={{ fontSize: 20, marginBottom: 4 }}>Rounds &amp; questions ({rounds.length} rounds, {questions.length} questions)</h2>
          {loadErr && <p style={{ color: 'var(--stop)', fontSize: 13, marginBottom: 10 }}>Could not load the question list: {loadErr}</p>}
          {running
            ? <p style={{ color: 'var(--amber)', fontSize: 13, marginBottom: 10 }}>Pause the game to add, edit, or reorder rounds and questions.</p>
            : <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 10 }}>Add, edit, and reorder freely. Timer must be 5 or 10.</p>}

          {!running && (
            <>
              {/* add round */}
              <div style={{ display: 'grid', gap: 8, marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Add a round</div>
                {roundFields(rDraft, setRDraft)}
                <button className="btn" onClick={addRound}>+ Add round</button>
              </div>

              {/* add / edit question */}
              <div style={{ display: 'grid', gap: 8, marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{editing ? 'Edit question' : 'Add a question'}</div>
                {!editing && (
                  <select className="input" value={draft.round_id} onChange={e => setDraft({ ...draft, round_id: e.target.value })}>
                    {rounds.map(r => <option key={r.id} value={r.id}>Add to: {rl(r)}</option>)}
                  </select>
                )}
                <input className="input" placeholder="Question text" value={draft.text}
                  onChange={e => setDraft({ ...draft, text: e.target.value })} />
                <div className="qform-row">
                  <input className="input" type="number" min="1" max="10" step="1" style={{ width: 90 }} value={draft.base}
                    onChange={e => setDraft({ ...draft, base: e.target.value })} title="Base points (1 to 10)" placeholder="Pts 1-10" />
                  <select className="input" style={{ width: 90 }} value={draft.limit}
                    onChange={e => setDraft({ ...draft, limit: e.target.value })}>
                    <option value={5}>5s</option><option value={10}>10s</option>
                  </select>
                  <input className="input" placeholder="Segment" value={draft.segment}
                    onChange={e => setDraft({ ...draft, segment: e.target.value })} />
                </div>
                <button className="btn btn-amber" onClick={saveDraft}>{editing ? 'Save changes' : 'Add question'}</button>
                {editing && <button className="btn" onClick={() => { setEditing(null); setDraft({ ...EMPTY_Q, round_id: rounds[rounds.length - 1]?.id || '' }); }}>Cancel edit</button>}
              </div>
            </>
          )}

          {/* rounds with their questions */}
          <div className="qlist">
            {rounds.map((r, ri) => (
              <div key={r.id} className="rcard">
                {editingRound === r.id ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {roundFields(rEdit, setREdit)}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-amber" onClick={saveRound}>Save round</button>
                      <button className="btn" onClick={() => setEditingRound(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="rhead">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="display" style={{ fontSize: 17 }}>{rl(r)}</div>
                      <div style={{ color: r.eliminate_enabled ? 'var(--amber)' : 'var(--muted)', fontSize: 12 }}>
                        {qsIn(r.id).length} question{qsIn(r.id).length === 1 ? '' : 's'} ·{' '}
                        {r.eliminate_enabled ? `eliminates ${r.eliminate_count} team${r.eliminate_count === 1 ? '' : 's'}${r.eliminations_applied ? ' (done)' : ''}` : 'no elimination'}
                      </div>
                    </div>
                    {!running && (
                      <div className="qactions">
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => moveRound(r, 'up')} disabled={ri === 0} aria-label="Move round up">&uarr;</button>
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => moveRound(r, 'down')} disabled={ri === rounds.length - 1} aria-label="Move round down">&darr;</button>
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => editRoundRow(r)} disabled={r.eliminations_applied}>Edit</button>
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => delRound(r)} aria-label="Delete round">&times;</button>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                  {qsIn(r.id).length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No questions yet.</div>}
                  {qsIn(r.id).map((q, i, arr) => (
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
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => move(q, 'down')} disabled={i === arr.length - 1} aria-label="Move down">&darr;</button>
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => editRow(q)}>Edit</button>
                        <button className="btn" style={{ padding: '6px 9px' }} onClick={() => delRow(q)} aria-label="Delete">&times;</button>
                      </div>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
