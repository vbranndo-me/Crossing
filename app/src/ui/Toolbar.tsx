import type { ReactNode } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { STITCHES, TOOLS } from '../tools.ts';
import type { StitchId, ToolId } from '../tools.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

interface Props {
  tool: ToolId;
  onTool(tool: ToolId): void;
  /** What the pencil draws and the eraser removes. */
  stitch: StitchId;
  onStitch(stitch: StitchId): void;
  /** Undefined while there is nothing to undo / redo: the button is disabled. */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Extra content at the end of the bar (e.g. the current colour). */
  children?: ReactNode;
}

function ToolButton(props: { icon: IconName; label: string; hint: string; pressed?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      className={`tool${props.pressed ? ' active' : ''}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={`${props.label} (${props.hint})`}
      // A mouse click must not leave focus on the button, or Space (hold to pan) would press it again.
      onMouseDown={(e) => e.preventDefault()}
      disabled={!props.onClick}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

/** The tool bar under the menus: one button per tool, then undo and redo. */
export function Toolbar({ tool, onTool, stitch, onStitch, onUndo, onRedo, children }: Props) {
  const { t } = useI18n();
  return (
    <div className="toolbar" role="toolbar" aria-label={t.toolbar.label}>
      <div className="tool-group">
        {TOOLS.map((def) => (
          <ToolButton key={def.id} icon={def.icon} label={t.tools[def.id]} hint={def.key.toUpperCase()} pressed={tool === def.id} onClick={() => onTool(def.id)} />
        ))}
      </div>
      <div className="tool-group" role="group" aria-label={t.toolbar.stitchType}>
        {STITCHES.map((def) => (
          <ToolButton key={def.id} icon={def.icon} label={t.stitches[def.id]} hint={def.key} pressed={stitch === def.id} onClick={() => onStitch(def.id)} />
        ))}
      </div>
      <div className="tool-group">
        <ToolButton icon="undo" label={t.menu.undo} hint="Ctrl+Z" onClick={onUndo} />
        <ToolButton icon="redo" label={t.menu.redo} hint="Ctrl+Y" onClick={onRedo} />
      </div>
      {children}
    </div>
  );
}
