import { useEffect, useRef, useState } from 'react';
import type { PortType } from '@flow-patcher/engine';
import type { AdapterOffer } from './patch-graph';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Offers the adapters that fit an incompatible cable (design system AdapterPrompt). Enter or a click inserts one; Escape or a click elsewhere closes it. */
export function AdapterPrompt({ from, to, options, at, onPick, onClose }: {
  from: PortType;
  to: PortType;
  options: AdapterOffer[];
  at: { x: number; y: number };
  onPick: (offer: AdapterOffer) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('.adapter-prompt__option')?.focus();
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Next task: the pointerup that dropped the cable mustn't count as a click outside.
    const timer = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div ref={box} className="adapter-prompt" role="dialog" aria-label={`${cap(from)} into ${cap(to)}`} data-testid="adapter-prompt" style={{ left: at.x, top: at.y }}>
      <div className="adapter-prompt__head">
        <span className={`fp-port fp-port--${from}`} />
        <i className="icon-arrow-right adapter-prompt__arrow" />
        <span className={`fp-port fp-port--${to}`} />
        <span className="adapter-prompt__title">{cap(from)} into {cap(to)}</span>
      </div>
      <span className="adapter-prompt__copy">These types need an adapter. Insert one:</span>
      <div className="adapter-prompt__list">
        {options.map((offer, i) => (
          <button
            type="button"
            key={offer.definition.type}
            className={`adapter-prompt__option${i === active ? ' adapter-prompt__option--active' : ''}`}
            data-testid="adapter-option"
            onPointerEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => onPick(offer)}
          >
            <span>{offer.definition.label}</span>
            <span className="adapter-prompt__description" title={offer.definition.description}>{offer.definition.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
