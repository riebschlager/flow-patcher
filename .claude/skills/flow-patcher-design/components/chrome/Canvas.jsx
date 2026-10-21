import React from 'react';
import { Cable } from '../ports/Cable.jsx';

export function Canvas({ grid = 'dots', width = '100%', height = 600, cables = [], curve = 'curved', children, onDoubleClick, style }) {
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
