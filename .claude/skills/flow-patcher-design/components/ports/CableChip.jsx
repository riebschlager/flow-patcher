import React from 'react';

export function CableChip({ kind = 'depth', value = 0.5, label, levels = [0.4, 0.7, 0.9, 0.6, 0, 0] }) {
  const pill = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 20, padding: '0 7px', borderRadius: 999, background: 'var(--fp-bg-2)', whiteSpace: 'nowrap' };
  if (kind === 'error') {
    return (
      <span style={Object.assign({}, pill, { height: 22, padding: '0 8px', border: '1px solid var(--fp-error)', fontSize: 11, color: 'var(--fp-fg-1)', fontFamily: 'var(--fp-font-ui)' })}>
        <i className="icon-triangle-alert" style={{ fontSize: 12, color: 'var(--fp-error)' }} />{label || 'Needs a Delay Edge'}
      </span>
    );
  }
  if (kind === 'meter') {
    return (
      <span style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 18, padding: '3px 5px', borderRadius: 4, background: 'var(--fp-bg-2)', border: '1px solid var(--fp-line-2)' }}>
        {levels.map(function (l, i) {
          return <span key={i} style={{ width: 3, height: Math.max(4, Math.round(l * 12)), background: l > 0.92 ? 'var(--fp-warn)' : l > 0 ? 'var(--fp-audio)' : 'var(--fp-line-2)' }} />;
        })}
      </span>
    );
  }
  const pct = Math.round(Math.min(1, Math.abs(value)) * 100);
  return (
    <span style={Object.assign({}, pill, { border: '1px solid var(--fp-signal)', fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-signal)' })}>
      <span style={{ width: 28, height: 3, borderRadius: 2, background: 'linear-gradient(90deg, var(--fp-signal) ' + pct + '%, var(--fp-line-2) ' + pct + '%)' }} />
      {label || ((value >= 0 ? '+' : '−') + Math.abs(value).toFixed(2))}
    </span>
  );
}
