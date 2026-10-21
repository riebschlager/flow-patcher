import React from 'react';
import { Port, PORT_COLORS } from '../ports/Port.jsx';

export function Probe({ type = 'signal', title, channel, value, points = [], ticks = [], pinned, footer, fields, width = 300 }) {
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
