import * as React from 'react';

/** The blurred floating strip of pinned knobs in Play view. The only blurred surface in the system. */
export interface PlayStripProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export declare function PlayStrip(props: PlayStripProps): React.JSX.Element;
