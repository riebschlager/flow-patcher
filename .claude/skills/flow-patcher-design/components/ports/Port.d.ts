import * as React from 'react';

export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

/**
 * A typed port glyph. Color and shape both encode the data type; use it anywhere a port type needs to be shown.
 * @startingPoint section="Ports" subtitle="Typed port glyph" viewport="700x200"
 */
export interface PortProps {
  type?: PortType;
  /** Color of the gap ring; match the surface behind the port. */
  ring?: string;
  /** 'target' = compatible drop target while dragging; 'dim' = incompatible. */
  state?: 'idle' | 'target' | 'dim';
  style?: React.CSSProperties;
}

export declare function Port(props: PortProps): React.JSX.Element;
