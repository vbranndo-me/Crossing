import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { Palette } from '../core/palette.ts';
import type { Backstitch, BrushShape, Editor, LayerId, SelectMode, StrokeMark } from '../edit/editor.ts';
import type { FillMode } from '../ui/ToolOptions.tsx';
import { useI18n } from '../i18n/index.tsx';
import { createGridRenderer } from '../render/webgl.ts';
import { LAYER_OF } from '../tools.ts';
import type { StitchId, ToolId } from '../tools.ts';
import { cellAt, clamp, fit, panBy, zoomAt } from './camera.ts';
import type { Camera } from './camera.ts';

export interface ViewInfo {
  /** CSS pixels per cell. */
  scale: number;
  /** Cell under the pointer, if any. */
  cell: { x: number; y: number } | null;
  /** Visible part of the chart, in cells (may extend past the grid). */
  rect: { x: number; y: number; width: number; height: number };
}

export interface GridViewHandle {
  zoomBy(factor: number): void;
  fit(): void;
  /** Move the view so this grid position is in the middle. */
  centerOn(x: number, y: number): void;
  /** Where something new should go: the cell under the pointer, or else the top-left cell in view. */
  anchorCell(): { x: number; y: number };
}

interface Props {
  /** The chart being shown and edited. */
  editor: Editor;
  palette: Palette;
  tool: ToolId;
  /** What the pencil draws and the eraser removes. */
  stitch: StitchId;
  /** Palette index the pencil and the bucket use. */
  color: number;
  /** Layers currently shown. */
  visible: Record<LayerId, boolean>;
  /** Brush of the pencil and the eraser (the editor has the same; here it sizes the cursor). */
  brushSize: number;
  brushShape: BrushShape;
  fillMode: FillMode;
  /** Rectangle and ellipse tools: filled or outline. */
  shapeFilled: boolean;
  /** Threads along the gradient the bucket lays down in gradient mode. */
  ramp: Uint16Array;
  onView(info: ViewInfo): void;
  /** A tool was used on a layer that is locked or hidden. */
  onBlocked(layer: LayerId): void;
  /** Eyedropper: the palette index of the cell that was picked. */
  onPick(index: number): void;
  /** Text tool: a cell was clicked, where the text should start. */
  onText(cell: { x: number; y: number }): void;
  ref?: Ref<GridViewHandle>;
}

type Point = { x: number; y: number };

const KEY_PAN_PX = 80;
const BUTTON_ZOOM = 1.5;
/** Up to this many changed cells are sent to the GPU one by one; beyond it the whole grid goes at once. */
const CELL_UPDATES = 256;

