// Builds the "round by round" Excel record from the data returned by the
// get_export_data() database function. Runs in the browser (admin page).

const NAVY = 'FF1C0B55';
const PURPLE = 'FF8F6BFF';
const LIGHT = 'FFEDE9FF';
const GREY = 'FF6B6590';

const roundLabel = r => `Round ${r.round_number}`;
const roundTitle = r => `Round ${r.round_number}${r.name ? ' · ' + r.name : ''}`;

// Rows shown on every team sheet (the "scoring parameters").
const PARAMS = [
  'Questions faced',
  'Buzzed',
  'Passed (PASS card)',
  'No response',
  'Called to answer',
  'Correct answers',
  'Wrong answers',
  'Buzzed but not called',
  'Average buzz time (s)',
  'Fastest buzz (s)',
  'Points from correct answers',
  'Points lost on wrong answers',
  'Net round score',
  'Cumulative score',
  'Status at end of round',
];
const P = Object.fromEntries(PARAMS.map((n, i) => [n, i]));   // name -> index

const round1 = n => Math.round(n * 1000) / 1000;

// ---- pure calculation (no Excel here, easy to test) ---------------------------------
export function buildReport(data) {
  const rounds = [...data.rounds].sort((a, b) => a.round_number - b.round_number);
  const teams = data.teams;
  const qByRound = new Map(rounds.map(r => [r.id, data.questions.filter(q => q.round_id === r.id)]));
  const buzzKey = new Map(data.buzzes.map(b => [b.question_id + '|' + b.team_id, b]));
  const markKey = new Map(data.marks.map(m => [m.question_id + '|' + m.team_id, m]));

  // Which questions have actually been played? Questions are always played in order
  // (round by round), so anything before the game's current position has been played.
  // Anything someone buzzed/passed/was marked on also counts.
  const acted = new Set([...data.buzzes.map(b => b.question_id), ...data.marks.map(m => m.question_id)]);
  const curQ = data.questions.find(q => q.id === data.current_question_id);
  const curRound = rounds.find(r => r.id === (curQ ? curQ.round_id : data.current_round_id));
  const isPlayed = q => {
    if (acted.has(q.id)) return true;
    const rd = rounds.find(r => r.id === q.round_id);
    if (!curRound || !rd) return false;
    if (rd.round_number < curRound.round_number) return true;
    if (rd.id !== curRound.id) return false;
    if (!curQ) return data.round_state === 'between';          // round finished
    return q.order_index < curQ.order_index || (q.id === curQ.id && data.question_phase !== 'idle');
  };
  const playedQs = new Map(rounds.map(r => [r.id, (qByRound.get(r.id) || []).filter(isPlayed)]));
  const played = new Map(rounds.map(r => [r.id, playedQs.get(r.id).length > 0]));

  const perTeam = teams.map(t => {
    let cumulative = 0;
    const cols = rounds.map(r => {
      const qs = playedQs.get(r.id) || [];
      const eliminatedBefore = t.eliminated && t.eliminated_in_round != null && t.eliminated_in_round < r.round_number;
      const faced = played.get(r.id) && !eliminatedBefore;
      const c = { faced: faced ? qs.length : 0, buzzed: 0, passed: 0, correct: 0, wrong: 0, plus: 0, minus: 0, times: [] };
      if (faced) {
        for (const q of qs) {
          const b = buzzKey.get(q.id + '|' + t.id);
          if (b) {
            if (b.action_type === 'buzz') { c.buzzed++; if (b.client_reaction_time != null) c.times.push(Number(b.client_reaction_time)); }
            else c.passed++;
          }
          const m = markKey.get(q.id + '|' + t.id);
          if (m) {
            if (m.is_correct) { c.correct++; c.plus += m.points_awarded; }
            else { c.wrong++; c.minus += m.points_awarded; }
          }
        }
      }
      c.called = c.correct + c.wrong;
      c.noResponse = faced ? Math.max(c.faced - c.buzzed - c.passed, 0) : 0;
      c.notCalled = Math.max(c.buzzed - c.called, 0);
      c.net = c.plus + c.minus;
      cumulative += c.net;
      c.cumulative = cumulative;
      c.status = eliminatedBefore ? 'Eliminated earlier'
        : !played.get(r.id) ? 'Not played'
        : t.eliminated_in_round === r.round_number ? 'Eliminated'
        : r.eliminate_enabled && r.eliminations_applied ? 'Advanced' : 'Played';
      return c;
    });
    return { team: t, cols, total: cumulative };
  });
  return { rounds, perTeam, played };
}

