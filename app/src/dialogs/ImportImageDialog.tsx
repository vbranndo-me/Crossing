import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { createConverter } from '../convert/converter.ts';
import type { Converter, StageOutput } from '../convert/converter.ts';
import { DEFAULT_SETTINGS, MAX_COLORS, MAX_CONFETTI, MAX_MIN_STITCHES, MIN_COLORS, SIZE_METHODS } from '../convert/pipeline.ts';
import type { PipelineSettings, SizeMethod, Stage } from '../convert/pipeline.ts';
import { MAX_THICKNESS } from '../convert/pixeloe.ts';
import { cropFor } from '../convert/resample.ts';
import { useI18n } from '../i18n/index.tsx';
import { DEFAULT_FABRIC_COUNT, FABRIC_COUNTS, MAX_SIDE, finishedCm } from '../project.ts';
import { BRANDS, BRAND_IDS, DEFAULT_BRAND, paletteFor } from '../threads/brands.ts';
import type { BrandId } from '../threads/brands.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Icon } from '../ui/icons.tsx';
import { CropPreview } from './CropPreview.tsx';

export interface ImportedChart {
  name: string;
  brand: BrandId;
  fabricCount: number;
  width: number;
  height: number;
  cells: Uint16Array;
}

interface Props {
  onCreate(chart: ImportedChart): void;
  onClose(): void;
}

interface Source {
  file: File;
  url: string;
  width: number;
  height: number;
}

/**
 * The wizard's steps, in order. Each one shows the image as it leaves a stage of the pipeline
 * (`shows`) and, where there is something to compare with, as it entered it (`from`).
 */
const STEPS = [
  { id: 'image', shows: null, from: null },
  { id: 'size', shows: 'size', from: null },
  { id: 'adjust', shows: 'adjust', from: 'size' },
  { id: 'colors', shows: 'colors', from: 'adjust' },
  { id: 'cleanup', shows: 'cleanup', from: 'colors' },
  { id: 'review', shows: 'cleanup', from: null },
] as const satisfies readonly { id: string; shows: Stage | null; from: Stage | null }[];
type StepId = (typeof STEPS)[number]['id'];
type View = 'after' | 'before' | 'original';

const DEFAULT_WIDTH = 100;
/** Wait this long after the last change before converting, so dragging a slider does not flood the worker. */
const SETTLE_MS = 120;

