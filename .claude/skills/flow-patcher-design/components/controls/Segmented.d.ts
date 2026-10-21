import * as React from 'react';

/** Mutually exclusive choice of 2–6 short options (LFO shape, Patch/Play, tool mode). */
export interface SegmentedProps {
  options: string[];
  value?: string;
  defaultValue?: string;
  onChange?: (v: string) => void;
  size?: 'sm' | 'md';
}

export declare function Segmented(props: SegmentedProps): React.JSX.Element;
