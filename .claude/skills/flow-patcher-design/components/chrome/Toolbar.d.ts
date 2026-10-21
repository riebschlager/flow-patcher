import * as React from 'react';
import type { BudgetMeterProps } from '../overlays/BudgetMeter';

/** The 44px editor top bar: patch name, Patch/Play switch, budget, transport, undo/redo, Share. */
export interface ToolbarProps {
  patchName: string;
  saved?: boolean;
  view?: 'Patch' | 'Play';
  onViewChange?: (v: string) => void;
  budget?: BudgetMeterProps['rows'];
  bpm?: string;
  position?: string;
  playing?: boolean;
  onTogglePlay?: () => void;
  onShare?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canRedo?: boolean;
}

export declare function Toolbar(props: ToolbarProps): React.JSX.Element;