// ---- Excel writing --------------------------------------------------------------------
function safeSheetName(name, used) {
  let base = String(name).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Team';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { const suf = ` (${i++})`; n = base.slice(0, 31 - suf.length) + suf; }
  used.add(n.toLowerCase());
  return n;
}
function head(cell, fill = NAVY) {
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
}

export async function buildWorkbook(data) {
  const ExcelJS = (await import('exceljs/dist/exceljs.min.js')).default;
  const { rounds, perTeam } = buildReport(data);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OPSPHERE · OPS in One Word';
  wb.created = new Date(data.exported_at || Date.now());
  const used = new Set(['summary']);
  const numFmtPts = '0;[Red]-0';

  // ---------- Summary ----------
  const sum = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 5 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const nR = rounds.length;
  const lastCol = 3 + nR + 3;                    // rank, team, no., rounds..., total, passes, status
  sum.mergeCells(1, 1, 1, lastCol);
  sum.getCell('A1').value = 'OPS in One Word — Score Record';
  sum.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
  sum.getCell('A2').value = `Exported: ${new Date(data.exported_at || Date.now()).toLocaleString()}`;
  sum.getCell('A3').value = `Game status at export: ${data.status || '—'}   ·   Teams: ${perTeam.length}   ·   Rounds: ${nR}`;
  sum.getCell('A2').font = sum.getCell('A3').font = { color: { argb: GREY } };

  const hdr = ['Rank', 'Team', 'Team no.', ...rounds.map(roundLabel), 'Total', 'Passes left', 'Status'];
  hdr.forEach((h, i) => { const c = sum.getCell(5, i + 1); c.value = h; head(c); });
  sum.getRow(5).height = 24;

  const sorted = [...perTeam].sort((a, b) => b.total - a.total || a.team.team_number - b.team.team_number);
  const first = 6, lastRow = first + sorted.length - 1;
  const totalCol = 3 + nR + 1;
  const totalLetter = sum.getColumn(totalCol).letter;
  sorted.forEach((pt, i) => {
    const r = first + i;
    const rank = 1 + sorted.filter(o => o.total > pt.total).length;
    sum.getCell(r, 1).value = { formula: `RANK(${totalLetter}${r},${totalLetter}$${first}:${totalLetter}$${lastRow})`, result: rank };
    sum.getCell(r, 2).value = pt.team.display_name;
    sum.getCell(r, 3).value = pt.team.team_number;
    pt.cols.forEach((c, k) => { const cell = sum.getCell(r, 4 + k); cell.value = c.net; cell.numFmt = numFmtPts; });
    const a = sum.getColumn(4).letter, z = sum.getColumn(3 + nR).letter;
    sum.getCell(r, totalCol).value = nR ? { formula: `SUM(${a}${r}:${z}${r})`, result: pt.total } : 0;
    sum.getCell(r, totalCol).numFmt = numFmtPts;
    sum.getCell(r, totalCol).font = { bold: true };
    sum.getCell(r, totalCol + 1).value = pt.team.passes_remaining;
    sum.getCell(r, totalCol + 2).value = pt.team.eliminated ? `Out after Round ${pt.team.eliminated_in_round}` : 'Active';
    if (pt.team.eliminated) for (let k = 1; k <= lastCol; k++) sum.getCell(r, k).font = { color: { argb: GREY }, bold: k === totalCol };
    if (i % 2) for (let k = 1; k <= lastCol; k++) sum.getCell(r, k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F5FF' } };
  });
  for (let r = first; r <= lastRow; r++) for (let k = 1; k <= lastCol; k++) {
    const c = sum.getCell(r, k);
    c.alignment = { horizontal: k === 2 || k === lastCol ? 'left' : 'center', vertical: 'middle' };
  }

  // Round overview
  let r0 = lastRow + 3;
  sum.getCell(r0, 1).value = 'Round overview'; sum.getCell(r0, 1).font = { bold: true, size: 13, color: { argb: NAVY } };
  r0++;
  // columns: Round | Title | Questions | Elimination rule (D:E merged) | Eliminated teams (F:end merged)
  const ovCols = [[1, 1, 'Round'], [2, 2, 'Title'], [3, 3, 'Questions'], [4, 5, 'Elimination rule'], [6, lastCol, 'Eliminated teams']];
  ovCols.forEach(([a, b, h]) => { if (b > a) sum.mergeCells(r0, a, r0, b); const c = sum.getCell(r0, a); c.value = h; head(c, PURPLE); });
  rounds.forEach((rd, i) => {
    const rr = r0 + 1 + i;
    const out = perTeam.filter(p => p.team.eliminated_in_round === rd.round_number).map(p => p.team.display_name);
    sum.mergeCells(rr, 4, rr, 5); sum.mergeCells(rr, 6, rr, lastCol);
    sum.getCell(rr, 1).value = roundLabel(rd);
    sum.getCell(rr, 2).value = rd.name || '\u2014';
    sum.getCell(rr, 3).value = data.questions.filter(q => q.round_id === rd.id).length;
    sum.getCell(rr, 4).value = rd.eliminate_enabled ? `Bottom ${rd.eliminate_count} out` : 'No elimination';
    sum.getCell(rr, 6).value = rd.eliminate_enabled ? (rd.eliminations_applied ? (out.join(', ') || '\u2014') : 'Not confirmed yet') : '\u2014';
    [1, 2, 3, 4, 6].forEach(k => { sum.getCell(rr, k).alignment = { horizontal: k === 3 ? 'center' : 'left', vertical: 'middle' }; });
  });
  let nr = r0 + rounds.length + 2;
  [
    'How to read this file',
    'Round columns show the net points each team earned in that round (correct answers minus points lost on wrong answers).',
    'Scores carry over: Total is the running total across all rounds. Each team has its own tab with the full breakup per round.',
    'Points for a correct answer = base points × (time limit − buzz time). A wrong answer loses half of that.',
    'A round shows as "Not played" until the game has reached one of its questions.',
  ].forEach((t, i) => { const c = sum.getCell(nr + i, 1); c.value = t; c.font = i === 0 ? { bold: true, color: { argb: NAVY } } : { color: { argb: GREY } }; });

  sum.getColumn(1).width = 8; sum.getColumn(2).width = 28; sum.getColumn(3).width = 10;
  for (let k = 4; k < 4 + nR; k++) sum.getColumn(k).width = 11;
  sum.getColumn(totalCol).width = 11; sum.getColumn(totalCol + 1).width = 12; sum.getColumn(totalCol + 2).width = 22;

  // ---------- One tab per team ----------
  for (const pt of perTeam) {
    const name = safeSheetName(`T${pt.team.team_number} - ${pt.team.display_name}`, used);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.getCell('A1').value = pt.team.display_name; ws.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
    ws.getCell('A2').value = `Team ${pt.team.team_number}  ·  Final total: ${pt.total}  ·  Passes left: ${pt.team.passes_remaining}  ·  ${pt.team.eliminated ? 'Out after Round ' + pt.team.eliminated_in_round : 'Active'}`;
    ws.getCell('A2').font = { color: { argb: GREY } };

    const cols = pt.cols, tc = 2 + nR;               // total column index
    head(ws.getCell(4, 1)); ws.getCell(4, 1).value = 'Scoring parameter'; ws.getCell(4, 1).alignment = { vertical: 'middle', horizontal: 'left' };
    rounds.forEach((rd, k) => { const c = ws.getCell(4, 2 + k); c.value = roundLabel(rd); head(c); });
    ws.getCell(4, tc).value = 'Total'; head(ws.getCell(4, tc), PURPLE);
    ws.getRow(4).height = 22;

    const row = name => 5 + P[name];
    const L = k => ws.getColumn(2 + k).letter;
    const put = (param, fn, totalFn, fmt) => {
      const rr = row(param);
      ws.getCell(rr, 1).value = param;
      cols.forEach((c, k) => { const cell = ws.getCell(rr, 2 + k); cell.value = fn(c, k); if (fmt) cell.numFmt = fmt; });
      if (totalFn) { const cell = ws.getCell(rr, tc); cell.value = totalFn(rr); if (fmt) cell.numFmt = fmt; cell.font = { bold: true }; }
    };
    const sumTotal = (vals) => rr => nR ? { formula: `SUM(${L(0)}${rr}:${L(nR - 1)}${rr})`, result: vals } : 0;
    const colSum = f => cols.reduce((a, c) => a + f(c), 0);

    put('Questions faced',   c => c.faced,      rr => sumTotal(colSum(c => c.faced))(rr));
    put('Buzzed',            c => c.buzzed,     rr => sumTotal(colSum(c => c.buzzed))(rr));
    put('Passed (PASS card)',c => c.passed,     rr => sumTotal(colSum(c => c.passed))(rr));
    put('No response',       c => c.noResponse, rr => sumTotal(colSum(c => c.noResponse))(rr));
    put('Called to answer',  c => c.called,     rr => sumTotal(colSum(c => c.called))(rr));
    put('Correct answers',   c => c.correct,    rr => sumTotal(colSum(c => c.correct))(rr));
    put('Wrong answers',     c => c.wrong,      rr => sumTotal(colSum(c => c.wrong))(rr));
    put('Buzzed but not called', c => c.notCalled, rr => sumTotal(colSum(c => c.notCalled))(rr));
    const allT = cols.flatMap(c => c.times);
    put('Average buzz time (s)', c => c.times.length ? round1(c.times.reduce((a, b) => a + b, 0) / c.times.length) : '',
        () => allT.length ? round1(allT.reduce((a, b) => a + b, 0) / allT.length) : '', '0.00');
    put('Fastest buzz (s)',  c => c.times.length ? Math.min(...c.times) : '',
        () => allT.length ? Math.min(...allT) : '', '0.00');
    put('Points from correct answers', c => c.plus,  rr => sumTotal(colSum(c => c.plus))(rr), numFmtPts);
    put('Points lost on wrong answers', c => c.minus, rr => sumTotal(colSum(c => c.minus))(rr), numFmtPts);

    const pr = row('Points from correct answers'), lr = row('Points lost on wrong answers');
    const nrw = row('Net round score'), cr = row('Cumulative score');
    ws.getCell(nrw, 1).value = 'Net round score';
    ws.getCell(cr, 1).value = 'Cumulative score';
    cols.forEach((c, k) => {
      ws.getCell(nrw, 2 + k).value = { formula: `${L(k)}${pr}+${L(k)}${lr}`, result: c.net };
      ws.getCell(cr, 2 + k).value = k === 0
        ? { formula: `${L(0)}${nrw}`, result: c.cumulative }
        : { formula: `${L(k - 1)}${cr}+${L(k)}${nrw}`, result: c.cumulative };
      ws.getCell(nrw, 2 + k).numFmt = ws.getCell(cr, 2 + k).numFmt = numFmtPts;
    });
    ws.getCell(nrw, tc).value = nR ? { formula: `SUM(${L(0)}${nrw}:${L(nR - 1)}${nrw})`, result: pt.total } : 0;
    ws.getCell(cr, tc).value = nR ? { formula: `${L(nR - 1)}${cr}`, result: pt.total } : 0;
    ws.getCell(nrw, tc).numFmt = ws.getCell(cr, tc).numFmt = numFmtPts;

    put('Status at end of round', c => c.status, () => (pt.team.eliminated ? `Out after Round ${pt.team.eliminated_in_round}` : 'Active'));

    // styling
    PARAMS.forEach((p, i) => {
      const rr = 5 + i;
      for (let k = 1; k <= tc; k++) {
        const c = ws.getCell(rr, k);
        c.alignment = { horizontal: k === 1 ? 'left' : 'center', vertical: 'middle' };
        c.border = { bottom: { style: 'hair', color: { argb: 'FFC9C2F0' } } };
        if (p === 'Net round score' || p === 'Cumulative score') { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }; }
        else if (k === 1) c.font = { bold: false };
      }
    });
    ws.getColumn(1).width = 32;
    for (let k = 2; k <= tc; k++) ws.getColumn(k).width = 14;
    ws.getColumn(tc).width = 18;
  }
  return wb;
}

export async function downloadExport(data) {
  const wb = await buildWorkbook(data);
  const buf = await wb.xlsx.writeBuffer();
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const file = `OPS_in_One_Word_Scores_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return file;
}
