import React from 'react';

export function Kbd({ children }) {
  return (
    <kbd style={{ fontFamily: 'var(--fp-font-mono)', fontSize: 10, minWidth: 18, height: 18, padding: '0 5px', display: 'inline-grid', placeItems: 'center', borderRadius: 4, background: 'var(--fp-bg-3)', border: '1px solid var(--fp-line-2)', borderBottomWidth: 2, color: 'var(--fp-fg-2)' }}>{children}</kbd>
  );
}
