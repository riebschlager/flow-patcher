import * as React from 'react';
import type { ParamFieldProps } from '../controls/ParamField';

export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

/**
 * A patch node: neutral body, family glyph in the header, typed ports on the edges, params below.
 * @startingPoint section="Nodes" subtitle="Patch node with ports and params" viewport="700x320"
 */
export interface NodeProps {
  title: string;
  /** Lucide icon for the node family (see FAMILIES). */
  icon?: string;
  /** Activity LED color by port type. */
  led?: PortType;
  ledActive?: boolean;
  selected?: boolean;
  status?: { kind: 'error' | 'loading'; message?: string; action?: string; onAction?: () => void; progress?: number; icon?: string };
  collapsed?: boolean;
  subpatch?: boolean;
  /** Small mono text in the header (e.g. '7 nodes', 'GPU'). */
  meta?: string;
  locked?: boolean;
  /** Port rows: input on the left, output on the right, same 22px row. */
  rows?: Array<{ in?: { type: PortType; label: string }; out?: { type: PortType; label: string }; hint?: string; hintColor?: string; pass?: boolean; divider?: boolean }>;
  /** Parameter rows, rendered with ParamField. */
  params?: Array<ParamFieldProps & { modPort?: boolean }>;
  children?: React.ReactNode;
  width?: number;
  style?: React.CSSProperties;
  onClick?: () => void;
}

export declare function Node(props: NodeProps): React.JSX.Element;
