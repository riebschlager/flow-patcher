import * as React from 'react';

/** Text button. Primary is near-white on dark: use one per surface at most. */
export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Lucide icon name without prefix. */
  icon?: string;
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  type?: 'button' | 'submit';
}

export declare function Button(props: ButtonProps): React.JSX.Element;
