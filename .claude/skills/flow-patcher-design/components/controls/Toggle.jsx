import React from 'react';

export function Toggle({ checked, defaultChecked = false, onChange, label, disabled }) {
  const [inner, setInner] = React.useState(checked != null ? checked : defaultChecked);
  const on = checked != null ? checked : inner;
  return (
    <button role="switch" aria-checked={on} disabled={disabled} onClick={function () { setInner(!on); if (onChange) onChange(!on); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: 0, background: 'transparent', padding: 0, cursor: disabled ? 'default' : 'pointer', fontFamily: 'var(--fp-font-ui)', fontSize: 12, color: disabled ? 'var(--fp-fg-4)' : 'var(--fp-fg-2)' }}>
      <span style={{ width: 28, height: 16, borderRadius: 999, padding: 2, display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', background: on ? 'var(--fp-fg-1)' : 'var(--fp-bg-4)', transition: 'background 140ms' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: on ? 'var(--fp-bg-0)' : 'var(--fp-fg-3)' }} />
      </span>
      {label}
    </button>
  );
}
