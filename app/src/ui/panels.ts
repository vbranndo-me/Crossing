import { useCallback, useEffect, useMemo, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** Left and right docks are columns; the bottom dock is a row between them. */
export type Side = 'left' | 'right' | 'bottom';
export const SIDES: Side[] = ['left', 'right', 'bottom'];

/** What a panel is. Adding a panel to the app means adding one of these to the registry. */
export interface PanelDef {
  id: string;
  min: Size;
  /** Side it is docked to by default; floating when omitted. */
  dock?: Side;
  /** Where it goes the first time it floats. */
  float(workspace: Size): Rect;
}

/** Per-panel state. x / y / width / height describe the panel when it floats. */
export interface PanelLayout extends Rect {
  open: boolean;
  collapsed: boolean;
  /** Share of the dock's length (column height, or row width at the bottom) when docked. */
  weight: number;
}

export interface PanelsState {
  /** Only what differs from the defaults is stored. */
  layouts: Record<string, Partial<PanelLayout>>;
  /** Stacking order of floating panels, back to front. */
  order: string[];
  /** Docked panels per side, top to bottom (left to right at the bottom). A panel in no list floats. */
  docks: Record<Side, string[]>;
  /** Thickness of each dock: width of the side columns, height of the bottom row. */
  dockSize: Record<Side, number>;
}

const STORAGE_KEY = 'crossing.panels.v3';
/** Height kept reachable when a floating panel is pushed against the bottom edge (its title bar). */
const TITLE_REACH = 28;
export const DOCK_MIN: Record<Side, number> = { left: 180, right: 180, bottom: 100 };
const DOCK_DEFAULT: Record<Side, number> = { left: 280, right: 280, bottom: 200 };
/** A dock never takes more than this share of the workspace. */
const DOCK_MAX_SHARE = 0.4;

export function defaultState(defs: PanelDef[]): PanelsState {
  return {
    layouts: {},
    order: [],
    docks: {
      left: defs.filter((d) => d.dock === 'left').map((d) => d.id),
      right: defs.filter((d) => d.dock === 'right').map((d) => d.id),
      bottom: defs.filter((d) => d.dock === 'bottom').map((d) => d.id),
    },
    dockSize: { ...DOCK_DEFAULT },
  };
}

function load(defs: PanelDef[]): PanelsState {
  const fresh = defaultState(defs);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as PanelsState | null;
    if (saved && saved.layouts && Array.isArray(saved.order) && SIDES.every((side) => Array.isArray(saved.docks?.[side]))) {
      // Panels added to the app since the layout was saved go to their default place.
      const known = (id: string) => saved.layouts[id] !== undefined || SIDES.some((side) => saved.docks[side].includes(id));
      for (const side of SIDES) {
        for (const id of fresh.docks[side]) if (!known(id)) saved.docks[side].push(id);
      }
      return { ...fresh, ...saved, dockSize: { ...fresh.dockSize, ...saved.dockSize } };
    }
  } catch {
    // Unreadable or blocked storage: start from the default layout.
  }
  return fresh;
}

/** Keep a floating panel reachable inside the workspace without changing the stored layout. */
export function fitToWorkspace(rect: Rect, min: Size, workspace: Size): Rect {
  const width = Math.max(min.width, Math.min(rect.width, workspace.width));
  const height = Math.max(min.height, Math.min(rect.height, workspace.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(rect.x, workspace.width - width)),
    y: Math.max(0, Math.min(rect.y, workspace.height - TITLE_REACH)),
  };
}

/** Thickness a dock can actually have in this workspace. */
export function clampDockSize(side: Side, size: number, workspace: Size): number {
  const max = (side === 'bottom' ? workspace.height : workspace.width) * DOCK_MAX_SHARE;
  return Math.round(Math.max(Math.min(DOCK_MIN[side], max), Math.min(size, max)));
}

/**
 * Split a dock's length between its panels: collapsed ones take a fixed length (their title bar
 * in a column), the rest share what is left in proportion to their weights.
 * Returns [offset, length] per panel, in order.
 */
export function splitColumn(items: { weight: number; collapsed: boolean }[], height: number, titleHeight: number): [number, number][] {
  const expanded = items.filter((i) => !i.collapsed);
  const free = Math.max(0, height - (items.length - expanded.length) * titleHeight);
  const total = expanded.reduce((sum, i) => sum + i.weight, 0);
  let y = 0;
  let used = 0;
  let left = expanded.length;
  return items.map((item) => {
    let h = titleHeight;
    if (!item.collapsed) {
      // The last expanded panel takes the rounding remainder so the column is filled exactly.
      left--;
      h = left === 0 ? free - used : Math.round((free * item.weight) / total);
      used += h;
    }
    const out: [number, number] = [y, h];
    y += h;
    return out;
  });
}

/** Insert `id` into a dock list so it lands before the `index`-th of the listed `visible` panels. */
export function insertDocked(list: string[], id: string, visible: string[], index: number): string[] {
  const rest = list.filter((x) => x !== id);
  const before = visible.filter((x) => x !== id)[index];
  const at = before === undefined ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Layout state for the panels: docked or floating, size, open / collapsed, stacking. Saved per browser. */
export function usePanels(defs: PanelDef[]) {
  const [state, setState] = useState(() => load(defs));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Layout simply is not remembered.
    }
  }, [state]);

  const patch = useCallback((id: string, change: Partial<PanelLayout>) => {
    setState((s) => ({ ...s, layouts: { ...s.layouts, [id]: { ...s.layouts[id], ...change } } }));
  }, []);

  const bringToFront = useCallback((id: string) => {
    setState((s) => (s.order[s.order.length - 1] === id ? s : { ...s, order: [...s.order.filter((o) => o !== id), id] }));
  }, []);

  const dock = useCallback((id: string, side: Side, visible: string[], index: number) => {
    setState((s) => {
      const docks = { ...s.docks };
      for (const other of SIDES) docks[other] = other === side ? insertDocked(docks[other], id, visible, index) : docks[other].filter((x) => x !== id);
      return { ...s, docks };
    });
  }, []);

  const undock = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      docks: { left: s.docks.left.filter((x) => x !== id), right: s.docks.right.filter((x) => x !== id), bottom: s.docks.bottom.filter((x) => x !== id) },
      order: [...s.order.filter((o) => o !== id), id],
    }));
  }, []);

  const setDockSize = useCallback((side: Side, size: number) => {
    setState((s) => ({ ...s, dockSize: { ...s.dockSize, [side]: size } }));
  }, []);

  const reset = useCallback(() => setState(defaultState(defs)), [defs]);

  return useMemo(
    () => ({
      state,
      /** Full layout of a panel: stored values over the defaults. */
      resolve: (def: PanelDef, workspace: Size): PanelLayout => ({ ...def.float(workspace), open: true, collapsed: false, weight: 1, ...state.layouts[def.id] }),
      isOpen: (id: string) => state.layouts[id]?.open ?? true,
      sideOf: (id: string): Side | null => SIDES.find((s) => state.docks[s].includes(id)) ?? null,
      patch,
      bringToFront,
      dock,
      undock,
      setDockSize,
      reset,
    }),
    [state, patch, bringToFront, dock, undock, setDockSize, reset],
  );
}

export type Panels = ReturnType<typeof usePanels>;
