import React from 'react';
import { PORT_COLORS } from '../ports/Port.jsx';

export function NodePalette({ items = [], accepts, query, onQueryChange, onPick, limit = 7, width = 360 }) {
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
