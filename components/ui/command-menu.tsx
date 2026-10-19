"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type CommandItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Muted text on the right (a shortcut, a section name…). */
  hint?: ReactNode;
  /** Extra words that should match the search besides the label. */
  keywords?: string;
  onSelect: () => void;
};

export type CommandGroup = {
  label: string;
  items: CommandItem[];
  /** Only show this group once something is typed (e.g. record search). */
  searchOnly?: boolean;
};

/** Most items a group shows at once, so a big record list stays fast. */
const MAX_PER_GROUP = 30;

/**
 * Attio's "Quick actions" (⌘K) palette: a search box over grouped items,
 * arrow keys + Enter to pick. It only runs the `onSelect` it's given — the
 * caller decides what each item does (navigate, open a drawer…).
 */
export function CommandMenu({
  open,
  onOpenChange,
  groups,
  placeholder = "Search or jump to…",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQuery(""); setActive(0); }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups.filter((g) => !g.searchOnly && g.items.length > 0);
    return groups
      .map((g) => {
        const items: CommandItem[] = [];
        for (const it of g.items) {
          if (`${it.label} ${it.keywords ?? ""}`.toLowerCase().includes(q)) items.push(it);
          if (items.length >= MAX_PER_GROUP) break;
        }
        return { ...g, items };
      })
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const flat = useMemo(() => filtered.flatMap((g) => g.items), [filtered]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(item: CommandItem | undefined) {
    if (!item) return;
    onOpenChange(false);
    item.onSelect();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(flat[active]); }
  }

  let index = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 dark:bg-black/50" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
          className="fixed left-1/2 top-[14vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <DialogPrimitive.Title className="sr-only">Quick actions</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-3.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">Esc</kbd>
          </div>
          <div ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
            {flat.length === 0 && (
              <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">No results</p>
            )}
            {filtered.map((g) => (
              <div key={g.label} className="pb-1">
                <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">{g.label}</p>
                {g.items.map((it) => {
                  index += 1;
                  const i = index;
                  const isActive = i === active;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      data-index={i}
                      onMouseMove={() => setActive(i)}
                      onClick={() => run(it)}
                      className={cn(
                        "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-foreground",
                        isActive && "bg-hover",
                      )}
                    >
                      {it.icon && <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">{it.icon}</span>}
                      <span className="min-w-0 shrink-0 max-w-[60%] truncate">{it.label}</span>
                      <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{it.hint}</span>
                      {isActive && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
