import React from 'react';

export function BudgetMeter({ rows = [], title = 'Budget', compact }) {
  if (compact) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14, padding: '0 12px', whiteSpace: 'nowrap', height: 28, borderRadius: 6, background: 'var(--fp-bg-0)', border: '1px solid var(--fp-line-1)', fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-3)' }}>
        {rows.map(function (r) {
          return <span key={r.label} title={r.label} style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap', color: r.warn ? 'var(--fp-warn)' : 'var(--fp-fg-3)' }}>{r.icon && <i className={'icon-' + r.icon} style={{ fontSize: 12 }} />}{r.display}</span>;
        })}
      </div>
    );
  }
  return (
    <div style={{ background: 'var(--fp-bg-1)', border: '1px solid var(--fp-line-1)', borderRadius: 12, padding: 14, display: 'grid', gap: 12, fontFamily: 'var(--fp-font-ui)' }}>
      <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fp-fg-4)' }}>{title}</span>
      <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr) 76px', gap: '8px 10px', alignItems: 'center', fontSize: 11 }}>
        {rows.map(function (r) {
          return (
            <React.Fragment key={r.label}>
              <span style={{ color: 'var(--fp-fg-3)' }}>{r.label}</span>
              <span style={{ position: 'relative', height: 4, borderRadius: 2, background: 'var(--fp-bg-3)' }}>
                <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: Math.min(100, r.value * 100) + '%', borderRadius: 2, background: r.warn ? 'var(--fp-warn)' : 'var(--fp-fg-2)' }} />
                {r.limit != null && <span style={{ position: 'absolute', left: (r.limit * 100) + '%', top: -3, width: 1, height: 10, background: 'var(--fp-fg-4)' }} />}
              </span>
              <span style={{ fontFamily: 'var(--fp-font-mono)', textAlign: 'right', color: r.warn ? 'var(--fp-warn)' : 'var(--fp-fg-2)' }}>{r.display}</span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
