import { describe, expect, it } from 'vitest';
import { HeldKeys, keyFields, keyStartsAudio, type KeyFields } from '../src/keys';
import { droppedWhileCold } from '../src/live';

const k = (code: string, key: string, fields: Partial<KeyFields> = {}): KeyFields => ({ key, code, repeat: false, shift: false, alt: false, ctrl: false, meta: false, ...fields });

describe('key fields', () => {
  it('takes key, code, repeat and the modifiers from a KeyboardEvent', () => {
    const event = { key: 'A', code: 'KeyA', repeat: true, shiftKey: true, altKey: false, ctrlKey: true, metaKey: false };
    expect(keyFields(event)).toEqual({ key: 'A', code: 'KeyA', repeat: true, shift: true, alt: false, ctrl: true, meta: false });
  });
});

describe('keys and cold audio', () => {
  it('starts audio on a keydown, but not a repeat, a keyup, Escape, Tab or a lone modifier', () => {
    expect(keyStartsAudio({ type: 'keydown', ...k('KeyZ', 'z') })).toBe(true);
    expect(keyStartsAudio({ type: 'keydown', ...k('Space', ' ') })).toBe(true);
    expect(keyStartsAudio({ type: 'keydown', ...k('KeyZ', 'z', { repeat: true }) })).toBe(false);
    expect(keyStartsAudio({ type: 'keyup', ...k('KeyZ', 'z') })).toBe(false);
    for (const [code, key] of [['Escape', 'Escape'], ['Tab', 'Tab'], ['ShiftLeft', 'Shift'], ['MetaRight', 'Meta'], ['ControlLeft', 'Control'], ['AltLeft', 'Alt']]) {
      expect(keyStartsAudio({ type: 'keydown', ...k(code!, key!) }), key).toBe(false);
    }
    expect(keyStartsAudio({ type: 'pointerdown' })).toBe(false);
  });

  it('holds keydowns and keyups while audio is stopped, like a pointerdown', () => {
    expect(droppedWhileCold('keydown')).toBe(false);
    expect(droppedWhileCold('keyup')).toBe(false);
  });
});

describe('HeldKeys', () => {
  it('releases every key still down on blur, in the order they went down, with no modifiers', () => {
    const keys = new HeldKeys();
    keys.press(k('KeyZ', 'z'));
    keys.press(k('Space', ' ', { shift: true }));
    keys.press(k('KeyZ', 'z', { repeat: true }));
    expect(keys.release(k('KeyQ', 'q'))).toEqual([{ type: 'keyup', ...k('KeyQ', 'q') }]);
    expect(keys.size).toBe(2);
    expect(keys.releaseAll()).toEqual([
      { type: 'keyup', ...k('KeyZ', 'z') },
      { type: 'keyup', ...k('Space', ' ') },
    ]);
    expect(keys.releaseAll()).toEqual([]);
  });

  it('a keyup ends its key, so blur doesn\'t release it again', () => {
    const keys = new HeldKeys();
    keys.press(k('KeyZ', 'z'));
    expect(keys.release(k('KeyZ', 'z', { shift: true }))).toEqual([{ type: 'keyup', ...k('KeyZ', 'z', { shift: true }) }]);
    expect(keys.releaseAll()).toEqual([]);
  });

  it('Meta\'s keyup releases the other keys still down (macOS sends them no keyup), modifiers apart', () => {
    const keys = new HeldKeys();
    keys.press(k('ShiftLeft', 'Shift', { shift: true }));
    keys.press(k('MetaLeft', 'Meta', { meta: true, shift: true }));
    keys.press(k('KeyZ', 'z', { meta: true, shift: true }));
    expect(keys.release(k('MetaLeft', 'Meta', { shift: true }))).toEqual([
      { type: 'keyup', ...k('MetaLeft', 'Meta', { shift: true }) },
      { type: 'keyup', ...k('KeyZ', 'z', { shift: true }) },
    ]);
    // Shift is still down, and gets its own keyup.
    expect(keys.size).toBe(1);
    expect(keys.release(k('ShiftLeft', 'Shift'))).toEqual([{ type: 'keyup', ...k('ShiftLeft', 'Shift') }]);
  });
});
