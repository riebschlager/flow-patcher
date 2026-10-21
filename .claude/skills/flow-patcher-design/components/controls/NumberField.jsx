import React from 'react';

export function NumberField({ label, value, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', height: 28, borderRadius: 6, background: 'var(--fp-bg-1)', border: '1px solid var(--fp-line-2)', overflow: 'hidden', fontFamily: 'var(--fp-font-ui)' }}>
      {label && <span style={{ padding: '0 8px', fontSize: 11, color: 'var(--fp-fg-3)' }}>{label}</span>}
      <span style={{ padding: '0 10px', height: '100%', display: 'flex', alignItems: 'center', borderLeft: label ? '1px solid var(--fp-line-1)' : 'none', fontFamily: 'var(--fp-font-mono)', fontSize: 12, color: 'var(--fp-fg-1)', cursor: 'ew-resize', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
