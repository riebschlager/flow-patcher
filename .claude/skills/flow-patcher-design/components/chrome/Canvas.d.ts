import * as React from 'react';
import type { CableProps } from '../ports/Cable';

/**
 * The patch canvas: 20px grid, a cable layer, and absolutely positioned nodes as children.
 * @startingPoint section="Chrome" subtitle="Patch canvas with cables" viewport="700x320"
 */
export interface CanvasProps {
  grid?: 'dots' | 'lines' | 'none';
  width?: number | string;
  height?: number | string;
  /** Cable props; drawn beneath children. */
  cables?: CableProps[];
  curve?: 'curved' | 'angular' | 'straight';
  children?: React.ReactNode;
  onDoubleClick?: () => void;
  style?: React.CSSProperties;
}

export declare function Canvas(props: CanvasProps): React.JSX.Element;
