'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { rpc } from '../lib/supabaseClient';

export default function Login() {
  const router = useRouter();
  const [role, setRole] = useState('player');   // player | gm | admin
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('ops.ibsb.gg');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    rpc('get_public_config').then(c => c?.login_domain && setDomain(c.login_domain)).catch(() => {});
  }, []);

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const res = await rpc('login', { p_role: role, p_password: password, p_name: name || null });
      if (!res?.ok) {
        setErr(res?.reason === 'no_free_team'
          ? 'All team slots are taken — ask the admin.'
          : 'That password didn\u2019t match. Check with the organiser.');
        setBusy(false);
        return;
      }
      localStorage.setItem('ops_identity', JSON.stringify(res));
      router.push(res.role === 'admin' ? '/admin' : res.role === 'gm' ? '/gm' : '/player');
    } catch (e) {
      setErr('Couldn\u2019t reach the server. Check your connection.');
      setBusy(false);
    }
  }

  const roles = [['player','Team'], ['gm','Game Master'], ['admin','Admin']];

  return (
    <div className="screen" style={{ justifyContent: 'center', gap: 22 }}>
      <div className="center">
        <div className="brand" style={{ justifyContent: 'center', fontSize: 15 }}>
          <span className="dot" /> OPSPHERE · Manthan
        </div>
        <h1 className="display" style={{ fontSize: 40, marginTop: 10, lineHeight: 1.05 }}>
          OPS in One Word
        </h1>
        <p style={{ color: 'var(--muted)', marginTop: 8 }}>Round 2 · buzz fastest, answer out loud.</p>
      </div>

      <div className="panel" style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {roles.map(([val, label]) => (
            <button key={val}
              className={'btn' + (role === val ? ' btn-amber' : '')}
              onClick={() => { setRole(val); setErr(''); }}>
              {label}
            </button>
          ))}
        </div>

        {role === 'player' && (
          <div>
            <label className="field-label">Your team name (shown on the leaderboard)</label>
            <input className="input" value={name} maxLength={24}
              onChange={e => setName(e.target.value)} placeholder="e.g. The Bottlenecks" />
          </div>
        )}

        <div>
          <label className="field-label">
            {role === 'player' ? 'Team password' : role === 'gm' ? 'Game Master password' : 'Admin password'}
          </label>
          <input className="input" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !busy && submit()}
            placeholder="from the organiser" />
        </div>

        {err && <div className="err">{err}</div>}

        <button className="btn btn-amber btn-block" disabled={busy || !password} onClick={submit}>
          {busy ? 'Checking\u2026' : role === 'player' ? 'Join the game' : 'Enter'}
        </button>
        <p style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
          Signing in on the <b>{domain}</b> game domain.
        </p>
      </div>
    </div>
  );
}
