import * as React from 'react';

/** On/off switch for boolean parameters. */
export interface ToggleProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (v: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}

export declare function Toggle(props: ToggleProps): React.JSX.Element;
