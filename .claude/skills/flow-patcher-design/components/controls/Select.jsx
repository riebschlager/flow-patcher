import React from 'react';

export function Select({ value, placeholder = 'Choose…', onClick, width = 180, disabled }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={function () { setHover(true); }} onMouseLeave={function () { setHover(false); }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, height: 28, padding: '0 10px', minWidth: width, borderRadius: 6, background: hover && !disabled ? 'var(--fp-bg-3)' : 'var(--fp-bg-2)', border: '1px solid var(--fp-line-2)', fontFamily: 'var(--fp-font-ui)', fontSize: 12, color: value ? 'var(--fp-fg-1)' : 'var(--fp-fg-4)', cursor: disabled ? 'default' : 'pointer', transition: 'background 140ms' }}>
      <span>{value || placeholder}</span><i className="icon-chevron-down" style={{ fontSize: 13, color: 'var(--fp-fg-3)' }} />
    </button>
  );
}