function Slider(props: { label: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

/** File > Import image: a step-by-step conversion of a picture into a chart, one pipeline stage per step. */
export function ImportImageDialog({ onCreate, onClose }: Props) {
  const { t, locale, formatNumber } = useI18n();
  const d = t.importImage;
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source | null>(null);
  const [readError, setReadError] = useState(false);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState<BrandId>(DEFAULT_BRAND);
  const [fabricCount, setFabricCount] = useState(DEFAULT_FABRIC_COUNT);
  const [widthText, setWidthText] = useState(String(DEFAULT_WIDTH));
  const [heightText, setHeightText] = useState(String(DEFAULT_WIDTH));
  /** Height follows width (and the other way round) in the picture's proportions. */
  const [locked, setLocked] = useState(true);
  /** With other proportions only part of the picture fits: where that part sits, 0 to 1 each way. */
  const [cropAt, setCropAt] = useState({ x: 0.5, y: 0.5 });
  const [settings, setSettings] = useState<PipelineSettings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>('after');
  /** What the worker last produced, and the request it answers (so an older answer is never taken for the current one). */
  const [produced, setProduced] = useState<{ output: StageOutput; key: string } | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [dragging, setDragging] = useState(false);
  const converter = useRef<Converter | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const current = STEPS[step];
  const palette = paletteFor(brand);

  useEffect(() => {
    const made = createConverter();
    converter.current = made;
    return () => made.dispose();
  }, []);
  useEffect(() => () => void (source && URL.revokeObjectURL(source.url)), [source]);

  // Chart size, in stitches. While the proportion is locked, typing one side sets the other.
  const side = (text: string) => (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= MAX_SIDE ? Number(text) : null);
  const width = side(widthText);
  const height = side(heightText);
  const within = (v: number) => String(Math.max(1, Math.min(MAX_SIDE, Math.round(v))));
  const typeWidth = (text: string) => {
    setWidthText(text);
    if (locked && source && side(text)) setHeightText(within((side(text)! * source.height) / source.width));
  };
  const typeHeight = (text: string) => {
    setHeightText(text);
    if (locked && source && side(text)) setWidthText(within((side(text)! * source.width) / source.height));
  };
  const toggleLock = () => {
    if (locked) {
      // Free proportions: show the picture with the frame, since part of it may now be left out.
      setView('original');
    } else if (source && width) {
      setHeightText(within((width * source.height) / source.width));
      setCropAt({ x: 0.5, y: 0.5 });
    }
    setLocked(!locked);
  };
  /** The part of the picture that becomes the chart. */
  const crop = useMemo(() => (source && width && height ? cropFor(source.width, source.height, width, height, cropAt) : null), [source, width, height, cropAt]);
  const cropped = crop !== null && source !== null && (crop.width < source.width || crop.height < source.height);

  /** Change the settings of one stage. */
  const change = <K extends keyof PipelineSettings>(stage: K, patch: Partial<PipelineSettings[K]>) =>
    setSettings((now) => ({ ...now, [stage]: { ...now[stage], ...patch } }));

  const load = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const next = { file, url: URL.createObjectURL(file), width: bitmap.width, height: bitmap.height };
      bitmap.close();
      setSource(next);
      setReadError(false);
      setProduced(null);
      setName(file.name.replace(/\.[^.]+$/, '').slice(0, 80));
      // Start at 100 stitches on the longer side.
      const scale = DEFAULT_WIDTH / Math.max(next.width, next.height);
      setWidthText(String(Math.max(1, Math.round(next.width * scale))));
      setHeightText(String(Math.max(1, Math.round(next.height * scale))));
      setLocked(true);
      setCropAt({ x: 0.5, y: 0.5 });
    } catch {
      setReadError(true);
    }
  };

  // Which stage the preview needs: the one this step ends on, or the one before it for "before".
  const stage: Stage | null = view === 'original' ? null : view === 'before' ? current.from : current.shows;

  // Everything the preview depends on, as one value.
  const requestKey = source && crop && width && height && stage ? JSON.stringify([source.url, crop, width, height, brand, settings, stage]) : '';

  // Run the pipeline again whenever something that affects what is shown changes.
  useEffect(() => {
    if (!source || !crop || !width || !height || !stage) return;
    setState('working');
    const timer = setTimeout(() => {
      converter.current?.request({ image: source.file, crop, width, height, brand, settings, upTo: stage }, (done) => {
        setProduced(done && { output: done, key: requestKey });
        setState(done ? 'idle' : 'error');
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // requestKey stands for all of the request's inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);
  const output = produced?.output ?? null;

  // Paint what the stage produced, one pixel per stitch; CSS enlarges it.
  const showsCanvas = source !== null && stage !== null;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !output) return;
    el.width = output.width;
    el.height = output.height;
    const image = new ImageData(output.width, output.height);
    if ('pixels' in output) {
      image.data.set(output.pixels);
    } else {
      const pixels = new Uint32Array(image.data.buffer);
      const { rgb } = paletteFor(brand);
      for (let i = 0; i < output.cells.length; i++) {
        const o = output.cells[i] * 3;
        pixels[i] = 0xff000000 | (rgb[o + 2] << 16) | (rgb[o + 1] << 8) | rgb[o];
      }
    }
    el.getContext('2d')!.putImageData(image, 0, 0);
    // `brand` is not a dependency: a new brand triggers a new conversion, and painting the old
    // indices with the new palette in between would flash wrong colours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, showsCanvas]);

  /** The chart as it will be created: only when the last stage is what is showing, for the current settings. */
  const chart = produced && produced.key === requestKey && 'cells' in produced.output && stage === 'cleanup' ? produced.output : null;

  // Review: every thread in the chart, most used first.
  const threads = useMemo(() => {
    if (!chart || current.id !== 'review') return [];
    const counts = new Map<number, number>();
    for (const v of chart.cells) if (v !== 0) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [chart, current.id]);

  const go = (to: number) => {
    setStep(to);
    setView('after');
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void load(e.dataTransfer.files[0]);
  };

  const one = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const { adjust, colors, cleanup } = settings;

  const controls: Record<StepId, ReactNode> = {
    image: (
      <>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void load(e.target.files?.[0])} />
        <button type="button" className="button" autoFocus onClick={() => fileInput.current?.click()}>
          {source ? d.change : d.choose}
        </button>
        {readError && <p className="form-note short error">{d.readError}</p>}
        {source && <p className="form-note short">{d.imageInfo(source.file.name, source.width, source.height)}</p>}
      </>
    ),
    size: (
      <>
        <div className="import-size">
          <label className="field">
            <span>{t.newChart.width}</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_SIDE} step={1} value={widthText} aria-invalid={width === null} onChange={(e) => typeWidth(e.target.value)} />
          </label>
          <button type="button" className={`tool${locked ? ' active' : ''}`} aria-pressed={locked} aria-label={d.lock} title={locked ? d.lockOn : d.lockOff} onClick={toggleLock}>
            <Icon name="lock" />
          </button>
          <label className="field">
            <span>{t.newChart.height}</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_SIDE} step={1} value={heightText} aria-invalid={height === null} onChange={(e) => typeHeight(e.target.value)} />
          </label>
        </div>
        {(width === null || height === null) && <p className="form-note short error">{d.sizeRange(MAX_SIDE)}</p>}
        {cropped && <p className="form-note short">{d.cropNote}</p>}
        <label className="field">
          <span>{d.sampling}</span>
          <select value={settings.size.method} onChange={(e) => change('size', { method: e.target.value as SizeMethod })}>
            {SIZE_METHODS.map((m) => (
              <option key={m} value={m}>
                {d.methods[m]}
              </option>
            ))}
          </select>
        </label>
        {settings.size.method === 'pixeloe' && (
          <>
            <Slider label={d.thickness(settings.size.thickness)} min={0} max={MAX_THICKNESS} value={settings.size.thickness} onChange={(v) => change('size', { thickness: v })} />
            <p className="form-note short">{d.pixeloeNote}</p>
          </>
        )}
        <label className="field">
          <span>{t.newChart.fabric}</span>
          <select value={fabricCount} onChange={(e) => setFabricCount(Number(e.target.value))}>
            {FABRIC_COUNTS.map((c) => (
              <option key={c} value={c}>
                {t.newChart.fabricCount(c)}
              </option>
            ))}
          </select>
        </label>
        {width && height && <p className="form-note short">{d.finished(one.format(finishedCm(width, fabricCount)), one.format(finishedCm(height, fabricCount)))}</p>}
      </>
    ),
    adjust: (
      <>
        <Slider label={d.brightness(adjust.brightness)} min={-100} max={100} value={adjust.brightness} onChange={(v) => change('adjust', { brightness: v })} />
        <Slider label={d.contrast(adjust.contrast)} min={-100} max={100} value={adjust.contrast} onChange={(v) => change('adjust', { contrast: v })} />
        <Slider label={d.saturation(adjust.saturation)} min={-100} max={100} value={adjust.saturation} onChange={(v) => change('adjust', { saturation: v })} />
        <button type="button" className="button" onClick={() => change('adjust', DEFAULT_SETTINGS.adjust)}>
          {d.reset}
        </button>
      </>
    ),
    colors: (
      <>
        <label className="field">
          <span>{t.threads.brand}</span>
          <select value={brand} onChange={(e) => setBrand(e.target.value as BrandId)}>
            {BRAND_IDS.map((id) => (
              <option key={id} value={id}>
                {t.threads.option(BRANDS[id].name, BRANDS[id].colors.length)}
              </option>
            ))}
          </select>
        </label>
        <Slider label={d.maxColors(colors.maxColors)} min={MIN_COLORS} max={MAX_COLORS} value={colors.maxColors} onChange={(v) => change('colors', { maxColors: v })} />
        <label className="field">
          <span>{d.dither}</span>
          <select value={colors.dither} onChange={(e) => change('colors', { dither: e.target.value as 'none' | 'floyd' })}>
            <option value="none">{d.ditherNone}</option>
            <option value="floyd">{d.ditherFloyd}</option>
          </select>
        </label>
        {colors.dither !== 'none' && <Slider label={d.ditherAmount(colors.ditherAmount)} min={0} max={100} value={colors.ditherAmount} onChange={(v) => change('colors', { ditherAmount: v })} />}
      </>
    ),
    cleanup: (
      <>
        <Slider label={cleanup.confetti ? d.confetti(cleanup.confetti) : d.confettiOff} min={0} max={MAX_CONFETTI} value={cleanup.confetti} onChange={(v) => change('cleanup', { confetti: v })} />
        <Slider label={cleanup.minStitches ? d.minStitches(cleanup.minStitches) : d.minStitchesOff} min={0} max={MAX_MIN_STITCHES} value={cleanup.minStitches} onChange={(v) => change('cleanup', { minStitches: v })} />
        <button type="button" className="button" onClick={() => change('cleanup', DEFAULT_SETTINGS.cleanup)}>
          {d.reset}
        </button>
      </>
    ),
    review: (
      <>
        <label className="field">
          <span>{t.newChart.name}</span>
          <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <ul className="import-threads" aria-label={d.threads}>
          {threads.map(([index, count]) => {
            const e = palette.entries[index];
            return (
              <li key={index}>
                <i className="swatch" style={{ background: `rgb(${e.rgb.join(',')})` }} />
                <span className="code">{e.code}</span>
                <span className="name">{e.name}</span>
                <span className="count">{formatNumber(count)}</span>
              </li>
            );
          })}
        </ul>
      </>
    ),
  };

  const views: View[] = current.id === 'image' ? [] : current.from ? ['after', 'before', 'original'] : ['after', 'original'];

  return (
    <Dialog title={d.title} onClose={onClose} wide staysOpen>
      <div className="import">
        <ol className="import-steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={`import-step${i === step ? ' active' : ''}`} aria-current={i === step ? 'step' : undefined} disabled={!source && i > 0} onClick={() => go(i)}>
                <span className="import-step-number">{i + 1}</span>
                {d.steps[s.id]}
              </button>
            </li>
          ))}
        </ol>

        <div className="form import-settings">
          <p className="import-hint">{d.hints[current.id]}</p>
          {controls[current.id]}
        </div>

        <div className="import-preview">
          <div className="import-tabs" role="group" aria-label={d.view}>
            {views.map((v) => (
              <button key={v} type="button" className={`tool text${view === v ? ' active' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>
                {d.views[v]}
              </button>
            ))}
            <span className="import-state" role="status">
              {state === 'working' && showsCanvas ? d.working : state === 'error' ? d.convertError : ''}
            </span>
          </div>
          <div
            className={`import-stage${dragging ? ' dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
          >
            {!source ? (
              <p className="notice">{d.empty}</p>
            ) : showsCanvas ? (
              <canvas ref={canvas} className={output ? undefined : 'pending'} />
            ) : crop && cropped ? (
              <CropPreview url={source.url} width={source.width} height={source.height} crop={crop} onMove={setCropAt} label={d.cropFrame} />
            ) : (
              <img src={source.url} alt="" />
            )}
          </div>
          <p className="form-note short" role="status">
            {!source || !showsCanvas || !output
              ? ''
              : 'cells' in output
                ? d.chartStats(output.width, output.height, output.stats.colors, formatNumber(output.stats.isolated), one.format(output.stats.stitches ? (100 * output.stats.isolated) / output.stats.stitches : 0))
                : d.imageStats(output.width, output.height)}
          </p>
        </div>

        <div className="form-actions import-actions">
          <button type="button" className="button" onClick={onClose}>
            {t.newChart.cancel}
          </button>
          <span className="spacer" />
          <button type="button" className="button" disabled={step === 0} onClick={() => go(step - 1)}>
            {d.back}
          </button>
          {current.id === 'review' ? (
            <button
              type="button"
              className="button primary"
              disabled={!chart}
              onClick={() => chart && onCreate({ name: name.trim() || t.newChart.defaultName, brand, fabricCount, width: chart.width, height: chart.height, cells: chart.cells })}
            >
              {d.create}
            </button>
          ) : (
            <button type="button" className="button primary" disabled={!source || width === null || height === null} onClick={() => go(step + 1)}>
              {d.next}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
