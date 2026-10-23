// A node's param rows (design system ParamField): number bars, enum menus,
// text with presets, toggles. Every number works the same way: drag, Shift for
// fine, double-click to type, right-click to reset, cable in to modulate.
import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import { CUSTOM_PRESET, isModulatable, presetFor, resolveParam, type NumberParamSpec, type ParamSpec, type ParamValue, type PatchEdit, type TextParamSpec } from '@flow-patcher/engine';
import { paramHandle } from './patch-graph';
import { PORT_SIZE } from './ports';
import { snapTo, startDrag } from './drag-edit';
import { formatParam, keyedValue, parseTyped } from './param-format';
import type { EditorStore } from './store';
import type { LivePatch } from './live';

/** The editor's store, for controls that edit the document. */
export const EditorStoreContext = createContext<EditorStore | null>(null);
/** The running patch, for inline statuses and live modulated values. */
export const LivePatchContext = createContext<LivePatch | null>(null);

/** Pixels of drag that cross a field's whole range is its width; Shift makes it this many times finer. */
const FINE = 5;

/** Where a value sits in a number param's range, 0–1. */
const ratio = (spec: NumberParamSpec, v: number) => (spec.max > spec.min ? (v - spec.min) / (spec.max - spec.min) : 0);

interface RowProps<S extends ParamSpec> {
  node: string;
  spec: S;
  value: ParamValue | undefined;
  /** A cable runs into this param. */
  modulated?: boolean;
}

export function ParamRow(props: RowProps<ParamSpec>) {
  const { spec } = props;
  return (
    <div className="param-row" data-param={spec.name}>
      {spec.kind === 'number' && <NumberField {...props} spec={spec} />}
      {spec.kind === 'enum' && <EnumField {...props} spec={spec} />}
      {spec.kind === 'toggle' && <ToggleField {...props} spec={spec} />}
      {spec.kind === 'text' && <TextField {...props} spec={spec} />}
      {isModulatable(spec) && (
        // Inside the row, so React Flow measures it at the row's height; drawn like a Signal input port.
        <Handle id={paramHandle(spec.name)} type="target" position={Position.Left} className="fp-handle" style={{ width: PORT_SIZE.signal[0], height: PORT_SIZE.signal[1] }} data-port-type="signal">
          <span className="fp-port fp-port--signal" />
        </Handle>
      )}
    </div>
  );
}

const setParam = (node: string, spec: ParamSpec, value: ParamValue): PatchEdit[] => [{ op: 'set-param', node, param: spec.name, value }];

/** Applies a set-param as one undo step, unless it changes nothing. */
function useApply(node: string, spec: ParamSpec, current: ParamValue) {
  const store = useContext(EditorStoreContext);
  return (value: ParamValue) => {
    if (store && value !== current) store.getState().apply(setParam(node, spec, value));
  };
}

function NumberField({ node, spec, value, modulated }: RowProps<NumberParamSpec>) {
  const store = useContext(EditorStoreContext);
  const live = useContext(LivePatchContext);
  const base = resolveParam(spec, value) as number;
  const apply = useApply(node, spec, base);
  const [typing, setTyping] = useState(false);
  const band = useRef<HTMLSpanElement>(null);
  const field = useRef<HTMLDivElement>(null);

  // The modulation band: from the knob to the value the node reads now, redrawn every frame while a cable is in.
  useEffect(() => {
    if (!modulated || !live) return;
    let frame = requestAnimationFrame(function draw() {
      const now = live.paramAt(node, spec.name);
      const el = band.current;
      if (el && now !== undefined) {
        const a = ratio(spec, base), b = ratio(spec, now);
        el.style.left = `${Math.min(a, b) * 100}%`;
        el.style.width = `${Math.abs(b - a) * 100}%`;
        el.dataset.side = b < a ? 'below' : 'above';
        field.current?.setAttribute('data-mod-value', String(now));
      }
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, [modulated, live, node, spec, base]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || typing || !store) return;
    event.preventDefault();
    const width = event.currentTarget.getBoundingClientRect().width || 1;
    startDrag(store, event.nativeEvent, {
      from: base,
      valueAt: (dx, fine) => snapTo(base + (dx / (fine ? width * FINE : width)) * (spec.max - spec.min), spec.min, spec.max, spec.step),
      edits: (v) => setParam(node, spec, v),
    });
  };

  const label = spec.label ?? spec.name;
  if (typing) {
    return (
      <div className="param-field param-field--editing nodrag nopan" data-testid="param-field">
        <span className="param-field__label">{label}</span>
        <TypedNumber className="param-field__input" label={label} initial={base} onCommit={(typed) => apply(resolveParam(spec, typed))} onDone={() => setTyping(false)} />
      </div>
    );
  }
  return (
    <div
      ref={field}
      className="param-field param-field--number nodrag nopan"
      data-testid="param-field"
      data-value={base}
      role="slider"
      aria-label={label}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={base}
      aria-valuetext={formatParam(spec, base)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'Enter') return setTyping(true);
        const next = keyedValue(event.key, event.shiftKey, base, spec.min, spec.max, spec.step);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        apply(next);
      }}
      onDoubleClick={() => setTyping(true)}
      onContextMenu={(event) => {
        event.preventDefault();
        apply(spec.default);
      }}
    >
      <span className="param-field__fill" style={{ width: `${ratio(spec, base) * 100}%` }} />
      {modulated && <span ref={band} className="param-field__mod" data-testid="mod-band" />}
      <span className="param-field__label">{label}</span>
      <span className="param-field__value">{formatParam(spec, base)}</span>
    </div>
  );
}

