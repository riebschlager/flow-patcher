import React from 'react';

export const PORT_COLORS = {
  event: 'var(--fp-event)', note: 'var(--fp-note)', signal: 'var(--fp-signal)',
  audio: 'var(--fp-audio)', field: 'var(--fp-field)', value: 'var(--fp-value)'
};
export const PORT_SIZE = { event: [9, 9], note: [9, 9], signal: [10, 10], audio: [13, 8], field: [10, 10], value: [10, 10] };

export function Port({ type = 'signal', ring = 'var(--fp-bg-2)', state = 'idle', style }) {
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
