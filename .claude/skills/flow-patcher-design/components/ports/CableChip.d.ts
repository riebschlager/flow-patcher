import * as React from 'react';

/** A chip that rides a cable midpoint: modulation depth, an inline audio meter, or a rejection message. */
export interface CableChipProps {
  kind?: 'depth' | 'error' | 'meter';
  /** depth: −1…1 modulation depth. */
  value?: number;
  label?: string;
  /** meter: 0–1 bar levels; >0.92 turns warn. */
  levels?: number[];
}

export declare function CableChip(props: CableChipProps): React.JSX.Element;
