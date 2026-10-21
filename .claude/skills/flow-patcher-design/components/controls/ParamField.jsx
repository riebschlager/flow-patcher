import React from 'react';

export function ParamField({ label, value, defaultValue = 0.5, onChange, display, format, mod = 0, kind = 'field', option, swatches, state, disabled }) {
  const [inner, setInner] = React.useState(value != null ? value : defaultValue);
  const [hover, setHover] = React.useState(false);
  const v = value != null ? value : inner;
  const set = function (nv) { setInner(nv); if (onChange) onChange(nv); };
  const isHover = state === 'hover' || hover;
  const base = {
    position: 'relative', height: 22, borderRadius: 4, overflow: 'hidden', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', gap: 8, padding: '0 8px', fontSize: 11, fontFamily: 'var(--fp-font-ui)',
    background: isHover ? 'var(--fp-bg-3)' : 'var(--fp-bg-1)', boxShadow: isHover ? 'inset 0 0 0 1px var(--fp-line-3)' : 'none',
    transition: 'background 140ms', userSelect: 'none', opacity: disabled ? 0.45 : 1
  };
  const hov = { onMouseEnter: function () { setHover(true); }, onMouseLeave: function () { setHover(false); } };
  if (kind === 'select') {
    return <div {...hov} style={Object.assign({}, base, { cursor: 'pointer' })}><span style={{ color: 'var(--fp-fg-2)' }}>{option || label}</span><i className="icon-chevron-down" style={{ fontSize: 12, color: 'var(--fp-fg-3)' }} /></div>;
  }
  if (kind === 'swatches') {
    return <div {...hov} style={base}><span style={{ color: 'var(--fp-fg-2)' }}>{label}</span><span style={{ display: 'flex', gap: 2 }}>{(swatches || []).map(function (c, i) { return <span key={i} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />; })}</span></div>;
  }
  const fmt = format || function (x) { return x.toFixed(2); };
  const text = display != null ? display : fmt(v);
  if (state === 'editing') {
    return (
      <div style={Object.assign({}, base, { background: 'var(--fp-bg-0)', overflow: 'visible', boxShadow: 'var(--fp-ring-focus)' })}>
        <span style={{ color: 'var(--fp-fg-2)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--fp-font-mono)', color: 'var(--fp-fg-1)' }}>{text}<span style={{ display: 'inline-block', width: 1, height: 12, background: 'var(--fp-fg-1)', marginLeft: 1, verticalAlign: -2 }} /></span>
      </div>
    );
  }
  const onPointerDown = function (e) {
    if (disabled || value === undefined && !onChange && display != null) return;
    e.preventDefault();
    const w = e.currentTarget.getBoundingClientRect().width, x0 = e.clientX, v0 = v;
    const mv = function (ev) { set(Math.min(1, Math.max(0, v0 + (ev.clientX - x0) / (ev.shiftKey ? w * 5 : w)))); };
    const up = function () { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  const end = Math.min(1, v + mod);
  return (
    <div {...hov} onPointerDown={onPointerDown} onDoubleClick={function () { set(defaultValue); }} style={Object.assign({}, base, { cursor: 'ew-resize', touchAction: 'none' })}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: (v * 100) + '%', background: 'var(--fp-bg-4)' }} />
      {mod > 0 && <span style={{ position: 'absolute', left: (v * 100) + '%', top: 0, bottom: 0, width: ((end - v) * 100) + '%', background: 'var(--fp-signal-soft)', borderLeft: '1.5px solid var(--fp-signal)' }} />}
      <span style={{ position: 'relative', color: isHover ? 'var(--fp-fg-1)' : 'var(--fp-fg-2)' }}>{label}</span>
      <span style={{ position: 'relative', fontFamily: 'var(--fp-font-mono)', color: 'var(--fp-fg-1)', fontVariantNumeric: 'tabular-nums' }}>{text}</span>
    </div>
  );
}
