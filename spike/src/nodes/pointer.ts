import type { NodeType } from '../registry';

/**
 * The performance canvas as events and signals, one channel (the first pointer down).
 * Events are stamped currentTime + the immediate offset (5 ms) and take the immediate path; X and Y hold the latest position.
 */
export const pointer: NodeType = {
  type: 'pointer',
  label: 'Pointer',
  inputs: [],
  outputs: [
    { name: 'down', label: 'Down', type: 'event' },
    { name: 'move', label: 'Move', type: 'event' },
    { name: 'up', label: 'Up', type: 'event' },
    { name: 'x', label: 'X', type: 'signal' },
    { name: 'y', label: 'Y', type: 'signal' },
  ],
  knobs: [],
  create() {
    let active: number | null = null;
    let x = 0.5, y = 0.5;
    return {
      canvas(input) {
        if (input.kind === 'down') {
          if (active !== null) return [];
          active = input.pointerId;
        } else if (input.pointerId !== active) {
          return [];
        }
        x = input.x;
        y = input.y;
        const port = input.kind === 'cancel' ? 'up' : input.kind;
        if (port === 'up') active = null;
        const { pressure, pointerType, inputAt, cold } = input;
        const fields = { channel: 0, x, y, pressure, pointerType };
        // Only a down carries the latency reference, so drag-played moves don't fill the tap log.
        return [{ port, fields: port === 'down' ? { ...fields, inputAt, cold } : fields }];
      },
      signals: { x: () => x, y: () => y },
      set() {},
      dispose() {},
    };
  },
};
