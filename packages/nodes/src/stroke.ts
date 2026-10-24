import type { NodeDefinition } from '@flow-patcher/engine';
import { CLAIM_PARAM, IN_PORT, liveSpeed, motionAt, moveMotion, num, PASS_PORTS, payloadOf, runRecognizer, slot, type Motion } from './recognizer';

interface Contact {
  motion: Motion;
  downAt: number;
  /** Σ |turn| since the down, radians. */
  turning: number;
  started: boolean;
}

/**
 * Gesture recognizer: strokes, classified Silk or Rush (docs/nodes/gesture-recognizers.md).
 * Flow's ribbon and rush kinds (gestures.js `GestureTracker`: a path over 0.012 is a ribbon,
 * Silk in the HUD, and a live speed over 0.87, energy 0.58 × 1.5, makes it a rush).
 *
 * Per channel, the contact's path and speed are Flow's tracker's (moves further than MIN_STEP
 * count; the speed is smoothed and fades when the contact stops). Once its path reaches
 * Minimum length (canvas units) it's a stroke: Stroke claims the channel (ADR 0028) at that
 * move. From that move on, every move that counts goes out on Silk while the stroke's speed
 * is under Speed split (canvas units per second), and on Rush at or over it, carrying the
 * move's payload (without `phase`) with `length` (path so far) and `speed`. So a patch can
 * give a stroke's notes their articulation as Flow's paint did, note by note.
 *
 * End fires on the stroke's up with the summary: `length` (path), `curvature` (total turning
 * per unit of path, radians per canvas unit; 0 for a straight line), `speed` (average: path
 * over duration), `duration`, and `kind`, "rush" when the average speed is at or over Speed
 * split and "silk" otherwise. A cancel ends the stroke without End.
 */
export const stroke: NodeDefinition = {
  type: 'stroke',
  version: 1,
  label: 'Stroke',
  category: 'gesture-recognizers',
  description: 'Strokes: claims a contact once it travels, sorting its moves into Silk and Rush by speed, with End summing up length, curvature and speed.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'silk', type: 'event', direction: 'out', label: 'Silk' },
    { name: 'rush', type: 'event', direction: 'out', label: 'Rush' },
    { name: 'end', type: 'event', direction: 'out', label: 'End' },
  ],
  params: [
    { name: 'minLength', kind: 'number', min: 0, max: 1, default: 0.012, label: 'Minimum length' },
    { name: 'split', kind: 'number', min: 0.01, max: 4, default: 0.87, unit: '/s', label: 'Speed split' },
    CLAIM_PARAM,
  ],
  query(ctx) {
    const contacts = slot<Record<number, Contact>>(ctx.state, 'strokes', () => ({}));
    return runRecognizer(ctx, {
      event(event, phase, out) {
        const { channel, time } = event;
        if (phase === 'down') {
          contacts[channel] = { motion: motionAt(num(event.x, 0), num(event.y, 0), time), downAt: time, turning: 0, started: false };
          return;
        }
        const contact = contacts[channel];
        if (!contact) return;
        if (phase === 'cancel') {
          delete contacts[channel];
          return;
        }
        const m = contact.motion;
        const step = moveMotion(m, num(event.x, m.x), num(event.y, m.y), time);
        if (step) contact.turning += Math.abs(step.turn);
        const split = ctx.param('split', time, channel);
        if (phase === 'up') {
          delete contacts[channel];
          if (!contact.started) return;
          const duration = time - contact.downAt;
          const speed = duration > 0 ? m.path / duration : 0;
          out.emit('end', { ...payloadOf(event), length: m.path, curvature: m.path > 0 ? contact.turning / m.path : 0, speed, duration, kind: speed >= split ? 'rush' : 'silk' });
          return;
        }
        if (!step) return;
        if (!contact.started) {
          if (m.path < ctx.param('minLength', time, channel)) return;
          contact.started = true;
          out.claim(channel);
        }
        const speed = liveSpeed(m, time);
        out.emit(speed >= split ? 'rush' : 'silk', { ...payloadOf(event), length: m.path, speed }, true);
      },
    });
  },
};
