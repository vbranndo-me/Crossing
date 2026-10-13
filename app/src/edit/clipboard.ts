import type { BrandId } from '../threads/brands.ts';
import type { Clip } from './editor.ts';

/**
 * What Edit > Copy last took. It belongs to the app, not to a chart, so it can be pasted into
 * another chart; the colours are indices of one brand's table, so only into a chart of that brand.
 */
export const clipboard: { clip: Clip | null; brand: BrandId | null } = { clip: null, brand: null };
