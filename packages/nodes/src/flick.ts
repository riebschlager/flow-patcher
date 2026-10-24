import type { NodeDefinition } from '@flow-patcher/engine';
import { CLAIM_PARAM, IN_PORT, liveSpeed, motionAt, moveMotion, num, PASS_PORTS, payloadOf, runRecognizer, slot, type Motion } from './recognizer';

/** The up must come within this many seconds of the last move that counted (Flow: 140 ms), so a stroke that stopped before lifting isn't a flick. */
export const MAX_PAUSE = 0.14;

/**
 * Gesture recognizer: a contact released while moving fast (docs/nodes/gesture-recognizers.md).
 * Flow's Spark (gestures.js `GestureTracker.end`: speed > 0.9 within 140 ms of the last move).
 *
 * Per channel, the contact's speed is Flow's: each move further than MIN_STEP blends its own
 * speed (step length over its time, clamped to 8–120 ms, capped at MAX_SPEED) 40% into the
 * running speed, which fades once the contact stops moving (after 35 ms, over 170 ms). The
 * up's own position counts as a last move. If the speed at the up is over Speed threshold
 * (canvas units per second) and the up comes within MAX_PAUSE of the last move, Flick fires at
 * the up and claims the channel (ADR 0028): the up is replaced on Pass by the cancel, so
 * nodes after Pass don't give the contact its usual end. A cancel never flicks.
 *
 * Flick carries the up's payload (without `phase`) with `angle` (the last step's direction,
 * radians, atan2(dy, dx): 0 right, π/2 down) and `speed` (the faded speed at the up). The
 * speed comes from the stream's positions and times, not the source's own `speed`, so it is
 * the same behind any recognizer on Pass.
 */
export const flick: NodeDefinition = {
  type: 'flick',
  version: 1,
  label: 'Flick',
  category: 'gesture-recognizers',
  description: 'A contact released while moving fast: claims its release, with Flick carrying the direction and speed.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'flick', type: 'event', direction: 'out', label: 'Flick' },
  ],
  params: [
    { name: 'threshold', kind: 'number', min: 0.05, max: 4, default: 0.9, unit: '/s', label: 'Speed threshold' },
    CLAIM_PARAM,
  ],
  query(ctx) {
    const motions = slot<Record<number, Motion>>(ctx.state, 'flicks', () => ({}));
    return runRecognizer(ctx, {
      event(event, phase, out) {
        const { channel, time } = event;
        if (phase === 'down') {
          motions[channel] = motionAt(num(event.x, 0), num(event.y, 0), time);
          return;
        }
        const m = motions[channel];
        if (!m) return;
        if (phase === 'cancel') {
          delete motions[channel];
          return;
        }
        moveMotion(m, num(event.x, m.x), num(event.y, m.y), time);
        if (phase !== 'up') return;
        delete motions[channel];
        const speed = liveSpeed(m, time);
        if (m.path > 0 && speed > ctx.param('threshold', time, channel) && time - m.time < MAX_PAUSE) {
          out.claim(channel);
          out.emit('flick', { ...payloadOf(event), angle: m.heading, speed });
        }
      },
    });
  },
};
