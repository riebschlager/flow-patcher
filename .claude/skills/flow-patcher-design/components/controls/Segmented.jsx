import React from 'react';

export function Segmented({ options = [], value, defaultValue, onChange, size = 'sm' }) {
  const [inner, setInner] = React.useState(value != null ? value : (defaultValue != null ? defaultValue : options[0]));
  const v = value != null ? value : inner;
  const h = size === 'md' ? 24 : 22;
  return (
    <div role="tablist" style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 6, background: 'var(--fp-bg-0)', border: '1px solid var(--fp-line-1)' }}>
      {options.map(function (o) {
        const on = o === v;
        return (
          <button key={o} role="tab" aria-selected={on} onClick={function () { setInner(o); if (onChange) onChange(o); }}
            style={{ height: h, padding: size === 'md' ? '0 12px' : '0 10px', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--fp-font-ui)', fontSize: size === 'md' ? 12 : 11, background: on ? 'var(--fp-bg-3)' : 'transparent', color: on ? 'var(--fp-fg-1)' : 'var(--fp-fg-3)', transition: 'background 140ms, color 140ms' }}>{o}</button>
        );
      })}
    </div>
  );
}
