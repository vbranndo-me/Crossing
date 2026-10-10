import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export type MenuItem =
  | 'separator'
  | {
      label: string;
      shortcut?: string;
      /** Shows a check mark; undefined for plain commands. */
      checked?: boolean;
      /** Missing for commands that do not exist yet: the bar reports them through onUnavailable. */
      onSelect?: () => void;
    };

export interface Menu {
  label: string;
  items: MenuItem[];
}

interface Props {
  menus: Menu[];
  onUnavailable(path: string): void;
}

/** Classic application menu bar: click to open, hover to switch, arrows / Enter / Escape on the keyboard. */
export function MenuBar({ menus, onUnavailable }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const show = (index: number | null) => {
    setOpen(index);
    setActive(-1);
  };

  const select = (menu: Menu, item: MenuItem) => {
    if (item === 'separator') return;
    show(null);
    if (item.onSelect) item.onSelect();
    else onUnavailable(`${menu.label} › ${item.label.replace('…', '')}`);
  };

  /** Next selectable item from `from` in direction `step`, skipping separators. */
  const step = (items: MenuItem[], from: number, dir: number) => {
    for (let k = 1; k <= items.length; k++) {
      const i = (from + dir * k + items.length * 2) % items.length;
      if (items[i] !== 'separator') return i;
    }
    return -1;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const focused = [...(bar.current?.querySelectorAll<HTMLElement>('.menu-title') ?? [])].indexOf(document.activeElement as HTMLElement);
    const current = open ?? focused;
    if (current < 0) return;
    const focusTitle = (i: number) => bar.current?.querySelectorAll<HTMLElement>('.menu-title')[i]?.focus();
    const items = menus[current].items;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = (current + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length;
      focusTitle(next);
      if (open !== null) show(next);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (open === null) setOpen(current);
      setActive(step(items, open === null ? (dir > 0 ? -1 : 0) : active, dir));
    } else if ((e.key === 'Enter' || e.key === ' ') && open !== null && active >= 0) {
      select(menus[current], items[active]);
    } else if (e.key === 'Escape' && open !== null) {
      show(null);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menubar" role="menubar" ref={bar} onKeyDown={onKeyDown}>
      {menus.map((menu, m) => (
        <div key={menu.label} className="menu">
          <button
            type="button"
            role="menuitem"
            className={`menu-title${open === m ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === m}
            onClick={() => show(open === m ? null : m)}
            onPointerEnter={() => open !== null && open !== m && show(m)}
          >
            {menu.label}
          </button>
          {open === m && (
            <div className="menu-list" role="menu" aria-label={menu.label}>
              {menu.items.map((item, i) =>
                item === 'separator' ? (
                  <div key={i} className="menu-separator" role="separator" />
                ) : (
                  <div
                    key={i}
                    role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={item.checked}
                    className={`menu-item${active === i ? ' active' : ''}`}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => select(menu, item)}
                  >
                    <span className="menu-check">{item.checked ? '✓' : ''}</span>
                    <span className="menu-label">{item.label}</span>
                    <span className="menu-shortcut">{item.shortcut}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
