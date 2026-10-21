import * as React from 'react';

/** Labelled mono value box for transport-style numbers (BPM, Division). */
export interface NumberFieldProps {
  label?: string;
  value: React.ReactNode;
  onClick?: () => void;
}

export declare function NumberField(props: NumberFieldProps): React.JSX.Element;
