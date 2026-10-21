import React from 'react';

export function PreviewPane({ title = 'Preview', live = true, width = 248, height = 156, children, onExpand, style }) {
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
