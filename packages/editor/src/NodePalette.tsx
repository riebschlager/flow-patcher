import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { NodeDefinition, PortType } from '@flow-patcher/engine';
import { FAMILY_ICONS, FAMILY_LABELS } from './ports';

export interface PaletteItem {
  definition: NodeDefinition;
  /** Why it can't be picked, such as a unique type already in the patch. */
  disabled?: string;
}

const LIMIT = 8;

const iconOf = (definition: NodeDefinition) => (definition.type === 'output' ? 'speaker' : FAMILY_ICONS[definition.category]);

/** The searchable node palette (design system NodePalette): Tab, double-click, or a cable dropped on empty canvas. */
export function NodePalette({ items, accepts, at, onPick, onClose }: {
  items: readonly PaletteItem[];
  /** The type of the cable being dropped, when the list is filtered to nodes that take it. */
  accepts?: PortType;
  /** Top-left corner, in px within the graph area. */
  at: { x: number; y: number };
  onPick: (definition: NodeDefinition) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  // Opened near an edge, it moves in so all of it shows.
  useLayoutEffect(() => {
    const element = box.current, area = element?.offsetParent;
    if (!element || !(area instanceof HTMLElement)) return;
    const margin = 8;
    setPlace({
      x: Math.max(margin, Math.min(at.x, area.clientWidth - element.offsetWidth - margin)),
      y: Math.max(margin, Math.min(at.y, area.clientHeight - element.offsetHeight - margin)),
    });
  }, [at]);
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const list = items
    .filter(({ definition: d }) => !q || `${d.label} ${FAMILY_LABELS[d.category]} ${d.description}`.toLowerCase().includes(q))
    .slice(0, LIMIT);
  const active = Math.min(index, list.length - 1);
  const pick = (item: PaletteItem | undefined) => item && !item.disabled && onPick(item.definition);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') setIndex(Math.min(list.length - 1, active + 1));
    else if (event.key === 'ArrowUp') setIndex(Math.max(0, active - 1));
    else if (event.key === 'Enter') pick(list[active]);
    else if (event.key === 'Escape') onClose();
    else return;
    event.preventDefault();
  };

  return (
    <div ref={box} className="palette nodrag nowheel" data-testid="node-palette" style={{ left: place.x, top: place.y }} role="dialog" aria-label="Add node">
      <div className="palette__search">
        <i className="icon-search palette__search-icon" />
        <input
          className="palette__input"
          autoFocus
          value={query}
          placeholder="Search nodes"
          aria-label="Search nodes"
          onKeyDown={onKey}
          onBlur={onClose}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
        />
        {accepts && (
          <span className={`palette__accepts palette__accepts--${accepts}`} data-testid="palette-accepts">
            <span className="palette__accepts-mark" />Accepts {accepts}
          </span>
        )}
      </div>
      <div className="palette__list" role="listbox">
        {list.map((item, i) => (
          <div
            key={item.definition.type}
            role="option"
            aria-selected={i === active}
            aria-disabled={item.disabled !== undefined}
            title={item.disabled}
            data-node-type={item.definition.type}
            className={`palette__item${i === active ? ' palette__item--active' : ''}${item.disabled ? ' palette__item--disabled' : ''}`}
            onMouseEnter={() => setIndex(i)}
            // Before the input's blur closes the palette.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(item)}
          >
            <i className={`icon-${iconOf(item.definition)} palette__item-icon`} />
            <span className="palette__item-text">
              <span className="palette__item-name">{item.definition.label}</span>
              <span className="palette__item-description">{item.disabled ?? item.definition.description}</span>
            </span>
            <span className="palette__item-family">{FAMILY_LABELS[item.definition.category]}</span>
          </div>
        ))}
        {list.length === 0 && <div className="palette__empty">{accepts ? 'No compatible nodes match.' : 'No nodes match.'}</div>}
      </div>
      <div className="palette__keys"><span>↑↓ move</span><span>↵ insert</span><span>esc close</span></div>
    </div>
  );
}
