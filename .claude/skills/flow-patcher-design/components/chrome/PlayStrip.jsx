import React from 'react';

export function PlayStrip({ children, style }) {
  return (
    <div style={Object.assign({ display: 'inline-flex', alignItems: 'center', gap: 20, padding: '12px 18px', borderRadius: 12, background: 'oklch(0.205 0.008 265 / 0.72)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid var(--fp-line-2)', boxShadow: 'var(--fp-shadow-pop)', fontFamily: 'var(--fp-font-ui)' }, style)}>
      {children}
    </div>
  );
}
