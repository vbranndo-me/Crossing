export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface Autosaver {
  /** Something changed: save soon. */
  touch(): void;
  /** Save now if there is anything to save; resolves when it is on disk (or has failed). */
  flush(): Promise<void>;
  /** There are changes that have not been saved yet. */
  readonly dirty: boolean;
  dispose(): void;
}

/**
 * Saves a little while after the last change, never two saves at once, and never loses a
 * change made while a save was running.
 */
export function createAutosaver(save: () => Promise<void>, onState: (state: SaveState) => void, delayMs = 1500): Autosaver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let running: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    while (running) await running;
    if (!dirty) return;
    dirty = false;
    onState('saving');
    running = save()
      .then(
        () => onState(dirty ? 'pending' : 'saved'),
        () => {
          dirty = true;
          onState('error');
        },
      )
      .finally(() => {
        running = null;
      });
    await running;
  };

  return {
    touch() {
      dirty = true;
      onState('pending');
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    get dirty() {
      return dirty || running !== null;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
