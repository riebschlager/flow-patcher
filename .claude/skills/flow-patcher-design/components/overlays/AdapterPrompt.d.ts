import * as React from 'react';

export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

/** Shown when a cable is dropped on an incompatible port; offers the matching adapters. */
export interface AdapterPromptProps {
  from?: PortType;
  to?: PortType;
  options: Array<{ name: string; description?: string }>;
  onPick?: (o: any) => void;
  width?: number;
}

export declare function AdapterPrompt(props: AdapterPromptProps): React.JSX.Element;