/**
 * A number typed in place: Enter or leaving the field commits it, Escape throws it away. It commits once, and only
 * when the text changed, so opening it and leaving it as it was doesn't round the value.
 */
export function TypedNumber({ className, label, initial, onCommit, onDone }: { className: string; label: string; initial: number; onCommit: (value: number) => void; onDone: () => void }) {
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    const typed = text === null || text.trim() === String(initial) ? NaN : parseTyped(text);
    if (Number.isFinite(typed)) onCommit(typed);
    onDone();
  };
  return (
    <input
      className={className}
      aria-label={label}
      defaultValue={String(initial)}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') finish(null);
        e.stopPropagation();
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function EnumField({ node, spec, value }: RowProps<Extract<ParamSpec, { kind: 'enum' }>>) {
  const current = resolveParam(spec, value) as string;
  const apply = useApply(node, spec, current);
  const label = spec.label ?? spec.name;
  return (
    <label className="param-field param-field--select nodrag nopan">
      <span className="param-field__label">{label}</span>
      <select className="param-field__select" aria-label={label} value={current} onChange={(e) => apply(e.target.value)}>
        {spec.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <i className="icon-chevron-down param-field__chevron" />
    </label>
  );
}

function ToggleField({ node, spec, value }: RowProps<Extract<ParamSpec, { kind: 'toggle' }>>) {
  const on = resolveParam(spec, value) as boolean;
  const apply = useApply(node, spec, on);
  return (
    <button type="button" role="switch" aria-checked={on} className="param-toggle nodrag nopan" onClick={() => apply(!on)}>
      <span className="param-field__label">{spec.label ?? spec.name}</span>
      <span className={`param-toggle__track${on ? ' param-toggle__track--on' : ''}`}><span className="param-toggle__thumb" /></span>
    </button>
  );
}

function TextField({ node, spec, value }: RowProps<TextParamSpec>) {
  const current = resolveParam(spec, value) as string;
  const apply = useApply(node, spec, current);
  const [draft, setDraft] = useState(current);
  // The document can change under the field (undo, a preset): show it unless the field is being typed in.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(current);
  }, [current]);
  const label = spec.label ?? spec.name;
  const preset = presetFor(spec, draft);
  const error = spec.check?.(current) ?? null;
  const presets = Object.keys(spec.presets ?? {});
  return (
    <div className="param-text">
      <label className={`param-field param-field--text nodrag nopan${error ? ' param-field--invalid' : ''}`}>
        <span className="param-field__label">{label}</span>
        <input
          className="param-field__input"
          aria-label={label}
          value={draft}
          spellCheck={false}
          onFocus={() => (focused.current = true)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setDraft(current);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
            e.stopPropagation();
          }}
          onBlur={() => {
            focused.current = false;
            apply(draft);
          }}
        />
      </label>
      {presets.length > 0 && (
        <label className="param-field param-field--select nodrag nopan">
          <span className="param-field__label">Preset</span>
          <select
            className="param-field__select"
            aria-label={`${label} preset`}
            value={preset}
            onChange={(e) => {
              const text = spec.presets?.[e.target.value];
              if (text === undefined) return;
              setDraft(text);
              apply(text);
            }}
          >
            {presets.map((name) => <option key={name} value={name}>{name}</option>)}
            {preset === CUSTOM_PRESET && <option value={CUSTOM_PRESET} disabled>{CUSTOM_PRESET}</option>}
          </select>
          <i className="icon-chevron-down param-field__chevron" />
        </label>
      )}
      {error && <div className="param-text__error" role="alert">{error}</div>}
    </div>
  );
}
