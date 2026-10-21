import React from 'react';
import { Segmented } from '../controls/Segmented.jsx';
import { IconButton } from '../controls/IconButton.jsx';
import { Button } from '../controls/Button.jsx';
import { BudgetMeter } from '../overlays/BudgetMeter.jsx';

export function Toolbar({ patchName, saved = true, view = 'Patch', onViewChange, budget, bpm = '112.0', position = '1.1.1', playing = true, onTogglePlay, onShare, onUndo, onRedo, canRedo }) {
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
