/* Flow Patcher components: local bundle generated from the jsx files in components/. Regenerate after editing a component. */
(function () {

// ports/Port

const PORT_COLORS = {
  event: 'var(--fp-event)', note: 'var(--fp-note)', signal: 'var(--fp-signal)',
  audio: 'var(--fp-audio)', field: 'var(--fp-field)', value: 'var(--fp-value)'
};
const PORT_SIZE = { event: [9, 9], note: [9, 9], signal: [10, 10], audio: [13, 8], field: [10, 10], value: [10, 10] };

function Port({ type = 'signal', ring = 'var(--fp-bg-2)', state = 'idle', style }) {
  const c = PORT_COLORS[type] || PORT_COLORS.signal;
  const sz = PORT_SIZE[type] || PORT_SIZE.signal;
  const sc = state === 'target' ? 1.35 : 1;
  const halo = state === 'target' ? ', 0 0 0 4px var(--fp-' + type + '-soft)' : '';
  const ringS = '0 0 0 2px ' + ring;
  const s = {
    display: 'inline-block', flex: 'none', width: sz[0], height: sz[1],
    opacity: state === 'dim' ? 0.3 : 1, transition: 'opacity 140ms, transform 140ms',
    transform: 'scale(' + sc + ')', boxShadow: ringS + halo, background: c
  };
  if (type === 'event') { s.borderRadius = 1.5; s.transform = 'rotate(45deg) scale(' + sc + ')'; }
  else if (type === 'note') { s.borderRadius = 1.5; s.transform = 'rotate(45deg) scale(' + sc + ')'; s.background = ring; s.boxShadow = 'inset 0 0 0 2.5px ' + c + ', ' + ringS + halo; }
  else if (type === 'audio') { s.borderRadius = 4; }
  else if (type === 'field') { s.borderRadius = 2; }
  else if (type === 'value') { s.borderRadius = '50%'; s.background = ring; s.border = '2px solid ' + c; }
  else { s.borderRadius = '50%'; }
  return <span aria-label={type + ' port'} style={Object.assign(s, style)} />;
}

// ports/Cable


const CABLE_STYLES = {
  event: { w: 1.5, dash: '3 3' }, note: { w: 1.5, dash: '8 3' }, signal: { w: 1.5, cap: 'round' },
  audio: { w: 3, cap: 'round' }, field: { w: 5, inner: 1.6 }, value: { w: 1.8, dash: '0.1 4.5', cap: 'round' }
};

function cablePath(x1, y1, x2, y2, curve) {
  if (curve === 'straight') return 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2;
  if (curve === 'angular') { const mx = Math.round(x1 + Math.max(16, (x2 - x1) / 2)); return 'M' + x1 + ' ' + y1 + ' H' + mx + ' V' + y2 + ' H' + x2; }
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
}

function Cable({ type = 'signal', d, from, to, curve = 'curved', firing, level, invalid, background = 'var(--fp-bg-0)' }) {
  const path = d || cablePath(from[0], from[1], to[0], to[1], curve);
  const s = CABLE_STYLES[type] || CABLE_STYLES.signal;
  const color = invalid ? 'var(--fp-error)' : PORT_COLORS[type];
  const hasLevel = typeof level === 'number';
  const op = firing || invalid ? 1 : hasLevel ? 0.35 + 0.65 * level : 0.7;
  const haloOp = firing ? 0.22 : hasLevel ? 0.2 * level : 0;
  return (
    <g>
      {haloOp > 0 && <path d={path} fill="none" stroke={color} strokeOpacity={haloOp} strokeWidth={s.w + 6} strokeLinecap="round" />}
      <path d={path} fill="none" stroke={color} strokeOpacity={op} strokeWidth={firing ? s.w + 0.3 : s.w}
        strokeDasharray={invalid ? '3 3' : firing ? undefined : s.dash} strokeLinecap={s.cap || 'butt'} />
      {s.inner && <path d={path} fill="none" stroke={background} strokeWidth={s.inner} />}
    </g>
  );
}

// ports/CableChip

function CableChip({ kind = 'depth', value = 0.5, label, levels = [0.4, 0.7, 0.9, 0.6, 0, 0] }) {
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

// controls/Knob

function Knob({ label, value, defaultValue = 0.5, onChange, mod = 0, format, size = 48, disabled }) {
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

// controls/ParamField

function ParamField({ label, value, defaultValue = 0.5, onChange, display, format, mod = 0, kind = 'field', option, swatches, state, disabled }) {
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

// controls/Segmented

function Segmented({ options = [], value, defaultValue, onChange, size = 'sm' }) {
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

// controls/Toggle

function Toggle({ checked, defaultChecked = false, onChange, label, disabled }) {
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

// controls/Select

function Select({ value, placeholder = 'Choose…', onClick, width = 180, disabled }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={function () { setHover(true); }} onMouseLeave={function () { setHover(false); }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, height: 28, padding: '0 10px', minWidth: width, borderRadius: 6, background: hover && !disabled ? 'var(--fp-bg-3)' : 'var(--fp-bg-2)', border: '1px solid var(--fp-line-2)', fontFamily: 'var(--fp-font-ui)', fontSize: 12, color: value ? 'var(--fp-fg-1)' : 'var(--fp-fg-4)', cursor: disabled ? 'default' : 'pointer', transition: 'background 140ms' }}>
      <span>{value || placeholder}</span><i className="icon-chevron-down" style={{ fontSize: 13, color: 'var(--fp-fg-3)' }} />
    </button>
  );
}

// controls/NumberField

function NumberField({ label, value, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', height: 28, borderRadius: 6, background: 'var(--fp-bg-1)', border: '1px solid var(--fp-line-2)', overflow: 'hidden', fontFamily: 'var(--fp-font-ui)' }}>
      {label && <span style={{ padding: '0 8px', fontSize: 11, color: 'var(--fp-fg-3)' }}>{label}</span>}
      <span style={{ padding: '0 10px', height: '100%', display: 'flex', alignItems: 'center', borderLeft: label ? '1px solid var(--fp-line-1)' : 'none', fontFamily: 'var(--fp-font-mono)', fontSize: 12, color: 'var(--fp-fg-1)', cursor: 'ew-resize', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

// controls/StepGrid

const LEVELS = ['0%', '35%', '68%', '100%'];

function StepGrid({ steps, defaultSteps, onChange, playhead, height = 56 }) {
  const [inner, setInner] = React.useState(steps || defaultSteps || new Array(16).fill(0));
  const s = steps || inner;
  const cycle = function (i) { const n = s.slice(); n[i] = (n[i] + 1) % 4; setInner(n); if (onChange) onChange(n); };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(' + s.length + ', minmax(0, 1fr))', gap: 3, height: height }}>
      {s.map(function (l, i) {
        return (
          <button key={i} onClick={function () { cycle(i); }} aria-label={'Step ' + (i + 1)}
            style={{ height: '100%', border: 0, padding: 0, borderRadius: 3, cursor: 'pointer', background: 'var(--fp-bg-0)', boxShadow: i === playhead ? 'inset 0 0 0 1px var(--fp-fg-1)' : 'inset 0 0 0 1px var(--fp-line-1)', display: 'flex', alignItems: 'flex-end', overflow: 'hidden' }}>
            <span style={{ width: '100%', height: LEVELS[l], background: 'var(--fp-event)', opacity: l === 1 ? 0.45 : 1 }} />
          </button>
        );
      })}
    </div>
  );
}

// controls/Button

const V = {
  primary: { bg: 'var(--fp-fg-1)', hover: 'var(--fp-fg-2)', fg: 'var(--fp-bg-0)', border: 'none', weight: 500 },
  secondary: { bg: 'var(--fp-bg-3)', hover: 'var(--fp-bg-4)', fg: 'var(--fp-fg-1)', border: '1px solid var(--fp-line-2)', weight: 400 },
  ghost: { bg: 'transparent', hover: 'var(--fp-bg-3)', fg: 'var(--fp-fg-2)', border: 'none', weight: 400 }
};

function Button({ variant = 'secondary', icon, disabled, onClick, children, type = 'button' }) {
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

// controls/IconButton

function IconButton({ icon, active, disabled, title, onClick, size = 28 }) {
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

// controls/Kbd

function Kbd({ children }) {
  return (
    <kbd style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, minWidth: 18, height: 18, padding: '0 5px', display: 'inline-grid', placeItems: 'center', borderRadius: 4, background: 'var(--fp-bg-3)', border: '1px solid var(--fp-line-2)', borderBottomWidth: 2, color: 'var(--fp-fg-2)' }}>{children}</kbd>
  );
}

// nodes/Node



/* Geometry for cable endpoints, relative to the node's top-left. */
const NODE_HEADER = 30;
function portY(top, row) { return top + 48 + 22 * row; }
function paramY(top, rows, param) { return top + 54 + 22 * rows + 26 * param; }

function EdgePort({ type, side, top }) {
  const s = PORT_SIZE[type] || [10, 10];
  const pos = { position: 'absolute', top: (top != null ? top : 11) - s[1] / 2, display: 'flex' };
  pos[side] = -Math.ceil(s[0] / 2);
  return <span style={pos}><Port type={type} /></span>;
}

function Node({ title, icon = 'box', led, ledActive = true, selected, status, collapsed, subpatch, meta, locked, rows = [], params = [], children, width = 184, style, onClick }) {
  const err = status && status.kind === 'error';
  const loading = status && status.kind === 'loading';
  const shell = {
    position: 'relative', width: width, background: 'var(--fp-bg-2)', borderRadius: 8, fontFamily: 'var(--fp-font-ui)', color: 'var(--fp-fg-1)',
    border: '1px solid ' + (err ? 'var(--fp-error)' : subpatch || locked ? 'var(--fp-line-2)' : 'var(--fp-line-1)'),
    boxShadow: (selected ? 'var(--fp-ring-select), ' : '') + 'var(--fp-shadow-node)'
  };
  const header = (
    <div style={{ position: 'relative', height: NODE_HEADER, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 10px', borderBottom: collapsed ? 'none' : '1px solid var(--fp-line-1)' }}>
      <i className={'icon-' + (err && status.icon ? status.icon : icon)} style={{ fontSize: 13, color: err ? 'var(--fp-error)' : 'var(--fp-fg-3)' }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      {meta && <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: collapsed ? 'var(--fp-fg-3)' : 'var(--fp-fg-4)' }}>{meta}</span>}
      {locked && <i className="icon-lock" style={{ fontSize: 11, color: 'var(--fp-fg-4)' }} />}
      {led && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fp-' + led + ')', opacity: ledActive ? 1 : 0.35, boxShadow: ledActive ? '0 0 6px var(--fp-' + led + ')' : 'none', transition: 'opacity 120ms' }} />}
      {selected && <i className="icon-ellipsis" style={{ fontSize: 14, color: 'var(--fp-fg-3)' }} />}
      {loading && <span style={{ position: 'absolute', left: 0, bottom: -1, height: 1, width: Math.round((status.progress || 0) * 100) + '%', background: 'var(--fp-fg-2)' }} />}
    </div>
  );
  let body;
  if (collapsed) {
    const r = rows[0] || {};
    body = <div style={Object.assign({}, shell, style)} onClick={onClick}>{r.in && <EdgePort type={r.in.type} side="left" top={15} />}{header}{r.out && <EdgePort type={r.out.type} side="right" top={15} />}</div>;
  } else {
    body = (
      <div style={Object.assign({}, shell, style)} onClick={onClick}>
        {header}
        {err && (
          <div style={{ padding: '8px 10px', background: 'var(--fp-error-soft)', fontSize: 11, lineHeight: '15px', color: 'var(--fp-fg-1)', display: 'grid', gap: 6 }}>
            {status.message}
            {status.action && <span onClick={status.onAction} style={{ fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>{status.action}</span>}
          </div>
        )}
        <div style={{ padding: '6px 0 8px', opacity: err ? 0.45 : 1 }}>
          {rows.map(function (r, i) {
            if (r.divider) return <div key={i} style={{ margin: '4px 12px', borderTop: '1px dashed var(--fp-line-2)' }} />;
            return (
              <div key={i} style={{ position: 'relative', height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 12px', fontSize: 11, color: r.pass ? 'var(--fp-fg-3)' : 'var(--fp-fg-2)' }}>
                {r.in && <EdgePort type={r.in.type} side="left" />}
                <span>{r.in ? r.in.label : ''}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {r.pass && <i className="icon-corner-down-right" style={{ fontSize: 12 }} />}
                  {r.out ? r.out.label : r.hint ? <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: r.hintColor || 'var(--fp-fg-4)' }}>{r.hint}</span> : ''}
                </span>
                {r.out && <EdgePort type={r.out.type} side="right" />}
              </div>
            );
          })}
          {(params.length > 0 || loading) && <div style={{ height: 4 }} />}
          {loading && (
            <div style={{ padding: '2px 8px' }}>
              <div style={{ height: 22, borderRadius: 4, background: 'var(--fp-bg-1)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', fontSize: 11, color: 'var(--fp-fg-3)' }}>
                <i className="icon-loader-circle" style={{ fontSize: 12 }} />{status.message || 'Loading'}
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--fp-font-mono)', color: 'var(--fp-fg-2)' }}>{Math.round((status.progress || 0) * 100)}%</span>
              </div>
            </div>
          )}
          {params.map(function (p, i) {
            return <div key={i} style={{ position: 'relative', padding: '2px 8px' }}>{p.modPort && <EdgePort type="signal" side="left" top={13} />}<ParamField {...p} /></div>;
          })}
          {children && <div style={{ padding: '6px 10px 0' }}>{children}</div>}
        </div>
      </div>
    );
  }
  if (!subpatch) return body;
  return (
    <div style={{ position: 'relative', width: width }}>
      <div style={{ position: 'absolute', top: 4, left: 4, right: -4, bottom: -4, borderRadius: 8, background: 'var(--fp-bg-1)', border: '1px solid var(--fp-line-1)' }} />
      {body}
    </div>
  );
}

// nodes/FamilyChip

const FAMILIES = {
  sources: { label: 'Sources', icon: 'mouse-pointer-2' },
  gestures: { label: 'Gestures', icon: 'hand' },
  time: { label: 'Time and rhythm', icon: 'timer' },
  harmony: { label: 'Harmony', icon: 'music' },
  control: { label: 'Control', icon: 'git-fork' },
  instruments: { label: 'Instruments', icon: 'piano' },
  effects: { label: 'Effects and mix', icon: 'audio-waveform' },
  visual: { label: 'Visual', icon: 'droplets' },
  output: { label: 'Output', icon: 'speaker' },
  subpatch: { label: 'Subpatch', icon: 'layers' }
};

function FamilyChip({ family = 'sources', count, active, onClick }) {
  const f = FAMILIES[family] || FAMILIES.sources;
  return (
    <span onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 10px', borderRadius: 999, background: active ? 'var(--fp-bg-3)' : 'var(--fp-bg-1)', border: '1px solid ' + (active ? 'var(--fp-line-3)' : 'var(--fp-line-1)'), fontFamily: 'var(--fp-font-ui)', fontSize: 12, color: active ? 'var(--fp-fg-1)' : 'var(--fp-fg-2)', cursor: onClick ? 'pointer' : 'default' }}>
      <i className={'icon-' + f.icon} style={{ fontSize: 13, color: 'var(--fp-fg-3)' }} />{f.label}
      {count != null && <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-4)' }}>{count}</span>}
    </span>
  );
}

// overlays/NodePalette


function NodePalette({ items = [], accepts, query, onQueryChange, onPick, limit = 7, width = 360 }) {
  const [inner, setInner] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const q = (query != null ? query : inner).trim().toLowerCase();
  const list = items.filter(function (it) { return !q || (it.name + ' ' + (it.family || '') + ' ' + (it.description || '')).toLowerCase().indexOf(q) >= 0; }).slice(0, limit);
  const onKey = function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(list.length - 1, idx + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(0, idx - 1)); }
    if (e.key === 'Enter' && list[idx] && onPick) onPick(list[idx]);
  };
  return (
    <div style={{ width: width, maxWidth: '100%', background: 'var(--fp-bg-2)', border: '1px solid var(--fp-line-2)', borderRadius: 12, boxShadow: 'var(--fp-shadow-pop)', overflow: 'hidden', fontFamily: 'var(--fp-font-ui)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px', borderBottom: '1px solid var(--fp-line-1)' }}>
        <i className="icon-search" style={{ fontSize: 14, color: 'var(--fp-fg-3)' }} />
        <input autoFocus value={query != null ? query : inner} onKeyDown={onKey} placeholder="Search nodes"
          onChange={function (e) { setInner(e.target.value); setIdx(0); if (onQueryChange) onQueryChange(e.target.value); }}
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--fp-fg-1)', fontFamily: 'var(--fp-font-ui)', fontSize: 13 }} />
        {accepts && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, height: 20, padding: '0 7px', borderRadius: 999, background: 'var(--fp-' + accepts + '-soft)', fontSize: 10, color: PORT_COLORS[accepts], whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
            <span style={{ width: 6, height: 6, background: PORT_COLORS[accepts], transform: 'rotate(45deg)' }} />Accepts {accepts}
          </span>
        )}
      </div>
      <div style={{ padding: 6, display: 'grid', gap: 1, maxHeight: 300, overflow: 'auto' }}>
        {list.map(function (it, i) {
          return (
            <div key={it.name} onMouseEnter={function () { setIdx(i); }} onClick={function () { if (onPick) onPick(it); }}
              style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr) auto', gap: 10, alignItems: 'center', padding: '7px 8px', borderRadius: 6, background: i === idx ? 'var(--fp-bg-3)' : 'transparent', cursor: 'pointer' }}>
              <i className={'icon-' + (it.icon || 'box')} style={{ fontSize: 14, color: 'var(--fp-fg-3)' }} />
              <div style={{ display: 'grid', gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fp-fg-1)' }}>{it.name}</span>
                {it.description && <span style={{ fontSize: 11, color: 'var(--fp-fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.description}</span>}
              </div>
              <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-4)' }}>{it.family}</span>
            </div>
          );
        })}
        {list.length === 0 && <div style={{ padding: '16px 10px', fontSize: 12, color: 'var(--fp-fg-3)' }}>No compatible nodes match.</div>}
      </div>
      <div style={{ display: 'flex', gap: 14, padding: '8px 12px', borderTop: '1px solid var(--fp-line-1)', fontSize: 11, color: 'var(--fp-fg-4)' }}><span>↑↓ move</span><span>↵ insert</span><span>esc close</span></div>
    </div>
  );
}

// overlays/Probe


function Probe({ type = 'signal', title, channel, value, points = [], ticks = [], pinned, footer, fields, width = 300 }) {
  const isSignal = type === 'signal' || type === 'audio' || type === 'field';
  const pts = points.map(function (p, i) { return (i / Math.max(1, points.length - 1) * 280).toFixed(1) + ',' + (60 - p * 56).toFixed(1); }).join(' ');
  return (
    <div style={{ width: width, maxWidth: '100%', background: 'var(--fp-bg-2)', border: '1px solid var(--fp-line-2)', borderRadius: 12, boxShadow: 'var(--fp-shadow-pop)', padding: '12px 14px', display: 'grid', gap: 10, fontFamily: 'var(--fp-font-ui)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Port type={type} ring="var(--fp-bg-2)" />
        <span style={{ fontSize: 12, fontWeight: 500 }}>{title}</span>
        {channel != null && <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-4)' }}>ch {channel}</span>}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--fp-font-mono)', fontSize: isSignal ? 12 : 10, color: isSignal ? PORT_COLORS[type] : 'var(--fp-fg-3)' }}>{value}</span>
        <i className="icon-pin" style={{ fontSize: 13, color: pinned ? 'var(--fp-fg-1)' : 'var(--fp-fg-4)' }} />
      </div>
      {isSignal ? (
        <svg width="100%" height="64" viewBox="0 0 280 64" preserveAspectRatio="none" style={{ display: 'block', borderRadius: 6, background: 'var(--fp-bg-1)' }}>
          <line x1="0" y1="32" x2="280" y2="32" stroke="var(--fp-line-1)" strokeWidth="1" />
          <polyline points={pts} fill="none" stroke={PORT_COLORS[type]} strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      ) : (
        <div style={{ position: 'relative', height: 40, borderRadius: 6, background: 'var(--fp-bg-1)' }}>
          {ticks.map(function (t, i) {
            return <span key={i} style={{ position: 'absolute', left: (t.t * 100) + '%', top: t.ch ? 20 : 8, width: 2, height: 12, borderRadius: 1, background: PORT_COLORS[type], opacity: t.ch ? 0.45 : 1 }} />;
          })}
        </div>
      )}
      {fields && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px', fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-3)' }}>
          {Object.keys(fields).map(function (k) { return <React.Fragment key={k}><span style={{ color: 'var(--fp-fg-4)' }}>{k}</span><span>{fields[k]}</span></React.Fragment>; })}
        </div>
      )}
      {footer && <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-4)' }}>{footer.map(function (f, i) { return <span key={i}>{f}</span>; })}</div>}
    </div>
  );
}

// overlays/AdapterPrompt


function AdapterPrompt({ from = 'event', to = 'signal', options = [], onPick, width = 300 }) {
  const [idx, setIdx] = React.useState(0);
  const cap = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
  return (
    <div style={{ width: width, maxWidth: '100%', background: 'var(--fp-bg-2)', border: '1px solid var(--fp-line-2)', borderRadius: 12, boxShadow: 'var(--fp-shadow-pop)', padding: 14, display: 'grid', gap: 12, fontFamily: 'var(--fp-font-ui)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <Port type={from} /><i className="icon-arrow-right" style={{ fontSize: 12, color: 'var(--fp-fg-4)' }} /><Port type={to} />
        <span style={{ fontWeight: 500, marginLeft: 4 }}>{cap(from)} into {cap(to)}</span>
      </div>
      <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--fp-fg-3)' }}>These types need an adapter. Insert one:</span>
      <div style={{ display: 'grid', gap: 4 }}>
        {options.map(function (o, i) {
          return (
            <div key={o.name} onMouseEnter={function () { setIdx(i); }} onClick={function () { if (onPick) onPick(o); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', borderRadius: 6, background: i === idx ? 'var(--fp-bg-3)' : 'transparent', fontSize: 12, cursor: 'pointer' }}>
              <span>{o.name}</span><span style={{ fontSize: 11, color: 'var(--fp-fg-3)' }}>{o.description}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// overlays/BudgetMeter

function BudgetMeter({ rows = [], title = 'Budget', compact }) {
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

// chrome/Toolbar





function Toolbar({ patchName, saved = true, view = 'Patch', onViewChange, budget, bpm = '112.0', position = '1.1.1', playing = true, onTogglePlay, onShare, onUndo, onRedo, canRedo }) {
  return (
    <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 12, padding: '0 10px 0 14px', background: 'var(--fp-bg-1)', borderBottom: '1px solid var(--fp-line-1)', fontFamily: 'var(--fp-font-ui)', color: 'var(--fp-fg-1)' }}>
      <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap', flexShrink: 0 }}>Flow Patcher</span>
      <span style={{ color: 'var(--fp-fg-4)', flexShrink: 0 }}>/</span>
      <span style={{ fontSize: 13, color: 'var(--fp-fg-2)', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{patchName}</span>
      <span title={saved ? 'Saved' : 'Unsaved changes'} style={{ width: 6, height: 6, borderRadius: '50%', background: saved ? 'var(--fp-fg-4)' : 'var(--fp-warn)', flexShrink: 0 }} />
      <span style={{ marginLeft: 20, flexShrink: 0 }}><Segmented size="md" options={['Patch', 'Play']} value={view} onChange={onViewChange} /></span>
      <span style={{ flex: 1, minWidth: 0 }} />
      {budget && <span style={{ flexShrink: 0 }}><BudgetMeter compact rows={budget} /></span>}
      <div style={{ display: 'flex', alignItems: 'center', height: 28, borderRadius: 6, background: 'var(--fp-bg-0)', border: '1px solid var(--fp-line-1)', overflow: 'hidden', flexShrink: 0, whiteSpace: 'nowrap' }}>
        <button onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'} style={{ width: 30, height: '100%', display: 'grid', placeItems: 'center', border: 0, borderRight: '1px solid var(--fp-line-1)', background: 'transparent', color: 'var(--fp-fg-1)', cursor: 'pointer' }}><i className={playing ? 'icon-pause' : 'icon-play'} style={{ fontSize: 13 }} /></button>
        <span style={{ padding: '0 10px', fontFamily: 'var(--fp-font-mono)', fontSize: 11 }}>{bpm}</span>
        <span style={{ paddingRight: 10, fontFamily: 'var(--fp-font-mono)', fontSize: 11, color: 'var(--fp-fg-4)' }}>{position}</span>
      </div>
      <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
        <IconButton icon="undo-2" title="Undo" onClick={onUndo} />
        <IconButton icon="redo-2" title="Redo" onClick={onRedo} disabled={!canRedo} />
        <Button variant="primary" onClick={onShare}>Share</Button>
      </span>
    </div>
  );
}

// chrome/Canvas


function Canvas({ grid = 'dots', width = '100%', height = 600, cables = [], curve = 'curved', children, onDoubleClick, style }) {
  const bg = grid === 'dots' ? 'radial-gradient(circle, var(--fp-line-1) 1px, transparent 1.3px)'
    : grid === 'lines' ? 'linear-gradient(var(--fp-bg-1) 1px, transparent 1px), linear-gradient(90deg, var(--fp-bg-1) 1px, transparent 1px)' : 'none';
  return (
    <div onDoubleClick={onDoubleClick} style={Object.assign({ position: 'relative', width: width, height: height, overflow: 'hidden', backgroundColor: 'var(--fp-bg-0)', backgroundImage: bg, backgroundSize: '20px 20px', fontFamily: 'var(--fp-font-ui)' }, style)}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
        {cables.map(function (c, i) { return <Cable key={i} curve={curve} {...c} />; })}
      </svg>
      {children}
    </div>
  );
}

// chrome/PreviewPane

function PreviewPane({ title = 'Preview', live = true, width = 248, height = 156, children, onExpand, style }) {
  return (
    <div style={Object.assign({ width: width, borderRadius: 12, overflow: 'hidden', background: 'var(--fp-bg-1)', border: '1px solid var(--fp-line-2)', boxShadow: 'var(--fp-shadow-pop)', fontFamily: 'var(--fp-font-ui)' }, style)}>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--fp-line-1)', fontSize: 11, color: 'var(--fp-fg-2)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? 'var(--fp-audio)' : 'var(--fp-fg-4)' }} />{title}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-4)' }}>{live ? 'live' : 'paused'}</span>
        <i className="icon-maximize-2" onClick={onExpand} style={{ fontSize: 12, color: 'var(--fp-fg-3)', cursor: 'pointer' }} />
      </div>
      <div style={{ height: height, position: 'relative', display: 'grid', placeItems: 'center', background: 'var(--fp-bg-0)' }}>
        {children || <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-3)' }}>performance canvas</span>}
      </div>
    </div>
  );
}

// chrome/PlayStrip

function PlayStrip({ children, style }) {
  return (
    <div style={Object.assign({ display: 'inline-flex', alignItems: 'center', gap: 20, padding: '12px 18px', borderRadius: 12, background: 'oklch(0.205 0.008 265 / 0.72)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid var(--fp-line-2)', boxShadow: 'var(--fp-shadow-pop)', fontFamily: 'var(--fp-font-ui)' }, style)}>
      {children}
    </div>
  );
}

window.FlowPatcher = { PORT_COLORS, PORT_SIZE, Port, CABLE_STYLES, cablePath, Cable, CableChip, Knob, ParamField, Segmented, Toggle, Select, NumberField, StepGrid, Button, IconButton, Kbd, NODE_HEADER, portY, paramY, Node, FAMILIES, FamilyChip, NodePalette, Probe, AdapterPrompt, BudgetMeter, Toolbar, Canvas, PreviewPane, PlayStrip };
})();
