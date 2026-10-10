import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Panel } from './Panel.tsx';
import { DOCK_MIN, SIDES, clampDockSize, fitToWorkspace, splitColumn } from './panels.ts';
import type { PanelDef, PanelLayout, Panels, Rect, Side, Size } from './panels.ts';

interface Props {
  defs: PanelDef[];
  panels: Panels;
  titles: Record<string, string>;
  /** Content of each panel, by id. */
  content: Record<string, ReactNode>;
  /** The main view, shown in whatever space the docked panels leave. */
  children: ReactNode;
}

interface Placed {
  def: PanelDef;
  layout: PanelLayout;
  side: Side | null;
  rect: Rect;
}

interface Drop {
  side: Side;
  /** Position among the panels already docked on that side. */
  index: number;
  /** Where the indicator is drawn. */
  rect: Rect;
}

/** Distance from a workspace edge within which a dragged panel offers to dock there. */
const EDGE_ZONE = 48;
const DRAG_THRESHOLD = 5;
/** Smallest length a docked panel can be squeezed to by the line next to it. */
const MIN_DOCKED_LENGTH = 60;
/** Width of a collapsed panel in the bottom row. */
const COLLAPSED_WIDTH = 150;
const INDICATOR = 6;

/** Follow the pointer from this press until release. Uses window listeners so it survives re-layout. */
function track(e: ReactPointerEvent<HTMLElement>, onMove: (m: PointerEvent) => void, onEnd: () => void = () => {}) {
  if (e.button !== 0) return;
  e.preventDefault();
  const end = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    onEnd();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/**
 * The area under the toolbar: the main view in the middle; panels docked in a column on either
 * side, in a row along the bottom, or floating on top. Drag a panel by its title to move it;
 * drop it near an edge to dock it there.
 */
export function Workspace({ defs, panels, titles, content, children }: Props) {
  const root = useRef<HTMLElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [titleHeight, setTitleHeight] = useState(28);
  const [drop, setDrop] = useState<Drop | null>(null);

  useEffect(() => {
    const el = root.current!;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
      // Docked title bars follow the theme: bar height plus the 1px line above it.
      setTitleHeight((parseFloat(getComputedStyle(el).getPropertyValue('--bar-height')) || 28) + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- geometry: where everything is, in workspace coordinates ----
  const placed: Placed[] = [];
  /** Thickness each dock currently takes (0 when it has no open panel). */
  const dock: Record<Side, number> = { left: 0, right: 0, bottom: 0 };
  if (size) {
    const open = defs.filter((d) => panels.isOpen(d.id));
    const docked = (side: Side) => panels.state.docks[side].map((id) => open.find((d) => d.id === id)).filter((d) => d !== undefined);
    // Side columns take the full height.
    for (const side of ['left', 'right'] as const) {
      const column = docked(side);
      if (column.length === 0) continue;
      const width = (dock[side] = clampDockSize(side, panels.state.dockSize[side], size));
      const layouts = column.map((def) => panels.resolve(def, size));
      splitColumn(layouts, size.height, titleHeight).forEach(([y, height], i) => {
        placed.push({ def: column[i], layout: layouts[i], side, rect: { x: side === 'left' ? 0 : size.width - width, y, width, height } });
      });
    }
    // The bottom row sits between them. With every panel collapsed it is just a strip of title bars.
    const row = docked('bottom');
    if (row.length > 0) {
      const layouts = row.map((def) => panels.resolve(def, size));
      const height = (dock.bottom = layouts.every((l) => l.collapsed) ? titleHeight : clampDockSize('bottom', panels.state.dockSize.bottom, size));
      splitColumn(layouts, size.width - dock.left - dock.right, COLLAPSED_WIDTH).forEach(([x, width], i) => {
        placed.push({ def: row[i], layout: layouts[i], side: 'bottom', rect: { x: dock.left + x, y: size.height - height, width, height } });
      });
    }
    for (const def of open) {
      if (panels.sideOf(def.id)) continue;
      const layout = panels.resolve(def, size);
      placed.push({ def, layout, side: null, rect: fitToWorkspace(layout, def.min, size) });
    }
  }

  // Drags outlive the render that started them, so they read the latest geometry from here.
  const latest = useRef({ placed, dock, size, panels });
  latest.current = { placed, dock, size, panels };

  const pointerIn = (m: { clientX: number; clientY: number }) => {
    const box = root.current!.getBoundingClientRect();
    return { x: m.clientX - box.left, y: m.clientY - box.top };
  };

  /** Where a panel dragged to (x, y) would dock, if anywhere. */
  const findDrop = (x: number, y: number, dragged: string): Drop | null => {
    const { placed, dock, size, panels } = latest.current;
    if (!size) return null;
    const others = (side: Side) => placed.filter((p) => p.side === side && p.def.id !== dragged);
    const thickness = (side: Side) => dock[side] || clampDockSize(side, panels.state.dockSize[side], size);

    for (const side of ['left', 'right'] as const) {
      const zone = Math.max(dock[side], EDGE_ZONE);
      if (side === 'left' ? x >= zone : x <= size.width - zone) continue;
      const column = others(side);
      const width = thickness(side);
      const left = side === 'left' ? 0 : size.width - width;
      if (column.length === 0) return { side, index: 0, rect: { x: left, y: 0, width, height: size.height } };
      const index = column.filter((p) => p.rect.y + p.rect.height / 2 < y).length;
      const edge = index < column.length ? column[index].rect.y : size.height;
      return { side, index, rect: { x: left, y: Math.max(0, Math.min(edge - INDICATOR / 2, size.height - INDICATOR)), width, height: INDICATOR } };
    }

    if (y > size.height - Math.max(dock.bottom, EDGE_ZONE)) {
      const row = others('bottom');
      const height = thickness('bottom');
      const left = dock.left;
      const right = size.width - dock.right;
      if (row.length === 0) return { side: 'bottom', index: 0, rect: { x: left, y: size.height - height, width: right - left, height } };
      const index = row.filter((p) => p.rect.x + p.rect.width / 2 < x).length;
      const edge = index < row.length ? row[index].rect.x : right;
      return { side: 'bottom', index, rect: { x: Math.max(left, Math.min(edge - INDICATOR / 2, right - INDICATOR)), y: size.height - height, width: INDICATOR, height } };
    }
    return null;
  };

  const startMove = (e: ReactPointerEvent<HTMLElement>, p: Placed) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const { id, min } = p.def;
    const start = pointerIn(e);
    let grab = { x: start.x - p.rect.x, y: start.y - p.rect.y };
    let floating = p.side === null;
    let dragging = false;
    let target: Drop | null = null;
    track(
      e,
      (m) => {
        const { size, panels } = latest.current;
        if (!size) return;
        const at = pointerIn(m);
        if (!dragging && Math.hypot(at.x - start.x, at.y - start.y) < DRAG_THRESHOLD) return;
        dragging = true;
        const layout = panels.resolve(p.def, size);
        if (!floating) {
          // Pulled out of the dock: it becomes a floating panel under the pointer.
          floating = true;
          grab = { x: Math.min(grab.x, layout.width - 60), y: grab.y };
          panels.undock(id);
        }
        panels.patch(id, fitToWorkspace({ x: at.x - grab.x, y: at.y - grab.y, width: layout.width, height: layout.height }, min, size));
        target = findDrop(at.x, at.y, id);
        setDrop(target);
      },
      () => {
        if (target) latest.current.panels.dock(id, target.side, latest.current.placed.filter((q) => q.side === target!.side).map((q) => q.def.id), target.index);
        setDrop(null);
      },
    );
  };

  const startResize = (e: ReactPointerEvent<HTMLElement>, p: Placed, h: number, v: number) => {
    const start = p.rect;
    const from = pointerIn(e);
    const { min } = p.def;
    track(e, (m) => {
      const { size, panels } = latest.current;
      if (!size) return;
      const at = pointerIn(m);
      const dx = at.x - from.x;
      const dy = at.y - from.y;
      // Each moving edge is limited by the workspace on one side and the minimum size on the other.
      const left = h < 0 ? Math.max(0, Math.min(start.x + dx, start.x + start.width - min.width)) : start.x;
      const top = v < 0 ? Math.max(0, Math.min(start.y + dy, start.y + start.height - min.height)) : start.y;
      const right = h > 0 ? Math.min(size.width, Math.max(start.x + start.width + dx, start.x + min.width)) : start.x + start.width;
      const bottom = v > 0 ? Math.min(size.height, Math.max(start.y + start.height + dy, start.y + min.height)) : start.y + start.height;
      panels.patch(p.def.id, { x: left, y: top, width: right - left, height: bottom - top });
    });
  };

  /** Drag the line between a dock and the main view: change the dock's thickness. */
  const startDockResize = (e: ReactPointerEvent<HTMLElement>, side: Side) => {
    track(e, (m) => {
      const { size, panels } = latest.current;
      if (!size) return;
      const at = pointerIn(m);
      const thickness = side === 'left' ? at.x : side === 'right' ? size.width - at.x : size.height - at.y;
      panels.setDockSize(side, Math.max(DOCK_MIN[side], thickness));
    });
  };

  /** Drag the line between two neighbours in a dock: move length from one to the other. */
  const startDivide = (e: ReactPointerEvent<HTMLElement>, first: Placed, second: Placed) => {
    const along = first.side === 'bottom' ? ('x' as const) : ('y' as const);
    const length = (r: Rect) => (along === 'x' ? r.width : r.height);
    const from = pointerIn(e)[along];
    const pixels = length(first.rect) + length(second.rect);
    const weight = first.layout.weight + second.layout.weight;
    track(e, (m) => {
      const { panels } = latest.current;
      const now = Math.max(MIN_DOCKED_LENGTH, Math.min(length(first.rect) + pointerIn(m)[along] - from, pixels - MIN_DOCKED_LENGTH));
      panels.patch(first.def.id, { weight: (weight * now) / pixels });
      panels.patch(second.def.id, { weight: (weight * (pixels - now)) / pixels });
    });
  };

  const floatingOrder = panels.state.order;
  /** Rectangle of the line between a dock and the main view. */
  const edgeOf = (side: Side, ws: Size): Rect =>
    side === 'bottom'
      ? { x: dock.left, y: ws.height - dock.bottom - INDICATOR / 2, width: ws.width - dock.left - dock.right, height: INDICATOR }
      : { x: (side === 'left' ? dock.left : ws.width - dock.right) - INDICATOR / 2, y: 0, width: INDICATOR, height: ws.height };

  return (
    <main className="workspace" ref={root}>
      <div className="stage" style={{ left: dock.left, right: dock.right, bottom: dock.bottom }}>
        {/* Only once the docks are laid out, so the main view starts with the space it really has. */}
        {size && children}
      </div>
      {placed.map((p) => (
        <Panel
          key={p.def.id}
          title={titles[p.def.id] ?? p.def.id}
          rect={p.rect}
          side={p.side}
          collapsed={p.layout.collapsed}
          zIndex={p.side ? 1 : 10 + floatingOrder.indexOf(p.def.id)}
          onTitlePointerDown={(e) => startMove(e, p)}
          onResizeStart={(e, h, v) => startResize(e, p, h, v)}
          onToggleCollapse={() => panels.patch(p.def.id, { collapsed: !p.layout.collapsed })}
          onClose={() => panels.patch(p.def.id, { open: false })}
          onFocus={() => p.side === null && panels.bringToFront(p.def.id)}
        >
          {content[p.def.id]}
        </Panel>
      ))}
      {SIDES.map((side) => {
        if (!dock[side] || !size) return null;
        const group = placed.filter((p) => p.side === side);
        const row = side === 'bottom';
        const edge = edgeOf(side, size);
        return [
          // A row of collapsed title bars has no thickness to change.
          row && group.every((p) => p.layout.collapsed) ? null : (
            <div
              key={side}
              className={`dock-splitter ${row ? 'horizontal' : 'vertical'}`}
              style={{ left: edge.x, top: edge.y, width: edge.width, height: edge.height }}
              onPointerDown={(e) => startDockResize(e, side)}
            />
          ),
          ...group.slice(1).map((second, i) =>
            // Only a line between two expanded panels can move.
            group[i].layout.collapsed || second.layout.collapsed ? null : (
              <div
                key={`${side}-${second.def.id}`}
                className={`dock-divider ${row ? 'vertical' : 'horizontal'}`}
                style={
                  row
                    ? { left: second.rect.x - INDICATOR / 2, top: second.rect.y, width: INDICATOR, height: second.rect.height }
                    : { left: second.rect.x, top: second.rect.y - INDICATOR / 2, width: second.rect.width, height: INDICATOR }
                }
                onPointerDown={(e) => startDivide(e, group[i], second)}
              />
            ),
          ),
        ];
      })}
      {drop && <div className="dock-drop" style={{ left: drop.rect.x, top: drop.rect.y, width: drop.rect.width, height: drop.rect.height }} />}
    </main>
  );
}
