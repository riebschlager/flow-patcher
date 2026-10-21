import React from 'react';

const LEVELS = ['0%', '35%', '68%', '100%'];

export function StepGrid({ steps, defaultSteps, onChange, playhead, height = 56 }) {
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
