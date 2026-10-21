import React from 'react';

const V = {
  primary: { bg: 'var(--fp-fg-1)', hover: 'var(--fp-fg-2)', fg: 'var(--fp-bg-0)', border: 'none', weight: 500 },
  secondary: { bg: 'var(--fp-bg-3)', hover: 'var(--fp-bg-4)', fg: 'var(--fp-fg-1)', border: '1px solid var(--fp-line-2)', weight: 400 },
  ghost: { bg: 'transparent', hover: 'var(--fp-bg-3)', fg: 'var(--fp-fg-2)', border: 'none', weight: 400 }
};

export function Button({ variant = 'secondary', icon, disabled, onClick, children, type = 'button' }) {
  const [hover, setHover] = React.useState(false);
  const v = V[variant] || V.secondary;
  return (
    <button type={type} onClick={onClick} disabled={disabled} onMouseEnter={function () { setHover(true); }} onMouseLeave={function () { setHover(false); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, whiteSpace: 'nowrap', padding: variant === 'ghost' ? '0 10px' : '0 12px', borderRadius: 6, fontFamily: 'var(--fp-font-ui)', fontSize: 12, fontWeight: v.weight,
        border: disabled ? '1px solid var(--fp-line-1)' : v.border, background: disabled ? 'transparent' : (hover ? v.hover : v.bg), color: disabled ? 'var(--fp-fg-4)' : (variant === 'ghost' && hover ? 'var(--fp-fg-1)' : v.fg),
        cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background 140ms, color 140ms' }}>
      {icon && <i className={'icon-' + icon} style={{ fontSize: 13 }} />}{children}
    </button>
  );
}
