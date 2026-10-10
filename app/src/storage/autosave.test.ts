import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver } from './autosave.ts';
import type { SaveState } from './autosave.ts';

describe('autosaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves once, a while after the last change', async () => {
    const states: SaveState[] = [];
    const save = vi.fn(async () => {});
    const saver = createAutosaver(save, (s) => states.push(s), 1000);
    saver.touch();
    await vi.advanceTimersByTimeAsync(600);
    saver.touch();
    await vi.advanceTimersByTimeAsync(600);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('saved');
    expect(saver.dirty).toBe(false);
  });

  it('flush saves immediately and does nothing when there is nothing to save', async () => {
    const save = vi.fn(async () => {});
    const saver = createAutosaver(save, () => {}, 1000);
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
    saver.touch();
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a change made during a save is saved afterwards', async () => {
    const states: SaveState[] = [];
    let finish = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const saver = createAutosaver(save, (s) => states.push(s), 1000);
    saver.touch();
    const first = saver.flush();
    saver.touch(); // while the first save is running
    finish();
    await first;
    expect(states.at(-1)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a failed save stays dirty and reports the error', async () => {
    const states: SaveState[] = [];
    const saver = createAutosaver(
      () => Promise.reject(new Error('disk full')),
      (s) => states.push(s),
      1000,
    );
    saver.touch();
    await saver.flush();
    expect(states.at(-1)).toBe('error');
    expect(saver.dirty).toBe(true);
  });
});
