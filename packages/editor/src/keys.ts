// The keyboard on the performance canvas, for the Key node (docs/nodes/canvas-sources.md): the payload
// the host sends, which keydowns start audio, and the keys it has seen go down, so it can release them
// when the browser won't send their keyups.
import type { InputFields } from '@flow-patcher/engine';

/** A keydown or keyup's payload (ADR 0029): no channel, since the Key node gives each `code` its own. */
export interface KeyFields {
  key: string;
  code: string;
  repeat: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export const keyFields = (event: Pick<KeyboardEvent, 'key' | 'code' | 'repeat' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): KeyFields => ({
  key: event.key,
  code: event.code,
  repeat: event.repeat,
  shift: event.shiftKey,
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
});

/** Keys that don't start audio: Escape and Tab leave the canvas, and a modifier alone isn't a press
 *  that browsers count as a gesture everywhere. */
const NO_START: ReadonlySet<string> = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Fn', 'CapsLock']);

/**
 * Whether a keydown on the canvas starts audio, as the first pointerdown does (Platform rules): a key
 * press is a user gesture, so the canvas can be played from the keyboard alone. Not a repeat, and not
 * Escape, Tab or a lone modifier.
 */
export const keyStartsAudio = (event: Readonly<InputFields>): boolean =>
  event.type === 'keydown' && event.repeat !== true && typeof event.key === 'string' && !NO_START.has(event.key);

/**
 * Whether a keydown on the canvas keeps its page default while a Key is in the patch: Tab (it moves
 * focus), the function keys (F1–F24: reload, devtools, fullscreen) and Ctrl or Meta shortcuts. Every
 * other key loses it, so Space doesn't scroll and Firefox's quick find doesn't open.
 */
export const keepsDefault = (fields: Readonly<KeyFields>): boolean => fields.key === 'Tab' || /^F\d+$/.test(fields.key) || fields.ctrl || fields.meta;

/** Whether `navigator.platform` is Apple's (macOS, or iPadOS with a keyboard), where Cmd swallows keyups. */
export const isApplePlatform = (platform: string): boolean => /^(Mac|iPhone|iPad|iPod)/.test(platform);

/** Codes of the modifier keys, which get their own keyups even while Meta is held. */
const MODIFIER_CODES: ReadonlySet<string> = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn']);

/**
 * The keys down on the canvas, as the host saw them, so it can send the keyups the browser won't:
 * - On blur (Escape, Tab, a click elsewhere, switching windows) the canvas gets no more keyups, so every
 *   key still down is released then, or Key's Held would stick at 1.
 * - On macOS, keys released while Meta (Cmd) is held send no keyup. So there (`apple`), when Meta comes
 *   up, every other key still down is released too, modifiers apart: a key held across a Cmd tap is cut
 *   short. Other platforms send those keyups, so Meta's keyup releases only itself.
 * The keyups it makes carry the keydown's key and code, with `repeat` false.
 */
export class HeldKeys {
  private readonly down = new Map<string, KeyFields>();

  /** `apple`: the platform is macOS (or iPadOS), whose Cmd swallows keyups (`isApplePlatform`). */
  constructor(private readonly apple: boolean) {}

  /** A keydown: an auto-repeat leaves the key as it was. */
  press(fields: KeyFields): void {
    if (!fields.repeat) this.down.set(fields.code, fields);
  }

  /** A keyup: the keyup events to send, its own first, then the keys Meta's keyup releases. */
  release(fields: KeyFields): InputFields[] {
    this.down.delete(fields.code);
    const out: InputFields[] = [{ type: 'keyup', ...fields, repeat: false }];
    if (this.apple && (fields.code === 'MetaLeft' || fields.code === 'MetaRight')) {
      const modifiers = { shift: fields.shift, alt: fields.alt, ctrl: fields.ctrl, meta: false };
      for (const [code, held] of [...this.down]) {
        if (MODIFIER_CODES.has(code)) continue;
        this.down.delete(code);
        out.push({ type: 'keyup', ...held, ...modifiers, repeat: false });
      }
    }
    return out;
  }

  /** Every key still down, released in the order they went down, with no modifiers held: on blur. */
  releaseAll(): InputFields[] {
    const out: InputFields[] = [...this.down.values()].map((held) => ({ type: 'keyup', ...held, repeat: false, shift: false, alt: false, ctrl: false, meta: false }));
    this.down.clear();
    return out;
  }

  get size(): number {
    return this.down.size;
  }
}
