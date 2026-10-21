import * as React from 'react';

/** Floating live preview of the performance canvas in Patch view. */
export interface PreviewPaneProps {
  title?: string;
  live?: boolean;
  width?: number;
  height?: number;
  /** The performance canvas element. */
  children?: React.ReactNode;
  onExpand?: () => void;
  style?: React.CSSProperties;
}

export declare function PreviewPane(props: PreviewPaneProps): React.JSX.Element;
