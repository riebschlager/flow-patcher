import React from 'react';

export const FAMILIES = {
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

export function FamilyChip({ family = 'sources', count, active, onClick }) {
  const f = FAMILIES[family] || FAMILIES.sources;
  return (
    <span onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 10px', borderRadius: 999, background: active ? 'var(--fp-bg-3)' : 'var(--fp-bg-1)', border: '1px solid ' + (active ? 'var(--fp-line-3)' : 'var(--fp-line-1)'), fontFamily: 'var(--fp-font-ui)', fontSize: 12, color: active ? 'var(--fp-fg-1)' : 'var(--fp-fg-2)', cursor: onClick ? 'pointer' : 'default' }}>
      <i className={'icon-' + f.icon} style={{ fontSize: 13, color: 'var(--fp-fg-3)' }} />{f.label}
      {count != null && <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: 'var(--fp-fg-4)' }}>{count}</span>}
    </span>
  );
}
