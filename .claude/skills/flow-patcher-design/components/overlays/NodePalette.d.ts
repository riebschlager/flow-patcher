import * as React from 'react';

export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

/**
 * Searchable node palette opened by Tab, double-click, or dropping a cable on empty canvas.
 * @startingPoint section="Overlays" subtitle="Searchable node palette" viewport="700x420"
 */
export interface NodePaletteProps {
  items: Array<{ name: string; family?: string; icon?: string; description?: string }>;
  /** Port type the dragged cable carries; shows the filter chip. */
  accepts?: PortType;
  query?: string;
  onQueryChange?: (q: string) => void;
  onPick?: (item: any) => void;
  limit?: number;
  width?: number;
}

export declare function NodePalette(props: NodePaletteProps): React.JSX.Element;
