import React from 'react';
import { Port } from '../ports/Port.jsx';

export function AdapterPrompt({ from = 'event', to = 'signal', options = [], onPick, width = 300 }) {
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
