import React from 'react';

export function IconButton({ icon, active, disabled, title, onClick, size = 28 }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button title={title} aria-label={title} onClick={onClick} disabled={disabled} onMouseEnter={function () { setHover(true); }} onMouseLeave={function () { setHover(false); }}
      style={{ width: size, height: size, display: 'inline-grid', placeItems: 'center', borderRadius: 6, border: 0, padding: 0,
        background: active || (hover && !disabled) ? 'var(--fp-bg-3)' : 'transparent', color: disabled ? 'var(--fp-fg-4)' : (active || hover ? 'var(--fp-fg-1)' : 'var(--fp-fg-2)'),
        cursor: disabled ? 'default' : 'pointer', transition: 'background 140ms, color 140ms' }}>
      <i className={'icon-' + icon} style={{ fontSize: Math.round(size * 0.53) }} />
    </button>
  );
}
