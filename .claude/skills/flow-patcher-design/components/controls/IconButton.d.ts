import * as React from 'react';

/** Square icon-only button for toolbars and node headers. Always pass a title. */
export interface IconButtonProps {
  /** Lucide icon name without prefix. */
  icon: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  size?: number;
}

export declare function IconButton(props: IconButtonProps): React.JSX.Element;