/** Resolve a theme colour token to [r, g, b] in 0..1, so the canvas follows the theme. */
function cssColor(el: Element, token: string): [number, number, number] {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
  ctx.fillStyle = getComputedStyle(el).getPropertyValue(token).trim() || '#222';
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

/**
 * Nearest point to `to` that is straight across, straight up or down, or on a diagonal from `from`.
 * With `max`, a diagonal is shortened to stay inside 0..max.
 */
function constrain(from: Point, to: Point, max?: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // tan(22.5 degrees): the boundary between "along an axis" and "along a diagonal".
  if (ay < ax * 0.4142) return { x: to.x, y: from.y };
  if (ax < ay * 0.4142) return { x: from.x, y: to.y };
  let n = Math.round((ax + ay) / 2);
  if (max) n = Math.min(n, dx > 0 ? max.x - from.x : from.x, dy > 0 ? max.y - from.y : from.y);
  return { x: from.x + Math.sign(dx) * n, y: from.y + Math.sign(dy) * n };
}

/** Shift adds to the selection, Alt takes away from it. */
const selectMode = (e: PointerEvent): SelectMode => (e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');

/**
 * The chart canvas: owns the camera, the renderer and all pointer input.
 * A press uses the current tool, except that the middle button, Space + drag and a second
 * finger always move the view.
 */
export function GridView(props: Props) {
  const { editor, palette, tool, stitch, color, visible, brushSize, brushShape, fillMode, shapeFilled, ramp, onView, onBlocked, onPick, onText, ref } = props;
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<GridViewHandle>({ zoomBy() {}, fit() {}, centerOn() {}, anchorCell: () => ({ x: 0, y: 0 }) });
  const [unsupported, setUnsupported] = useState(false);
  const report = useRef(onView);
  report.current = onView;
  // Read by the input handlers, which are set up once per chart.
  const live = useRef({ tool, stitch, color, visible, brushSize, brushShape, fillMode, shapeFilled, ramp, onBlocked, onPick, onText });
  live.current = { tool, stitch, color, visible, brushSize, brushShape, fillMode, shapeFilled, ramp, onBlocked, onPick, onText };
  const cursorRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<{ setVisible(full: boolean, fractional: boolean, backstitch: boolean): void; redraw(): void } | null>(null);

  useEffect(() => {
    rendererRef.current?.setVisible(visible.full, visible.fractional, visible.backstitch);
    rendererRef.current?.redraw();
  }, [visible]);

  // The brush outline follows the tool and brush settings even while the pointer is still.
  useEffect(() => rendererRef.current?.redraw(), [tool, stitch, brushSize, brushShape]);

  useImperativeHandle(
    ref,
    () => ({ zoomBy: (f) => api.current.zoomBy(f), fit: () => api.current.fit(), centerOn: (x, y) => api.current.centerOn(x, y), anchorCell: () => api.current.anchorCell() }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current!;
    const { grid } = editor;
    const renderer = createGridRenderer(canvas, grid, palette, cssColor(canvas, '--c-workspace'));
    if (!renderer) {
      setUnsupported(true);
      return;
    }
    const view = { width: canvas.clientWidth, height: canvas.clientHeight };
    let cam: Camera = fit(grid, view);
    let hover: Point | null = null; // last pointer position, viewport pixels
    let frame = 0;

    // Draw only when something changed, at most once per frame.
    const invalidate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderer.render(cam, canvas.width / view.width);
        showBrush();
        report.current({
          scale: cam.scale,
          cell: hover && cellAt(cam, hover.x, hover.y, grid),
          rect: { x: cam.x, y: cam.y, width: view.width / cam.scale, height: view.height / cam.scale },
        });
      });
    };
    /** Outline of the brush around the cell under the pointer, for the pencil and the eraser. */
    const showBrush = () => {
      const el = cursorRef.current;
      if (!el) return;
      const { tool, brushShape } = live.current;
      // The line tool draws full stitches whatever the stitch type; a three-quarter stitch is one corner at a time.
      const stitch = tool === 'line' ? 'full' : live.current.stitch;
      const brushSize = stitch === 'threeQuarter' ? 1 : live.current.brushSize;
      if (!hover || (tool !== 'pencil' && tool !== 'eraser' && tool !== 'line') || stitch === 'back' || stitch === 'knot' || gesture === 'pan') {
        el.style.display = 'none';
        return;
      }
      // Quarter stitches are drawn on a grid of half cells.
      const unit = stitch === 'quarter' || stitch === 'threeQuarter' ? 0.5 : 1;
      const first = (v: number) => (Math.floor(v / unit) - Math.floor(brushSize / 2)) * unit;
      const at = { x: cam.x + hover.x / cam.scale, y: cam.y + hover.y / cam.scale };
      const side = brushSize * unit * cam.scale;
      el.style.display = 'block';
      el.style.transform = `translate(${(first(at.x) - cam.x) * cam.scale}px, ${(first(at.y) - cam.y) * cam.scale}px)`;
      el.style.width = el.style.height = `${side}px`;
      el.style.borderRadius = brushShape === 'round' && brushSize > 2 ? '50%' : '0';
    };
    const setCamera = (next: Camera) => {
      cam = next;
      invalidate();
    };

    /** Backstitch line being dragged out, not yet part of the chart. */
    let preview: Backstitch | null = null;

    // Whatever edits the chart (a tool here, undo from the menu...), the canvas follows.
    renderer.selectionChanged(editor.selection);
    renderer.setVisible(live.current.visible.full, live.current.visible.fractional, live.current.visible.backstitch);
    if (editor.quarters && editor.halves) renderer.fractionsChanged(editor.quarters, editor.halves, null);
    renderer.backstitchChanged(editor.backstitches, null);
    rendererRef.current = { setVisible: renderer.setVisible, redraw: invalidate };
    const unsubscribe = editor.subscribe((change) => {
      if (change.cells === null || change.cells.length > CELL_UPDATES) renderer.gridChanged();
      else for (const index of change.cells) renderer.cellChanged(index);
      if (change.selection) renderer.selectionChanged(editor.selection);
      if (change.fractions.length > 0) renderer.fractionsChanged(editor.quarters!, editor.halves!, change.fractions.length > CELL_UPDATES ? null : change.fractions);
      if (change.backstitch) renderer.backstitchChanged(editor.backstitches, preview);
      invalidate();
    });

    let sized = false;
    const observer = new ResizeObserver(() => {
      const centre = { x: cam.x + view.width / cam.scale / 2, y: cam.y + view.height / cam.scale / 2 };
      view.width = canvas.clientWidth;
      view.height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(view.width * dpr));
      canvas.height = Math.max(1, Math.round(view.height * dpr));
      renderer.resize();
      // First layout: show the whole chart. Later: keep the same grid point in the middle of the window.
      setCamera(sized ? clamp({ ...cam, x: centre.x - view.width / cam.scale / 2, y: centre.y - view.height / cam.scale / 2 }, grid, view) : fit(grid, view));
      sized = true;
    });
    observer.observe(canvas);

    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** Position in the chart, in cells (fractional), of a viewport position. */
    const chartAt = (p: Point): Point => ({ x: cam.x + p.x / cam.scale, y: cam.y + p.y / cam.scale });
    /** Cell under a viewport position; may be outside the grid. */
    const cellOf = (p: Point): Point => ({ x: Math.floor(cam.x + p.x / cam.scale), y: Math.floor(cam.y + p.y / cam.scale) });
    /** Same in half cells: the corner of a cell (quarter stitch) under the pointer. */
    const halfCellOf = (p: Point): Point => ({ x: Math.floor(chartAt(p).x * 2), y: Math.floor(chartAt(p).y * 2) });
    /** Nearest point a backstitch can start or end at (half-cell steps), kept inside the chart. */
    const snap = (p: Point): Point => ({
      x: Math.max(0, Math.min(grid.width * 2, Math.round(chartAt(p).x * 2))),
      y: Math.max(0, Math.min(grid.height * 2, Math.round(chartAt(p).y * 2))),
    });
    /** Index of the cell under a viewport position, or -1 outside the grid. */
    const indexAt = (p: Point) => {
      const cell = cellAt(cam, p.x, p.y, grid);
      return cell ? cell.y * grid.width + cell.x : -1;
    };

    // Pointers: one pans or uses the tool, two pinch (zoom about their midpoint and pan with it).
    const pointers = new Map<number, Point>();
    /** What the current press does; decided when it starts. */
    let gesture: 'pan' | 'tool' | null = null;
    let space = false;
    /** The press in progress, for tools that work by dragging. */
    let drag: {
      tool: ToolId;
      stitch: StitchId;
      /** Cell where the press started, and its index (-1 outside the chart). */
      from: Point;
      index: number;
      /** Where the stroke last reached, on the grid its stitch type is drawn on (cells; half cells for quarters). */
      last: Point;
      /** Start of the backstitch or gradient line being dragged out, in half cells. */
      anchor: Point;
      /** The stroke as it was when the press began: shapes are redrawn from here as they are dragged out. */
      mark: StrokeMark;
      /** While Shift holds the stroke to a straight line: where that line starts and the stroke as it was then. */
      straight: { from: Point; mark: StrokeMark } | null;
      /** The bucket is dragging out a gradient. */
      gradient: boolean;
      value: number;
      /** Half stitch direction, fixed for the whole stroke by where it started. */
      slash: boolean;
      mode: SelectMode;
      base: Uint8Array | null;
      moved: boolean;
    } | null = null;

    const setPreview = (line: Backstitch | null) => {
      preview = line;
      renderer.backstitchChanged(editor.backstitches, preview);
      invalidate();
    };

    /** Position of the pointer on the grid a stitch type is drawn on. */
    const unitOf = (p: Point, stitch: StitchId) => (stitch === 'quarter' || stitch === 'threeQuarter' ? halfCellOf(p) : cellOf(p));
    const lineBounds = { x: grid.width * 2, y: grid.height * 2 };

    /** Draw the current stitch type along a line. */
    const paint = (from: Point, to: Point) => {
      if (!drag) return;
      if (drag.stitch === 'full') editor.paintLine(from.x, from.y, to.x, to.y, drag.value);
      else if (drag.stitch === 'half') editor.paintHalves(from.x, from.y, to.x, to.y, drag.slash, drag.value);
      else if (drag.stitch === 'threeQuarter') editor.paintThreeQuarters(from.x, from.y, to.x, to.y, drag.value);
      else editor.paintQuarters(from.x, from.y, to.x, to.y, drag.value);
    };

    /** Line, rectangle and ellipse: drawn again from the press to the pointer each time it moves. Shift: 45 degrees, or a square. */
    const shape = (p: Point, shift: boolean) => {
      if (!drag) return;
      editor.rewind(drag.mark);
      const { from } = drag;
      let to = cellOf(p);
      if (drag.tool === 'line') {
        if (shift) to = constrain(from, to);
        editor.paintLine(from.x, from.y, to.x, to.y, drag.value);
      } else if (drag.tool === 'rect' || drag.tool === 'ellipse') {
        if (shift) {
          const side = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
          to = { x: from.x + (to.x < from.x ? -side : side), y: from.y + (to.y < from.y ? -side : side) };
        }
        editor.paintShape(drag.tool, from.x, from.y, to.x, to.y, drag.value, live.current.shapeFilled);
      }
    };

    /** One step of the pencil or the eraser. With `straight` (Shift), the stroke is a line at a multiple of 45 degrees. */
    const stroke = (p: Point, straight: boolean) => {
      if (!drag) return;
      if (drag.stitch === 'back' || drag.stitch === 'knot') {
        if (drag.tool === 'eraser') {
          editor.eraseBackstitchNear(chartAt(p).x, chartAt(p).y, Math.max(0.3, live.current.brushSize / 2));
        } else if (drag.stitch === 'back') {
          const to = straight ? constrain(drag.anchor, snap(p), lineBounds) : snap(p);
          setPreview({ x0: drag.anchor.x, y0: drag.anchor.y, x1: to.x, y1: to.y, color: drag.value });
        }
        return;
      }
      const to = unitOf(p, drag.stitch);
      if (straight) {
        // The line is redrawn from where Shift took effect each time the pointer moves.
        drag.straight ??= { from: drag.last, mark: editor.mark() };
        editor.rewind(drag.straight.mark);
        const end = constrain(drag.straight.from, to);
        paint(drag.straight.from, end);
        drag.last = end;
      } else {
        drag.straight = null;
        paint(drag.last, to);
        drag.last = to;
      }
    };

    const useTool = (e: PointerEvent, p: Point) => {
      const { tool, color, visible, fillMode, onBlocked, onPick, onText } = live.current;
      const shaping = tool === 'line' || tool === 'rect' || tool === 'ellipse';
      // Only the pencil and the eraser work on the other stitch types.
      const stitch = tool === 'pencil' || tool === 'eraser' ? live.current.stitch : 'full';
      const cell = cellOf(p);
      const index = indexAt(p);
      const at = chartAt(p);
      const drawing = tool === 'pencil' || tool === 'eraser';
      // Drawing tools act on the layer of the current stitch type; bucket and selection on full stitches.
      const layer: LayerId | null = drawing ? LAYER_OF[stitch] : tool === 'fill' || shaping || tool === 'move' || tool === 'text' ? 'full' : null;
      if (layer && (editor.isLocked(layer) || !visible[layer])) {
        onBlocked(layer);
        return;
      }
      // "\" when the press is nearer that diagonal (top-left or bottom-right corner of the cell).
      const fx = at.x - cell.x;
      const fy = at.y - cell.y;
      drag = {
        tool,
        stitch,
        from: cell,
        index,
        last: unitOf(p, stitch),
        anchor: snap(p),
        mark: editor.mark(),
        straight: null,
        gradient: tool === 'fill' && fillMode === 'gradient' && index >= 0,
        value: tool === 'eraser' ? 0 : color,
        slash: fx < 0.5 !== fy < 0.5,
        mode: selectMode(e),
        base: editor.selection,
        moved: false,
      };
      if (tool === 'pencil' && stitch === 'knot') editor.addKnot(drag.anchor.x, drag.anchor.y, color);
      else if (drawing) stroke(p, e.shiftKey);
      else if (shaping) shape(p, e.shiftKey);
      else if (tool === 'text') {
        if (index >= 0) onText(cell);
      } else if (tool === 'zoom') setCamera(zoomAt(cam, e.altKey || e.shiftKey ? 1 / BUTTON_ZOOM : BUTTON_ZOOM, p.x, p.y, grid, view));
      else if (tool === 'eyedropper') onPick(editor.colorAt(at.x, at.y, visible));
      else if (index < 0) return;
      else if (tool === 'fill' && !drag.gradient) editor.fill(index, color);
      else if (tool === 'wand') editor.wand(index, drag.mode);
    };

    const dragTool = (p: Point, shift: boolean) => {
      if (!drag) return;
      const cell = cellOf(p);
      if (drag.tool === 'pencil' || drag.tool === 'eraser') stroke(p, shift);
      else if (drag.tool === 'line' || drag.tool === 'rect' || drag.tool === 'ellipse') shape(p, shift);
      else if (drag.tool === 'move') editor.dragSelection(cell.x - drag.from.x, cell.y - drag.from.y);
      else if (drag.tool === 'select') editor.selectRect(drag.from.x, drag.from.y, cell.x, cell.y, drag.mode, drag.base);
      else if (drag.tool === 'eyedropper') live.current.onPick(editor.colorAt(chartAt(p).x, chartAt(p).y, live.current.visible));
      else if (drag.gradient) {
        // The line shows where the gradient will run; it is applied on release.
        const to = shift ? constrain(drag.anchor, snap(p), lineBounds) : snap(p);
        setPreview({ x0: drag.anchor.x, y0: drag.anchor.y, x1: to.x, y1: to.y, color: drag.value });
      }
      if (cell.x !== drag.from.x || cell.y !== drag.from.y) drag.moved = true;
    };

    const endTool = () => {
      if (!drag) return;
      const line = preview;
      if (line) setPreview(null);
      if (drag.gradient) {
        // A click without dragging has no direction: the editor then runs it across the area.
        const end = line ?? { x0: drag.anchor.x, y0: drag.anchor.y, x1: drag.anchor.x, y1: drag.anchor.y };
        editor.gradientFill(drag.index, live.current.ramp, end.x0 / 2, end.y0 / 2, end.x1 / 2, end.y1 / 2);
      } else if (line) {
        // Releasing the pencil turns the dragged line into a backstitch.
        editor.addBackstitch(line);
      }
      if (['pencil', 'eraser', 'line', 'rect', 'ellipse', 'move'].includes(drag.tool)) editor.endStroke();
      // A plain click with the rectangle tool clears the selection.
      else if (drag.tool === 'select' && !drag.moved && drag.mode === 'replace') editor.deselect();
      drag = null;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return;
      e.preventDefault(); // no middle-button auto-scroll
      // preventDefault also keeps focus where it was: take it out of any toolbar field, so keys go to the chart again.
      if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
      const p = local(e);
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, p);
      if (pointers.size > 1) endTool(); // a second finger turns the gesture into a pinch
      gesture = pointers.size > 1 || e.button === 1 || space || live.current.tool === 'hand' ? 'pan' : 'tool';
      if (gesture === 'pan') canvas.classList.add('dragging');
      else useTool(e, p);
    };
    const onMove = (e: PointerEvent) => {
      const now = local(e);
      const before = pointers.get(e.pointerId);
      hover = e.pointerType === 'mouse' || before ? now : null;
      if (!before) {
        invalidate();
        return;
      }
      if (gesture === 'tool') {
        dragTool(now, e.shiftKey);
        invalidate();
      } else if (pointers.size === 1) {
        setCamera(panBy(cam, now.x - before.x, now.y - before.y, grid, view));
      } else if (pointers.size === 2) {
        const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)![1];
        const dist = (a: Point) => Math.hypot(a.x - other.x, a.y - other.y) || 1;
        const mid = (a: Point) => ({ x: (a.x + other.x) / 2, y: (a.y + other.y) / 2 });
        const m0 = mid(before);
        const m1 = mid(now);
        setCamera(zoomAt(panBy(cam, m1.x - m0.x, m1.y - m0.y, grid, view), dist(now) / dist(before), m1.x, m1.y, grid, view));
      }
      pointers.set(e.pointerId, now);
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size > 0) return;
      endTool();
      gesture = null;
      canvas.classList.remove('dragging');
    };
    // Holding Space turns any tool into the hand for as long as it is down.
    const onSpace = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('button, input, select, textarea, [role=menubar], dialog')) return;
      e.preventDefault();
      space = e.type === 'keydown';
      canvas.classList.toggle('space', space);
    };
    const onLeave = () => {
      hover = null;
      invalidate();
    };

    // Wheel zooms about the cursor; with Shift it scrolls sideways. Pinch on a trackpad arrives as Ctrl + wheel.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      if (e.shiftKey && !e.ctrlKey) {
        setCamera(panBy(cam, -(e.deltaX || e.deltaY) * lines, 0, grid, view));
        return;
      }
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      setCamera(zoomAt(cam, Math.exp(-e.deltaY * lines * speed), p.x, p.y, grid, view));
    };

    const centreZoom = (factor: number) => setCamera(zoomAt(cam, factor, view.width / 2, view.height / 2, grid, view));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, select, textarea, [role=menubar], dialog')) return;
      const pan: Record<string, [number, number]> = {
        ArrowLeft: [KEY_PAN_PX, 0],
        ArrowRight: [-KEY_PAN_PX, 0],
        ArrowUp: [0, KEY_PAN_PX],
        ArrowDown: [0, -KEY_PAN_PX],
      };
      if (pan[e.key]) setCamera(panBy(cam, pan[e.key][0], pan[e.key][1], grid, view));
      else if (e.key === '+' || e.key === '=') centreZoom(BUTTON_ZOOM);
      else if (e.key === '-') centreZoom(1 / BUTTON_ZOOM);
      else if (e.key === '0') setCamera(fit(grid, view));
      else return;
      e.preventDefault();
    };

    api.current = {
      zoomBy: centreZoom,
      fit: () => setCamera(fit(grid, view)),
      centerOn: (x, y) => setCamera(clamp({ ...cam, x: x - view.width / cam.scale / 2, y: y - view.height / cam.scale / 2 }, grid, view)),
      anchorCell: () => {
        const at = hover ? cellOf(hover) : { x: Math.ceil(cam.x), y: Math.ceil(cam.y) };
        return { x: Math.max(0, Math.min(grid.width - 1, at.x)), y: Math.max(0, Math.min(grid.height - 1, at.y)) };
      },
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onSpace);
    window.addEventListener('keyup', onSpace);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      endTool();
      rendererRef.current = null;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onSpace);
      window.removeEventListener('keyup', onSpace);
      renderer.dispose();
    };
  }, [editor, palette]);

  if (unsupported) return <p className="notice">{t.chart.noWebgl}</p>;
  return (
    <>
      <canvas ref={canvasRef} className="grid-view" data-tool={tool} />
      <div ref={cursorRef} className="brush-cursor" />
    </>
  );
}
