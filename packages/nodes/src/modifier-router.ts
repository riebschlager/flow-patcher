import type { EngineEvent, NodeDefinition, ParamSpec, PortSpec } from '@flow-patcher/engine';
import { addPass, nonEmpty, PASS_PORTS, routeContacts } from './switch';

/** Routed outputs, checked in order. */
export const ROUTER_OUTPUTS = 4;

/**
 * What a term matches: a button by its bit in `buttons` (held) or its number in `button` (the one
 * that changed, as on a down, an up or a click), or a modifier key by its field.
 */
const BUTTONS: Record<string, { bit: number; button: number }> = {
  left: { bit: 1, button: 0 },
  right: { bit: 2, button: 2 },
  middle: { bit: 4, button: 1 },
  back: { bit: 8, button: 3 },
  forward: { bit: 16, button: 4 },
  eraser: { bit: 32, button: 5 },
};
const MODIFIERS = ['shift', 'alt', 'ctrl', 'meta'];
export const ROUTER_TERMS = [...Object.keys(BUTTONS), ...MODIFIERS];

/** A route: alternatives (any one matches), each a set of terms that must all hold. */
type Route = string[][];

/**
 * Parses a route's text: alternatives split by commas, terms in one joined by `+`, case and
 * spaces ignored. "right, shift" is the right button or Shift; "ctrl+shift" both keys. Empty
 * alternatives are skipped, so empty text never matches. Unknown terms are reported in `unknown`.
 */
export function parseRoute(text: string): { route: Route; unknown: string[] } {
  const route: Route = [];
  const unknown: string[] = [];
  for (const alternative of text.toLowerCase().split(',')) {
    const terms = alternative.split('+').map((t) => t.trim());
    if (terms.every((t) => t === '')) continue;
    for (const term of terms) if (!ROUTER_TERMS.includes(term)) unknown.push(term === '' ? '(empty)' : term);
    route.push(terms);
  }
  return { route: unknown.length ? [] : route, unknown };
}

export function routeError(text: string): string | null {
  const { unknown } = parseRoute(text);
  return unknown.length ? `Unknown: ${unknown.join(', ')}. Use ${ROUTER_TERMS.join(', ')}; "," for or, "+" for and.` : null;
}

/** A modifier field as held: true, or a finite non-zero number (a recorded 1). */
const held = (value: unknown) => value === true || (typeof value === 'number' && Number.isFinite(value) && value !== 0);

function termHolds(event: EngineEvent, term: string): boolean {
  const button = BUTTONS[term];
  if (!button) return held(event[term]);
  const { buttons } = event;
  if (typeof buttons === 'number' && Number.isInteger(buttons) && buttons > 0 && (buttons & button.bit) !== 0) return true;
  return event.button === button.button;
}

export const matches = (event: EngineEvent, route: Route): boolean => route.some((terms) => terms.every((term) => termHolds(event, term)));

const ROUTE_PRESETS: Readonly<Record<string, string>> = {
  None: '',
  'Right button': 'right',
  'Right button or Shift': 'right, shift',
  'Middle button': 'middle',
  'Pen eraser': 'eraser',
  Shift: 'shift',
  Alt: 'alt',
  Ctrl: 'ctrl',
  Meta: 'meta',
};

/** Flow's modes as defaults: right-drag or Shift → Out 1 (Conduct), Alt → Out 2 (Space), the rest → Pass (Paint). */
const DEFAULTS = ['right, shift', 'alt', '', ''];

/**
 * Gesture recognizer: routes events by button or modifier (docs/nodes/gesture-recognizers.md),
 * the mapping table being one text per output. A contact's `down` is checked against Route 1,
 * then 2, 3 and 4, and goes to the first output whose route it matches, or to Pass when none
 * does. Its later `move`, `up` and `cancel` follow it there until it ends (ADR 0028), so
 * pressing Shift mid-drag doesn't move it. Events outside a contact (hovers, Click's and
 * Wheel's events, which have no `phase`) are checked on their own fields.
 *
 * A term matches a button held in `buttons` or named by `button` (left, right, middle, back,
 * forward, eraser), or a modifier key held (shift, alt, ctrl, meta). Touches and pens report the
 * left button while down; a pen's barrel button is right. Events pass unchanged.
 *
 * Pass carries what no route took, in the same tagged shape, split by phase on Pass Down, Move,
 * Up and Cancel. The decision is made at the `down`, before anything from the contact has gone
 * out of Pass, so a routed contact needs no claim cancel: it never appears on Pass at all.
 *
 * Flow's tool modes become cables with it (ADR 0006): Pointer's All into In, Out 1 into the
 * Conduct chain, Out 2 into Space, and Pass into painting.
 */
export const modifierRouter: NodeDefinition = {
  type: 'modifier-router',
  version: 1,
  label: 'Modifier Router',
  category: 'gesture-recognizers',
  description: 'Routes each contact by button or modifier key: the first route its down matches, else Pass. A contact keeps its output until it ends.',
  ports: [
    { name: 'in', type: 'event', direction: 'in', label: 'In' },
    ...Array.from({ length: ROUTER_OUTPUTS }, (_, i): PortSpec => ({ name: `out${i + 1}`, type: 'event', direction: 'out', label: `Out ${i + 1}` })),
    ...PASS_PORTS,
  ],
  params: DEFAULTS.map((text, i): ParamSpec => ({ name: `route${i + 1}`, kind: 'text', default: text, label: `Route ${i + 1}`, presets: ROUTE_PRESETS, check: routeError })),
  query({ inputs, state, params }) {
    const routes = Array.from({ length: ROUTER_OUTPUTS }, (_, i) => {
      const text = params[`route${i + 1}`];
      return parseRoute(typeof text === 'string' ? text : '').route;
    });
    const pick = (event: EngineEvent) => routes.findIndex((route) => matches(event, route)) + 1;
    const out: Record<string, EngineEvent[]> = {};
    const pass: EngineEvent[] = [];
    for (const { event, route } of routeContacts(state, inputs.in ?? [], pick)) {
      if (route === 0) pass.push(event);
      else (out[`out${route}`] ??= []).push(event);
    }
    addPass(out, pass);
    return nonEmpty(out);
  },
};
