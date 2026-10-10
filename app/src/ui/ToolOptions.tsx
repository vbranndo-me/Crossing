import type { PaletteEntry } from '../core/palette.ts';
import type { BrushShape } from '../edit/editor.ts';
import { MAX_BRUSH } from '../edit/editor.ts';
import { useI18n } from '../i18n/index.tsx';
import type { ToolId } from '../tools.ts';
import { Icon } from './icons.tsx';

export type FillMode = 'solid' | 'gradient';

export interface ToolSettings {
  brushSize: number;
  brushShape: BrushShape;
  fillMode: FillMode;
}

interface Props {
  tool: ToolId;
  settings: ToolSettings;
  onChange(patch: Partial<ToolSettings>): void;
  /** The two colours the gradient runs between, and how to change each. */
  gradient: { start: PaletteEntry; end: PaletteEntry };
  onPickGradient(which: 'start' | 'end'): void;
}

/** The part of the toolbar that depends on the tool: brush for pencil and eraser, fill type for the bucket. */
export function ToolOptions({ tool, settings, onChange, gradient, onPickGradient }: Props) {
  const { t } = useI18n();
  const o = t.toolOptions;
  const size = (value: number) => onChange({ brushSize: Math.max(1, Math.min(MAX_BRUSH, Math.round(value) || 1)) });
  // Keep focus off these buttons after a mouse click, so Space (hold to pan) is not swallowed.
  const noFocus = { onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() };

  if (tool === 'pencil' || tool === 'eraser') {
    return (
      <div className="tool-options" role="group" aria-label={o.brush}>
        <label className="option-label" htmlFor="brush-size">
          {o.size}
        </label>
        <button type="button" className="tool small" aria-label={o.smaller} title={`${o.smaller} ([)`} {...noFocus} onClick={() => size(settings.brushSize - 1)}>
          −
        </button>
        <input id="brush-size" className="option-number" type="number" min={1} max={MAX_BRUSH} value={settings.brushSize}
          onChange={(e) => size(Number(e.target.value))}
          // Enter or Escape: done typing, back to the chart.
          onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && e.currentTarget.blur()}
        />
        <button type="button" className="tool small" aria-label={o.larger} title={`${o.larger} (])`} {...noFocus} onClick={() => size(settings.brushSize + 1)}>
          +
        </button>
        {(['round', 'square'] as const).map((shape) => (
          <button
            key={shape}
            type="button"
            className={`tool${settings.brushShape === shape ? ' active' : ''}`}
            aria-label={o[shape]}
            aria-pressed={settings.brushShape === shape}
            title={o[shape]}
            {...noFocus}
            onClick={() => onChange({ brushShape: shape })}
          >
            <Icon name={shape === 'round' ? 'brushRound' : 'brushSquare'} />
          </button>
        ))}
      </div>
    );
  }

  if (tool === 'fill') {
    return (
      <div className="tool-options" role="group" aria-label={o.fill}>
        {(['solid', 'gradient'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`tool text${settings.fillMode === mode ? ' active' : ''}`}
            aria-pressed={settings.fillMode === mode}
            {...noFocus}
            onClick={() => onChange({ fillMode: mode })}
          >
            {o[mode]}
          </button>
        ))}
        {settings.fillMode === 'gradient' &&
          (['start', 'end'] as const).map((which) => (
            <button key={which} type="button" className="current-color inline" title={o.gradientColor[which]} {...noFocus} onClick={() => onPickGradient(which)}>
              <span className="option-label">{o.gradientLabel[which]}</span>
              <i className="swatch" style={{ background: `rgb(${gradient[which].rgb.join(',')})` }} />
              <span>{gradient[which].code}</span>
            </button>
          ))}
      </div>
    );
  }
  return null;
}
