import { useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { BRANDS, BRAND_IDS } from '../threads/brands.ts';
import type { BrandId } from '../threads/brands.ts';
import { Dialog } from '../ui/Dialog.tsx';

interface Props {
  /** Brand the chart uses now. */
  brand: BrandId;
  /** The user asked to switch the chart to another brand. */
  onConvert(brand: BrandId): void;
  onClose(): void;
}

/** Chart > Thread palette: which brand of thread the chart is made with. */
export function ThreadsDialog({ brand, onConvert, onClose }: Props) {
  const { t } = useI18n();
  const d = t.threads;
  const [chosen, setChosen] = useState(brand);

  return (
    <Dialog title={d.title} onClose={onClose}>
      <div className="form">
        <label className="field">
          <span>{d.brand}</span>
          <select value={chosen} autoFocus onChange={(e) => setChosen(e.target.value as BrandId)}>
            {BRAND_IDS.map((id) => (
              <option key={id} value={id}>
                {d.option(BRANDS[id].name, BRANDS[id].colors.length)}
              </option>
            ))}
          </select>
        </label>
        <p className="form-note">{chosen === brand ? d.current : d.convert}</p>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t.newChart.cancel}
          </button>
          <button type="button" className="button primary" disabled={chosen === brand} onClick={() => onConvert(chosen)}>
            {d.apply}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
