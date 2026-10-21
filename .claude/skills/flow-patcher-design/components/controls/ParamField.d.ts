import * as React from 'react';

/** The in-node form of a knob: a 22px bar field. Drag horizontally, Shift for fine, double-click to reset. */
export interface ParamFieldProps {
  label?: string;
  value?: number;
  defaultValue?: number;
  onChange?: (v: number) => void;
  /** Overrides the formatted value text. */
  display?: string;
  format?: (v: number) => string;
  /** Live modulation span, 0–1; draws a cyan band. */
  mod?: number;
  kind?: 'field' | 'select' | 'swatches';
  option?: string;
  swatches?: string[];
  state?: 'hover' | 'editing';
  disabled?: boolean;
  /** Used by Node: show a signal modulation port on the left edge. */
  modPort?: boolean;
}

export declare function ParamField(props: ParamFieldProps): React.JSX.Element;
