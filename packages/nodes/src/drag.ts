import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';
import { CLAIM_PARAM, IN_PORT, num, PASS_PORTS, payloadOf, runRecognizer, slot } from './recognizer';

/** One contact. Plain data. */
interface Contact {
  downAt: number;
  sx: number;
  sy: number;
  started: boolean;
}

/**
 * Gesture recognizer: a contact dragged past a minimum distance (docs/nodes/gesture-recognizers.md).
 * Flow had no drag of its own: its stroke tracker (gestures.js `GestureTracker`) told a touch
 * from a stroke by path length; this keeps that split as a straight-line distance.
 *
 * Per channel: once a contact's move takes it at least Minimum distance (canvas units,
 * straight line) from its down, Drag claims the channel (ADR 0028) and emits Start at that
 * move. Every later move emits Move, and its up emits End. A cancel ends the drag with no End.
 * A contact that never gets that far is left alone: Pass carries all of it.
 *
 * Start, Move and End carry the In event's payload (without `phase`) plus `startX`, `startY`
 * (the down's position), `deltaX`, `deltaY` and `distance` (from the down, straight line) and
 * `duration` (seconds since the down). (`dx` and `dy` stay the source's motion per second.)
 */
export const drag: NodeDefinition = {
  type: 'drag',
  version: 1,
  label: 'Drag',
  category: 'gesture-recognizers',
  description: 'A contact dragged past a minimum distance: claims it, with Start, Move and End events carrying the start point, delta, distance and duration.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'start', type: 'event', direction: 'out', label: 'Start' },
    { name: 'move', type: 'event', direction: 'out', label: 'Move' },
    { name: 'end', type: 'event', direction: 'out', label: 'End' },
  ],
  params: [
    { name: 'minDistance', kind: 'number', min: 0, max: 1, default: 0.025, label: 'Minimum distance' },
    CLAIM_PARAM,
  ],
  query(ctx) {
    const contacts = slot<Record<number, Contact>>(ctx.state, 'drags', () => ({}));
    return runRecognizer(ctx, {
      event(event, phase, out) {
        const { channel, time } = event;
        if (phase === 'down') {
          contacts[channel] = { downAt: time, sx: num(event.x, 0), sy: num(event.y, 0), started: false };
          return;
        }
        const contact = contacts[channel];
        if (!contact) return;
        if (phase === 'cancel') {
          delete contacts[channel];
          return;
        }
        const x = num(event.x, contact.sx), y = num(event.y, contact.sy);
        const fields = (): EngineEvent => {
          const deltaX = x - contact.sx, deltaY = y - contact.sy;
          return { ...payloadOf(event), startX: contact.sx, startY: contact.sy, deltaX, deltaY, distance: Math.hypot(deltaX, deltaY), duration: time - contact.downAt };
        };
        if (phase === 'up') {
          if (contact.started) out.emit('end', fields());
          delete contacts[channel];
          return;
        }
        if (contact.started) out.emit('move', fields(), true);
        else if (Math.hypot(x - contact.sx, y - contact.sy) >= ctx.param('minDistance', time, channel)) {
          contact.started = true;
          out.claim(channel);
          out.emit('start', fields());
        }
      },
    });
  },
};
