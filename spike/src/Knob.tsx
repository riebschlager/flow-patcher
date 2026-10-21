import { useRef } from 'react';
import type { KnobDef } from './registry';

// Knob position is 0–1; the knob's curve maps it to a value.
const toValue = (k: KnobDef, p: number) =>
  k.curve === 'log' ? k.min * Math.pow(k.max / k.min, p) : k.min + (k.max - k.min) * p;
const toPos = (k: KnobDef, v: number) =>
  k.curve === 'log' ? Math.log(v / k.min) / Math.log(k.max / k.min) : (v - k.min) / (k.max - k.min);

const format = (k: KnobDef, v: number) =>
  `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}${k.unit ? ` ${k.unit}` : ''}`;

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
    onChange(toValue(knob, next));
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
