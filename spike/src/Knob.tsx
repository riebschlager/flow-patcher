import { useRef } from 'react';
import type { KnobDef, TextDef } from './registry';

// Knob position is 0–1; the knob's curve maps it to a value.
const toValue = (k: KnobDef, p: number) => {
  const v = k.curve === 'log' ? k.min * Math.pow(k.max / k.min, p) : k.min + (k.max - k.min) * p;
  return k.step ? Math.round(v / k.step) * k.step : v;
};
const toPos = (k: KnobDef, v: number) =>
  k.curve === 'log' ? Math.log(v / k.min) / Math.log(k.max / k.min) : (v - k.min) / (k.max - k.min);

const format = (k: KnobDef, v: number) =>
  `${v >= 100 || k.step ? v.toFixed(0) : v.toFixed(2)}${k.unit ? ` ${k.unit}` : ''}`;

const SWEEP = 270; // degrees of travel
const R = 15;
const arc = (p: number) => {
  const a = ((-135 + SWEEP * p) * Math.PI) / 180;
  return [20 + R * Math.sin(a), 20 - R * Math.cos(a)];
};
const arcPath = (p: number) => {
  const [x0, y0] = arc(0), [x1, y1] = arc(p);
  return `M ${x0} ${y0} A ${R} ${R} 0 ${SWEEP * p > 180 ? 1 : 0} 1 ${x1} ${y1}`;
};

/** Drag up/down to turn (Shift for fine), double-click to reset. Works with mouse, pen and touch. */
export function Knob({ knob, value, onChange }: { knob: KnobDef; value: number; onChange: (v: number) => void }) {
  const drag = useRef<{ id: number; y: number; pos: number } | null>(null);
  const pos = Math.min(1, Math.max(0, toPos(knob, value)));

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0 || drag.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y: e.clientY, pos };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    const pixels = e.shiftKey ? 800 : 160; // pixels for the full sweep
    const next = Math.min(1, Math.max(0, drag.current.pos + (drag.current.y - e.clientY) / pixels));
    // Rebase so switching Shift mid-drag doesn't jump.
    drag.current = { ...drag.current, y: e.clientY, pos: next };
    const value = toValue(knob, next);
    if (value !== toValue(knob, pos)) onChange(value);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  return (
    <div className="knob nodrag nopan">
      <svg
        width={40}
        height={40}
        className="knob__dial"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onDoubleClick={() => onChange(knob.default)}
        data-knob={knob.name}
      >
        <path d={arcPath(1)} className="knob__track" />
        {pos > 0.001 && <path d={arcPath(pos)} className="knob__fill" />}
        <circle cx={arc(pos)[0]} cy={arc(pos)[1]} r={3} className="knob__thumb" />
      </svg>
      <span className="knob__label">{knob.label}</span>
      <span className="knob__value">{format(knob, value)}</span>
    </div>
  );
}

/** A text param. Every keystroke is kept in the node; the instance only gets text that passes the check. */
export function TextParam({ def, value, onChange }: { def: TextDef; value: string; onChange: (v: string) => void }) {
  const error = def.check?.(value) ?? null;
  return (
    <label className={`text nodrag nopan${error ? ' text--error' : ''}`}>
      <span className="knob__label">{def.label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} data-text={def.name} />
      {error && <span className="text__error">{error}</span>}
    </label>
  );
}

/** A knob with options renders as a menu; its value is the option's index. */
export function Menu({ knob, value, onChange }: { knob: KnobDef; value: number; onChange: (v: number) => void }) {
  return (
    <label className="menu nodrag nopan">
      <span className="knob__label">{knob.label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} data-knob={knob.name}>
        {knob.options!.map((option, i) => <option key={option} value={i}>{option}</option>)}
      </select>
    </label>
  );
}
