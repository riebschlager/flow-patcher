import * as React from 'react';

export type PortType = 'event' | 'note' | 'signal' | 'audio' | 'field' | 'value';

/** An SVG <g> cable between two ports; render inside an <svg> under nodes (Canvas does this for you). */
export interface CableProps {
  type?: PortType;
  /** SVG path. Or pass from/to and curve. */
  d?: string;
  from?: [number, number];
  to?: [number, number];
  curve?: 'curved' | 'angular' | 'straight';
  /** Event fired in the last 120ms — solid with halo. */
  firing?: boolean;
  /** 0–1 signal level; drives opacity and glow. */
  level?: number;
  /** Rejected connection (e.g. cycle without a Delay Edge). */
  invalid?: boolean;
  /** Surface color used to cut the Field double rail. */
  background?: string;
}

export declare function Cable(props: CableProps): React.JSX.Element;
