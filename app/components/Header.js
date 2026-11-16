'use client';
import { useState } from 'react';

// The three-part OPSPHERE header (§5). Logo assets live in public/ and must be
// the REAL files (logo.png, ibs-logo.png) — never redrawn (§1). Until they're
// added, we fall back to text so nothing renders broken on a projector.
export default function Header() {
  const [logoOk, setLogoOk] = useState(true);
  const [ibsOk, setIbsOk] = useState(true);
  return (
    <header className="opsbar">
      <div className="left">
        {logoOk
          ? <div className="logochip"><img className="logo" src="/logo.png" alt="OPSPHERE" onError={() => setLogoOk(false)} /></div>
          : null}
        <span className="wordmark">OPSPHERE</span>
      </div>
      <div className="subtitle">OPS in One Word</div>
      <div className="chip">
        {ibsOk
          ? <img src="/ibs-logo.png" alt="IBS Bengaluru" onError={() => setIbsOk(false)} />
          : <span className="fallback">IBS</span>}
      </div>
    </header>
  );
}
