import * as React from 'react';

export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

/** Pinned port probe: a scope for Signals, an event timeline for Events and Notes. */
export interface ProbeProps {
  type?: PortType;
  title: string;
  channel?: number;
  value?: React.ReactNode;
  /** Signal history, 0–1. */
  points?: number[];
  /** Event history: t 0–1 across the window, ch 0/1 for lane. */
  ticks?: Array<{ t: number; ch?: number }>;
  pinned?: boolean;
  fields?: Record<string, React.ReactNode>;
  footer?: React.ReactNode[];
  width?: number;
}

export declare function Probe(props: ProbeProps): React.JSX.Element;
