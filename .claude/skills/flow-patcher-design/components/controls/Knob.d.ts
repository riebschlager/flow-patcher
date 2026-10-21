import * as React from 'react';

/**
 * The rotary control for the inspector and Play strip. Drag vertically, Shift for fine, double-click or right-click to reset.
 * @startingPoint section="Controls" subtitle="Rotary knob with modulation ring" viewport="700x220"
 */
export interface KnobProps {
  label?: string;
  /** Normalized 0–1. Omit for uncontrolled. */
  value?: number;
  defaultValue?: number;
  onChange?: (v: number) => void;
  /** Live modulation span added above the base value, 0–1. Draws the outer cyan arc. */
  mod?: number;
  format?: (v: number) => string;
  size?: number;
  disabled?: boolean;
}

export declare function Knob(props: KnobProps): React.JSX.Element;
