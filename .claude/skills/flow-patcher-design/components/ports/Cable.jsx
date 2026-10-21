import React from 'react';
import { PORT_COLORS } from './Port.jsx';

export const CABLE_STYLES = {
  event: { w: 1.5, dash: '3 3' }, note: { w: 1.5, dash: '8 3' }, signal: { w: 1.5, cap: 'round' },
  audio: { w: 3, cap: 'round' }, field: { w: 5, inner: 1.6 }, value: { w: 1.8, dash: '0.1 4.5', cap: 'round' }
};

export function cablePath(x1, y1, x2, y2, curve) {
  if (curve === 'straight') return 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2;
  if (curve === 'angular') { const mx = Math.round(x1 + Math.max(16, (x2 - x1) / 2)); return 'M' + x1 + ' ' + y1 + ' H' + mx + ' V' + y2 + ' H' + x2; }
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
}

export function Cable({ type = 'signal', d, from, to, curve = 'curved', firing, level, invalid, background = 'var(--fp-bg-0)' }) {
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
