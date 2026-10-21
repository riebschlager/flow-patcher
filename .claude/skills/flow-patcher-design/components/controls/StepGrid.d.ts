import * as React from 'react';

/** Step sequencer lanes. Each step is 0 off, 1 ghost, 2 hit, 3 accent; click cycles. */
export interface StepGridProps {
  steps?: number[];
  defaultSteps?: number[];
  onChange?: (steps: number[]) => void;
  /** Index of the current step. */
  playhead?: number;
  height?: number;
}

export declare function StepGrid(props: StepGridProps): React.JSX.Element;
