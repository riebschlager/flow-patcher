import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';
import { claimParam, IN_PORT, num, PASS_PORTS, payloadOf, runRecognizer, slot } from './recognizer';

/** A second tap counts as a double tap within this distance of the first (canvas units): fingers rarely land twice on one spot. */
export const DOUBLE_RADIUS = 0.05;
/** The longest Double gap, seconds: the knob's top. */
export const MAX_GAP = 2;

/** One contact. Plain data. */
interface Contact {
  downAt: number;
  sx: number;
  sy: number;
  /** Strayed past Max movement: neither a tap nor a long press. */
  moved: boolean;
  /** When the long press fires, or null once it can't (moved, fired). */
  longAt: number | null;
  long: boolean;
  /** The latest In event, for the long press's payload. */
  last: EngineEvent;
}

interface LastTap {
  time: number;
  x: number;
  y: number;
}

interface TapState {
  contacts: Record<number, Contact>;
  /** Each channel's latest tap that could start a double tap. */
  taps: Record<number, LastTap>;
}

/**
 * Gesture recognizer: taps, double taps and long presses (docs/nodes/gesture-recognizers.md).
 * Flow's stroke tracker (gestures.js) called a contact that barely moved a "touch" and one
 * held still a "hold"; this splits those into the three events and their knobs.
 *
 * Per channel, a contact that never strays more than Max movement from its down (canvas
 * units, straight line) is:
 * - a **Long press** if it's still down Long press seconds after its down: fired then, at
 *   that time, from the node's own timer (a pure function of the down's time, so it rewinds
 *   and replays like any query). It claims the channel (ADR 0028). With no In event to
 *   replace, its cancel goes out on Pass at the long press's time, with the contact's latest
 *   payload. A long press due at an up's exact time fires first.
 * - a **Tap** if it lifts with an up within Max duration and wasn't a long press. The tap
 *   claims the channel: its up is replaced on Pass by the cancel, so nodes after Pass see
 *   the contact end without its usual end effect.
 * - also a **Double tap** when its down comes within Double gap seconds of the previous tap's
 *   up on the same channel and within DOUBLE_RADIUS of it. Both taps still emit Tap; a third
 *   starts a new pair. Pointer gives a lone finger's taps the same slot, and a mouse keeps its
 *   pointerId, so double taps on one channel are the usual case.
 * A cancel ends a contact with nothing.
 *
 * Events carry the In event's payload (without `phase`) and `duration`, seconds since the
 * down; Double tap also `gap`, seconds from the previous tap's up to this down.
 *
 * Claim is off by default (Tap usually rides along with painting, and claiming would end
 * every such contact early); the claims above happen only with it on (ADR 0028, amended
 * 2026-10-24).
 */
export const tap: NodeDefinition = {
  type: 'tap',
  version: 1,
  label: 'Tap',
  category: 'gesture-recognizers',
  description: 'Taps, double taps and long presses from a contact that barely moves; with Claim on, it takes the contact when it is recognized.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'tap', type: 'event', direction: 'out', label: 'Tap' },
    { name: 'doubleTap', type: 'event', direction: 'out', label: 'Double tap' },
    { name: 'longPress', type: 'event', direction: 'out', label: 'Long press' },
  ],
  params: [
    { name: 'maxMovement', kind: 'number', min: 0, max: 0.5, default: 0.025, label: 'Max movement' },
    { name: 'maxDuration', kind: 'number', min: 0.02, max: 2, default: 0.3, unit: 's', label: 'Max duration' },
    { name: 'longPress', kind: 'number', min: 0.1, max: 5, default: 0.5, unit: 's', label: 'Long press' },
    { name: 'gap', kind: 'number', min: 0.05, max: MAX_GAP, default: 0.3, unit: 's', label: 'Double gap' },
    claimParam(false),
  ],
  query(ctx) {
    const s = slot<TapState>(ctx.state, 'tap', () => ({ contacts: {}, taps: {} }));
    // A tap older than the longest Double gap can't start a double tap any more.
    for (const [channel, last] of Object.entries(s.taps)) if (last.time < ctx.t0 - MAX_GAP) delete s.taps[Number(channel)];
    const due = (): [number, Contact] | null => {
      let best: [number, Contact] | null = null;
      for (const [channel, c] of Object.entries(s.contacts)) if (c.longAt !== null && (!best || c.longAt < best[1].longAt!)) best = [Number(channel), c];
      return best;
    };
    return runRecognizer(ctx, {
      nextTimer: () => due()?.[1].longAt ?? null,
      timer(time, out) {
        const [channel, contact] = due()!;
        contact.longAt = null;
        contact.long = true;
        out.claim(channel);
        out.emit('longPress', { ...payloadOf(contact.last), time, duration: time - contact.downAt });
      },
      event(event, phase, out) {
        const { channel, time } = event;
        if (phase === 'down') {
          const x = num(event.x, 0), y = num(event.y, 0);
          s.contacts[channel] = { downAt: time, sx: x, sy: y, moved: false, longAt: time + ctx.param('longPress', time, channel), long: false, last: event };
          return;
        }
        const contact = s.contacts[channel];
        if (!contact) return;
        contact.last = event;
        if (phase === 'cancel') {
          delete s.contacts[channel];
          return;
        }
        const x = num(event.x, contact.sx), y = num(event.y, contact.sy);
        if (Math.hypot(x - contact.sx, y - contact.sy) > ctx.param('maxMovement', time, channel)) {
          contact.moved = true;
          contact.longAt = null;
        }
        if (phase !== 'up') return;
        delete s.contacts[channel];
        const duration = time - contact.downAt;
        if (contact.moved || contact.long || duration > ctx.param('maxDuration', time, channel)) return;
        out.claim(channel);
        const fields = { ...payloadOf(event), duration };
        out.emit('tap', fields);
        const previous = s.taps[channel];
        if (previous && contact.downAt - previous.time <= ctx.param('gap', time, channel) && Math.hypot(x - previous.x, y - previous.y) <= DOUBLE_RADIUS) {
          out.emit('doubleTap', { ...fields, gap: contact.downAt - previous.time });
          delete s.taps[channel];
        } else s.taps[channel] = { time, x, y };
      },
    });
  },
};
