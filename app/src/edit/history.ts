/** One undoable step: how to revert it, how to apply it again, and roughly how much memory it holds. */
export interface Action {
  bytes: number;
  undo(): void;
  redo(): void;
}

const MAX_ACTIONS = 1000;
const MAX_BYTES = 256 * 2 ** 20;

/** Undo / redo stack. The oldest actions are forgotten once it holds too many or too much. */
export class History {
  private actions: Action[] = [];
  private cursor = 0;
  private bytes = 0;

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.actions.length;
  }

  /** While set, pushed actions are collected here instead (see `group`). */
  private open: Action[] | null = null;

  /** Everything pushed while `work` runs becomes a single step. */
  group(work: () => void): void {
    if (this.open) return work();
    const parts: Action[] = (this.open = []);
    try {
      work();
    } finally {
      this.open = null;
    }
    if (parts.length === 1) this.push(parts[0]);
    else if (parts.length > 1) {
      this.push({
        bytes: parts.reduce((sum, p) => sum + p.bytes, 0),
        undo: () => {
          for (let k = parts.length - 1; k >= 0; k--) parts[k].undo();
        },
        redo: () => {
          for (const p of parts) p.redo();
        },
      });
    }
  }

  /** Record an action that has already been applied. Anything that had been undone is dropped. */
  push(action: Action): void {
    if (this.open) {
      this.open.push(action);
      return;
    }
    for (const dropped of this.actions.splice(this.cursor)) this.bytes -= dropped.bytes;
    this.actions.push(action);
    this.bytes += action.bytes;
    while (this.actions.length > 1 && (this.actions.length > MAX_ACTIONS || this.bytes > MAX_BYTES)) {
      this.bytes -= this.actions.shift()!.bytes;
    }
    this.cursor = this.actions.length;
  }

  undo(): void {
    if (this.cursor > 0) this.actions[--this.cursor].undo();
  }

  redo(): void {
    if (this.cursor < this.actions.length) this.actions[this.cursor++].redo();
  }
}
