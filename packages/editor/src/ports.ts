import type { PortType } from '@flow-patcher/engine';

/** Port colors decide what can connect to what at a glance (design.md, Core concepts). */
export const PORT_COLORS: Record<PortType, string> = {
  event: '#f5c542',
  note: '#ff8a5c',
  signal: '#5cc8ff',
  audio: '#7ee081',
  field: '#c08cff',
  value: '#b0b6c3',
};
