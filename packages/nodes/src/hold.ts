import type { EngineEvent, NodeDefinition } from '@flow-patcher/engine';
import { channelStepAt, CLAIM_PARAM, IN_PORT, num, PASS_PORTS, payloadOf, pruneTracks, record, runRecognizer, slot, type Steps } from './recognizer';

/** One contact. Plain data. */
interface Contact {
  downAt: number;
  sx: number;
  sy: number;
  /** Charge starts rising at `from`, reaching 1 after `span` seconds. */
  from: number;
  span: number;
  /** The charge at which Release is allowed and the channel claimed; `claimAt` when it gets there, null once claimed or broken. */
  minCharge: number;
  claimAt: number | null;
  last: EngineEvent;
}

/** Charge from `time` on: rising from 0 at `from` over `span` seconds, or 0 when `span` is null. */
interface Step {
  time: number;
  from: number;
  span: number | null;
}

interface HoldState {
  contacts: Record<number, Contact>;
  tracks: Record<number, Steps<Step>>;
}

const chargeOf = (from: number, span: number, t: number) => Math.min(1, Math.max(0, span > 0 ? (t - from) / span : t >= from ? 1 : 0));

/**
 * Gesture recognizer: a contact held still, charging (docs/nodes/gesture-recognizers.md).
 * Flow's Gather (gestures.js `GestureTracker`: `held` and the hold/bloom kinds), one finger.
 *
 * Per channel, while a contact stays within Stillness radius of its down (canvas units,
 * straight line), its Charge signal rises from 0, Delay seconds after the down, to 1 over
 * Charge time (Flow: 250 ms, then 1.1 s). Once a move takes it outside the radius, the
 * charge drops to 0 for the rest of that contact (Flow measured stillness over the whole path,
 * so wandering out and back didn't charge again either).
 *
 * When the charge reaches Min charge (Flow's 0.4, its bloom threshold), Hold claims the
 * channel (ADR 0028) from its own timer, a pure function of the down's time: with no In
 * event to replace, the cancel goes out on Pass at that moment with the contact's latest
 * payload. Release fires on the up if the contact is still charged to at least Min charge,
 * with `charge` (0–1) and `duration` added to the up's payload. A cancel ends the contact
 * with no Release (Flow: a cancelled hold never blooms). Holding emits nothing else, so a
 * held finger doesn't fill the canvas with notes.
 *
 * Charge, per channel, is 0 while not held; channel 0 (or any channel with no history)
 * reads the contact that changed most recently.
 */
export const hold: NodeDefinition = {
  type: 'hold',
  version: 1,
  label: 'Hold',
  category: 'gesture-recognizers',
  description: 'A contact held still: a Charge signal rising while it stays put, claimed once charged, and Release with the charge on lift.',
  ports: [
    IN_PORT,
    ...PASS_PORTS,
    { name: 'release', type: 'event', direction: 'out', label: 'Release' },
    { name: 'charge', type: 'signal', direction: 'out', label: 'Charge' },
  ],
  params: [
    { name: 'radius', kind: 'number', min: 0, max: 0.5, default: 0.025, label: 'Stillness radius' },
    { name: 'delay', kind: 'number', min: 0, max: 2, default: 0.25, unit: 's', label: 'Delay' },
    { name: 'chargeTime', kind: 'number', min: 0, max: 10, default: 1.1, unit: 's', label: 'Charge time' },
    { name: 'minCharge', kind: 'number', min: 0, max: 1, default: 0.4, label: 'Min charge' },
    CLAIM_PARAM,
  ],
  query(ctx) {
    const s = slot<HoldState>(ctx.state, 'hold', () => ({ contacts: {}, tracks: {} }));
    pruneTracks(s.tracks, ctx.t0);
    const due = (): [number, Contact] | null => {
      let best: [number, Contact] | null = null;
      for (const [channel, c] of Object.entries(s.contacts)) if (c.claimAt !== null && (!best || c.claimAt < best[1].claimAt!)) best = [Number(channel), c];
      return best;
    };
    const stop = (channel: number, time: number) => record((s.tracks[channel] ??= []), { time, from: time, span: null });
    return runRecognizer(ctx, {
      nextTimer: () => due()?.[1].claimAt ?? null,
      timer(_time, out) {
        const [channel, contact] = due()!;
        contact.claimAt = null;
        out.claim(channel);
      },
      event(event, phase, out) {
        const { channel, time } = event;
        if (phase === 'down') {
          const from = time + ctx.param('delay', time, channel), span = ctx.param('chargeTime', time, channel), minCharge = ctx.param('minCharge', time, channel);
          s.contacts[channel] = { downAt: time, sx: num(event.x, 0), sy: num(event.y, 0), from, span, minCharge, claimAt: from + minCharge * span, last: event };
          record((s.tracks[channel] ??= []), { time, from, span });
          return;
        }
        const contact = s.contacts[channel];
        if (!contact) return;
        contact.last = event;
        if (phase === 'cancel') {
          delete s.contacts[channel];
          stop(channel, time);
          return;
        }
        const still = contact.span >= 0 && Math.hypot(num(event.x, contact.sx) - contact.sx, num(event.y, contact.sy) - contact.sy) <= ctx.param('radius', time, channel);
        if (!still && contact.span >= 0) {
          // Broken: no charge, no claim, no Release for the rest of this contact.
          contact.span = -1;
          contact.claimAt = null;
          stop(channel, time);
        }
        if (phase !== 'up') return;
        delete s.contacts[channel];
        stop(channel, time);
        if (contact.span < 0) return;
        const charge = chargeOf(contact.from, contact.span, time);
        if (charge >= contact.minCharge && time >= contact.from) out.emit('release', { ...payloadOf(event), charge, duration: time - contact.downAt });
      },
    });
  },
  signal({ state }, _port, t, channel) {
    const tracks = ((state.hold as HoldState | undefined)?.tracks ?? {}) as Record<number, Steps<Step>>;
    const step = channelStepAt(tracks, channel, t);
    return step && step.span !== null ? chargeOf(step.from, step.span, t) : 0;
  },
};
