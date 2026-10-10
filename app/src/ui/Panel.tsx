import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useI18n } from '../i18n/index.tsx';
import type { Rect, Side } from './panels.ts';

interface Props {
  title: string;
  /** Position inside the workspace, whether docked or floating. */
  rect: Rect;
  /** Dock it sits in, or null when floating. */
  side: Side | null;
  collapsed: boolean;
  zIndex: number;
  onTitlePointerDown(e: ReactPointerEvent<HTMLElement>): void;
  /** Floating panels only: an edge or corner was grabbed. -1 = left/top, 1 = right/bottom, 0 = not moving. */
  onResizeStart(e: ReactPointerEvent<HTMLElement>, horizontal: number, vertical: number): void;
  onToggleCollapse(): void;
  onClose(): void;
  onFocus(): void;
  children: ReactNode;
}

const HANDLES: [string, number, number][] = [
  ['n', 0, -1],
  ['s', 0, 1],
  ['w', -1, 0],
  ['e', 1, 0],
  ['nw', -1, -1],
  ['ne', 1, -1],
  ['sw', -1, 1],
  ['se', 1, 1],
];

/**
 * One panel window. It is always absolutely positioned by the workspace, docked or not, so it
 * stays the same element (and keeps its state) when it is docked, undocked or dragged.
 */
export function Panel(props: Props) {
  const { t } = useI18n();
  const { title, rect, side, collapsed } = props;
  const docked = side !== null;
  return (
    <section
      className={`panel ${docked ? `docked ${side}` : 'floating'}${collapsed ? ' collapsed' : ''}`}
      // A collapsed floating panel is as tall as its title bar, whatever the theme makes that.
      style={{ left: rect.x, top: rect.y, width: rect.width, height: collapsed && !docked ? undefined : rect.height, zIndex: props.zIndex }}
      aria-label={title}
      onPointerDownCapture={props.onFocus}
    >
      <header className="panel-title" onPointerDown={props.onTitlePointerDown} onDoubleClick={props.onToggleCollapse}>
        <span className="panel-name">{title}</span>
        <button
          type="button"
          className="panel-button"
          aria-label={collapsed ? t.panel.expand(title) : t.panel.collapse(title)}
          aria-expanded={!collapsed}
          onClick={props.onToggleCollapse}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <button type="button" className="panel-button" aria-label={t.panel.close(title)} onClick={props.onClose}>
          ×
        </button>
      </header>
      {/* Kept mounted while collapsed so the content does not lose its state. */}
      <div className="panel-body" hidden={collapsed}>
        {props.children}
      </div>
      {!docked && !collapsed && HANDLES.map(([name, h, v]) => <div key={name} className={`panel-resize ${name}`} onPointerDown={(e) => props.onResizeStart(e, h, v)} />)}
    </section>
  );
}
