import { Fragment, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { NodeCategory, NodeDefinition, PortType } from '@flow-patcher/engine';
import { FAMILY_LABELS, nodeIcon, PORT_COLORS, PORT_SOFT_COLORS } from './ports';

export interface PaletteItem {
  definition: NodeDefinition;
  /** Why it can't be picked, such as a unique type already in the patch. */
  disabled?: string;
}

const FAMILIES = Object.keys(FAMILY_LABELS) as NodeCategory[];

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
  // Every match shows; the list scrolls. With no search it's the catalog, grouped by family.
  const list = q
    ? items.filter(({ definition: d }) => `${d.label} ${FAMILY_LABELS[d.category]} ${d.description}`.toLowerCase().includes(q))
    : FAMILIES.flatMap((family) => items.filter((item) => item.definition.category === family));
  const groups = q
    ? [{ family: undefined, items: list }]
    : FAMILIES.map((family) => ({ family, items: list.filter((item) => item.definition.category === family) })).filter((group) => group.items.length);
  const active = Math.min(index, list.length - 1);
  const id = useId();
  const listBox = useRef<HTMLDivElement>(null);
  // Arrow keys keep the active row in view, and its family's header with it when it's the first row. Hover doesn't scroll.
  const keyed = useRef(false);
  useLayoutEffect(() => {
    if (!keyed.current) return;
    keyed.current = false;
    const option = listBox.current?.querySelector('[aria-selected="true"]');
    option?.scrollIntoView({ block: 'nearest' });
    if (option?.previousElementSibling?.classList.contains('palette__group')) option.previousElementSibling.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const pick = (item: PaletteItem | undefined) => item && !item.disabled && onPick(item.definition);

  const onKey = (event: KeyboardEvent) => {
    keyed.current = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (event.key === 'ArrowDown') setIndex(Math.min(list.length - 1, active + 1));
    else if (event.key === 'ArrowUp') setIndex(Math.max(0, active - 1));
    else if (event.key === 'Enter') pick(list[active]);
    else if (event.key === 'Escape') onClose();
    else return;
    event.preventDefault();
  };

  const row = (item: PaletteItem) => {
    const i = list.indexOf(item);
    return (
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
        <i className={`icon-${nodeIcon(item.definition)} palette__item-icon`} />
        <span className="palette__item-text">
          <span className="palette__item-name">{item.definition.label}</span>
          <span className="palette__item-description">{item.disabled ?? item.definition.description}</span>
        </span>
        {q && <span className="palette__item-family">{FAMILY_LABELS[item.definition.category]}</span>}
      </div>
    );
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
          <span className="palette__accepts" data-testid="palette-accepts" style={{ background: PORT_SOFT_COLORS[accepts], color: PORT_COLORS[accepts] }}>
            <span className="palette__accepts-mark" />Accepts {accepts}
          </span>
        )}
      </div>
      <div ref={listBox} className="palette__list" role="listbox">
        {groups.map(({ family, items: rows }) => (family ? (
          // Unsearched, each family is a labelled group; searched, the matches are one flat list.
          <div key={family} className="palette__family" role="group" aria-labelledby={`${id}-${family}`}>
            <div id={`${id}-${family}`} className="palette__group">{FAMILY_LABELS[family]}</div>
            {rows.map(row)}
          </div>
        ) : <Fragment key="matches">{rows.map(row)}</Fragment>))}
        {list.length === 0 && <div className="palette__empty">{accepts ? 'No compatible nodes match.' : 'No nodes match.'}</div>}
      </div>
      <div className="palette__keys"><span>↑↓ move</span><span>↵ insert</span><span>esc close</span></div>
    </div>
  );
}
