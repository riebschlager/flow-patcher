import React from 'react';

export function Knob({ label, value, defaultValue = 0.5, onChange, mod = 0, format, size = 48, disabled }) {
  const [inner, setInner] = React.useState(value != null ? value : defaultValue);
  const v = value != null ? value : inner;
  const set = function (nv) { setInner(nv); if (onChange) onChange(nv); };
  const onPointerDown = function (e) {
    if (disabled) return;
    e.preventDefault();
    const y0 = e.clientY, v0 = v;
    const mv = function (ev) { set(Math.min(1, Math.max(0, v0 + (y0 - ev.clientY) / (ev.shiftKey ? 800 : 160)))); };
    const up = function () { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  const reset = function (e) { if (e) e.preventDefault(); set(defaultValue); };
  const end = Math.min(1, v + mod);
  const fmt = format || function (x) { return Math.round(x * 100) + ' %'; };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: size + 16, userSelect: 'none', opacity: disabled ? 0.4 : 1, fontFamily: 'var(--fp-font-ui)' }}>
      <svg width={size} height={size} viewBox="0 0 32 32" onPointerDown={onPointerDown} onDoubleClick={reset} onContextMenu={reset}
        style={{ cursor: disabled ? 'default' : 'ns-resize', touchAction: 'none', overflow: 'visible' }}>
        <circle cx="16" cy="16" r="12" fill="none" stroke="var(--fp-line-2)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="56.55 75.4" transform="rotate(135 16 16)" />
        <circle cx="16" cy="16" r="12" fill="none" stroke="var(--fp-fg-1)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray={(v * 56.55).toFixed(2) + ' 75.4'} transform="rotate(135 16 16)" />
        {mod > 0 && <circle cx="16" cy="16" r="15.2" fill="none" stroke="var(--fp-signal)" strokeWidth="1.2" strokeLinecap="round" strokeDasharray={((end - v) * 72.9).toFixed(2) + ' 96'} strokeDashoffset={(-v * 72.9).toFixed(2)} transform="rotate(135 16 16)" />}
        <circle cx="16" cy="16" r="8.5" fill="var(--fp-bg-3)" stroke="var(--fp-line-2)" strokeWidth="0.5" />
        <line x1="16" y1="12.5" x2="16" y2="8.6" stroke="var(--fp-fg-1)" strokeWidth="1.4" strokeLinecap="round" transform={'rotate(' + (-135 + 270 * v).toFixed(1) + ' 16 16)'} />
      </svg>
      {label && <span style={{ fontSize: 11, color: 'var(--fp-fg-2)' }}>{label}</span>}
      <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-3)', fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</span>
    </div>
  );
}
