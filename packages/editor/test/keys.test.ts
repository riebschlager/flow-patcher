import { describe, expect, it } from 'vitest';
import { HeldKeys, isApplePlatform, keepsDefault, keyFields, keyStartsAudio, type KeyFields } from '../src/keys';
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

describe('page defaults and platform', () => {
  it('keeps the default for Tab, F-keys and Ctrl or Meta shortcuts, and only those', () => {
    for (const fields of [k('Tab', 'Tab'), k('F1', 'F1'), k('F5', 'F5'), k('F12', 'F12'), k('F24', 'F24'), k('KeyR', 'r', { ctrl: true }), k('KeyR', 'r', { meta: true })]) {
      expect(keepsDefault(fields), `${fields.key} ctrl ${fields.ctrl} meta ${fields.meta}`).toBe(true);
    }
    for (const fields of [k('Space', ' '), k('Slash', '/'), k('KeyF', 'F'), k('KeyF', 'f', { shift: true, alt: true }), k('ArrowDown', 'ArrowDown'), k('Backspace', 'Backspace')]) {
      expect(keepsDefault(fields), fields.key).toBe(false);
    }
  });

  it('knows Apple\'s platforms', () => {
    for (const platform of ['MacIntel', 'Macintosh', 'iPad', 'iPhone']) expect(isApplePlatform(platform), platform).toBe(true);
    for (const platform of ['Win32', 'Linux x86_64', 'Linux armv8l', '']) expect(isApplePlatform(platform), platform).toBe(false);
  });
});

describe('HeldKeys', () => {
  it('releases every key still down on blur, in the order they went down, with no modifiers', () => {
    const keys = new HeldKeys(true);
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
    const keys = new HeldKeys(true);
    keys.press(k('KeyZ', 'z'));
    expect(keys.release(k('KeyZ', 'z', { shift: true }))).toEqual([{ type: 'keyup', ...k('KeyZ', 'z', { shift: true }) }]);
    expect(keys.releaseAll()).toEqual([]);
  });

  it('on macOS Meta\'s keyup releases the other keys still down (it sends them no keyup), modifiers apart', () => {
    const keys = new HeldKeys(true);
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

  it('elsewhere Meta\'s keyup releases only itself: those platforms send the other keyups', () => {
    const keys = new HeldKeys(false);
    keys.press(k('MetaLeft', 'Meta', { meta: true }));
    keys.press(k('KeyZ', 'z', { meta: true }));
    expect(keys.release(k('MetaLeft', 'Meta'))).toEqual([{ type: 'keyup', ...k('MetaLeft', 'Meta') }]);
    expect(keys.size).toBe(1);
    expect(keys.release(k('KeyZ', 'z'))).toEqual([{ type: 'keyup', ...k('KeyZ', 'z') }]);
  });
});
