import type { LayerId } from './edit/editor.ts';
import type { IconName } from './ui/icons.tsx';

export type ToolId = 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'wand' | 'select' | 'hand' | 'zoom';

export interface ToolDef {
  id: ToolId;
  icon: IconName;
  /** Single key that selects the tool. */
  key: string;
}

/** The tools, in toolbar order. Their names live in the i18n files (tools.<id>). */
export const TOOLS: ToolDef[] = [
  { id: 'pencil', icon: 'pencil', key: 'b' },
  { id: 'eraser', icon: 'eraser', key: 'e' },
  { id: 'fill', icon: 'fill', key: 'g' },
  { id: 'eyedropper', icon: 'eyedropper', key: 'i' },
  { id: 'wand', icon: 'wand', key: 'w' },
  { id: 'select', icon: 'select', key: 'm' },
  { id: 'hand', icon: 'hand', key: 'h' },
  { id: 'zoom', icon: 'zoom', key: 'z' },
];

export const DEFAULT_TOOL: ToolId = 'pencil';

/** What the pencil draws and the eraser removes. */
export type StitchId = 'full' | 'half' | 'quarter' | 'back';

/** Stitch types, in toolbar order. Names in the i18n files (stitches.<id>). */
export const STITCHES: { id: StitchId; icon: IconName; key: string }[] = [
  { id: 'full', icon: 'stitchFull', key: '1' },
  { id: 'half', icon: 'stitchHalf', key: '2' },
  { id: 'quarter', icon: 'stitchQuarter', key: '3' },
  { id: 'back', icon: 'stitchBack', key: '4' },
];

/** The layer each stitch type lives in. */
export const LAYER_OF: Record<StitchId, LayerId> = { full: 'full', half: 'fractional', quarter: 'fractional', back: 'backstitch' };
