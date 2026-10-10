import { memo } from 'react';
import { LAYERS } from '../edit/editor.ts';
import type { LayerId } from '../edit/editor.ts';
import { useI18n } from '../i18n/index.tsx';
import { Icon } from '../ui/icons.tsx';

export interface LayerState {
  visible: boolean;
  locked: boolean;
}

interface Props {
  layers: Record<LayerId, LayerState>;
  /** Layer the current stitch type draws on. */
  active: LayerId;
  onChange(layer: LayerId, state: LayerState): void;
  /** The row was clicked: draw on this layer. */
  onActivate(layer: LayerId): void;
}

/** The chart's three fixed layers: show / hide and lock each one, and pick the one to draw on. */
export const LayersPanel = memo(function LayersPanel({ layers, active, onChange, onActivate }: Props) {
  const { t } = useI18n();
  return (
    <ul className="layers">
      {/* Listed top-most first, as they are stacked on the chart. */}
      {[...LAYERS].reverse().map((id) => {
        const state = layers[id];
        const name = t.layers[id];
        return (
          <li key={id} className={`layer${active === id ? ' active' : ''}`}>
            <button
              type="button"
              className={`layer-toggle${state.visible ? ' on' : ''}`}
              aria-pressed={state.visible}
              aria-label={t.layersPanel.visible(name)}
              title={t.layersPanel.visible(name)}
              onClick={() => onChange(id, { ...state, visible: !state.visible })}
            >
              <Icon name="eye" />
            </button>
            <button
              type="button"
              className={`layer-toggle${state.locked ? ' on' : ''}`}
              aria-pressed={state.locked}
              aria-label={t.layersPanel.locked(name)}
              title={t.layersPanel.locked(name)}
              onClick={() => onChange(id, { ...state, locked: !state.locked })}
            >
              <Icon name="lock" />
            </button>
            <button type="button" className="layer-name" aria-current={active === id} onClick={() => onActivate(id)}>
              {name}
            </button>
          </li>
        );
      })}
    </ul>
  );
});
