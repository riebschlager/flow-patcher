import * as React from 'react';

/** Menu trigger for long option lists (instruments, scales). Opens a popover you supply. */
export interface SelectProps {
  value?: string;
  placeholder?: string;
  onClick?: () => void;
  width?: number;
  disabled?: boolean;
}

export declare function Select(props: SelectProps): React.JSX.Element;
