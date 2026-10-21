import * as React from 'react';

/** Runtime budget readout (fluid step, voices, events per window) with limits marked. */
export interface BudgetMeterProps {
  rows: Array<{ label: string; value: number; display: string; limit?: number; warn?: boolean; icon?: string }>;
  title?: string;
  /** Single-line toolbar form. */
  compact?: boolean;
}

export declare function BudgetMeter(props: BudgetMeterProps): React.JSX.Element;
