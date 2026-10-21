import React from 'react';
import { Port, PORT_SIZE } from '../ports/Port.jsx';
import { ParamField } from '../controls/ParamField.jsx';

/* Geometry for cable endpoints, relative to the node's top-left. */
export const NODE_HEADER = 30;
export function portY(top, row) { return top + 48 + 22 * row; }
export function paramY(top, rows, param) { return top + 54 + 22 * rows + 26 * param; }

function EdgePort({ type, side, top }) {
  const s = PORT_SIZE[type] || [10, 10];
  const pos = { position: 'absolute', top: (top != null ? top : 11) - s[1] / 2, display: 'flex' };
  pos[side] = -Math.ceil(s[0] / 2);
  return <span style={pos}><Port type={type} /></span>;
}

export function Node({ title, icon = 'box', led, ledActive = true, selected, status, collapsed, subpatch, meta, locked, rows = [], params = [], children, width = 184, style, onClick }) {
  const err = status && status.kind === 'error';
  const loading = status && status.kind === 'loading';
  const shell = {
    position: 'relative', width: width, background: 'var(--fp-bg-2)', borderRadius: 8, fontFamily: 'var(--fp-font-ui)', color: 'var(--fp-fg-1)',
    border: '1px solid ' + (err ? 'var(--fp-error)' : subpatch || locked ? 'var(--fp-line-2)' : 'var(--fp-line-1)'),
    boxShadow: (selected ? 'var(--fp-ring-select), ' : '') + 'var(--fp-shadow-node)'
  };
  const header = (
    <div style={{ position: 'relative', height: NODE_HEADER, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 10px', borderBottom: collapsed ? 'none' : '1px solid var(--fp-line-1)' }}>
      <i className={'icon-' + (err && status.icon ? status.icon : icon)} style={{ fontSize: 13, color: err ? 'var(--fp-error)' : 'var(--fp-fg-3)' }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      {meta && <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: collapsed ? 'var(--fp-fg-3)' : 'var(--fp-fg-4)' }}>{meta}</span>}
      {locked && <i className="icon-lock" style={{ fontSize: 11, color: 'var(--fp-fg-4)' }} />}
      {led && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fp-' + led + ')', opacity: ledActive ? 1 : 0.35, boxShadow: ledActive ? '0 0 6px var(--fp-' + led + ')' : 'none', transition: 'opacity 120ms' }} />}
      {selected && <i className="icon-ellipsis" style={{ fontSize: 14, color: 'var(--fp-fg-3)' }} />}
      {loading && <span style={{ position: 'absolute', left: 0, bottom: -1, height: 1, width: Math.round((status.progress || 0) * 100) + '%', background: 'var(--fp-fg-2)' }} />}
    </div>
  );
  let body;
  if (collapsed) {
    const r = rows[0] || {};
    body = <div style={Object.assign({}, shell, style)} onClick={onClick}>{r.in && <EdgePort type={r.in.type} side="left" top={15} />}{header}{r.out && <EdgePort type={r.out.type} side="right" top={15} />}</div>;
  } else {
    body = (
      <div style={Object.assign({}, shell, style)} onClick={onClick}>
        {header}
        {err && (
          <div style={{ padding: '8px 10px', background: 'var(--fp-error-soft)', fontSize: 11, lineHeight: '15px', color: 'var(--fp-fg-1)', display: 'grid', gap: 6 }}>
            {status.message}
            {status.action && <span onClick={status.onAction} style={{ fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>{status.action}</span>}
          </div>
        )}
        <div style={{ padding: '6px 0 8px', opacity: err ? 0.45 : 1 }}>
          {rows.map(function (r, i) {
            if (r.divider) return <div key={i} style={{ margin: '4px 12px', borderTop: '1px dashed var(--fp-line-2)' }} />;
            return (
              <div key={i} style={{ position: 'relative', height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 12px', fontSize: 11, color: r.pass ? 'var(--fp-fg-3)' : 'var(--fp-fg-2)' }}>
                {r.in && <EdgePort type={r.in.type} side="left" />}
                <span>{r.in ? r.in.label : ''}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {r.pass && <i className="icon-corner-down-right" style={{ fontSize: 12 }} />}
                  {r.out ? r.out.label : r.hint ? <span style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, color: r.hintColor || 'var(--fp-fg-4)' }}>{r.hint}</span> : ''}
                </span>
                {r.out && <EdgePort type={r.out.type} side="right" />}
              </div>
            );
          })}
          {(params.length > 0 || loading) && <div style={{ height: 4 }} />}
          {loading && (
            <div style={{ padding: '2px 8px' }}>
              <div style={{ height: 22, borderRadius: 4, background: 'var(--fp-bg-1)', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', fontSize: 11, color: 'var(--fp-fg-3)' }}>
                <i className="icon-loader-circle" style={{ fontSize: 12 }} />{status.message || 'Loading'}
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--fp-font-mono)', color: 'var(--fp-fg-2)' }}>{Math.round((status.progress || 0) * 100)}%</span>
              </div>
            </div>
          )}
          {params.map(function (p, i) {
            return <div key={i} style={{ position: 'relative', padding: '2px 8px' }}>{p.modPort && <EdgePort type="signal" side="left" top={13} />}<ParamField {...p} /></div>;
          })}
          {children && <div style={{ padding: '6px 10px 0' }}>{children}</div>}
        </div>
      </div>
    );
  }
  if (!subpatch) return body;
  return (
    <div style={{ position: 'relative', width: width }}>
      <div style={{ position: 'absolute', top: 4, left: 4, right: -4, bottom: -4, borderRadius: 8, background: 'var(--fp-bg-1)', border: '1px solid var(--fp-line-1)' }} />
      {body}
    </div>
  );
}
