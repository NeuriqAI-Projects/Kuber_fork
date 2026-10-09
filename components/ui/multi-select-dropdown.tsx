"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The multi-select used by every Filters modal (Leads, Organizations). Moved
// out of the leads page so the Organization filter is the same control, not a
// second copy.
export type DropdownOption<T extends string> = {
  value: T;
  label: string;
  dot?: string;
};

export function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: DropdownOption<T>[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function toggle(val: T) {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val); else next.add(val);
    onChange(next);
  }

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={ref} className="relative">
      <p className="eyebrow mb-2">{label}</p>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-auto min-h-9 flex-wrap justify-start gap-1.5 rounded-md px-3 py-1.5 text-left text-sm font-normal bg-field"
      >
        {selected.size === 0 ? (
          <span className="text-muted-foreground text-xs">Select {label.toLowerCase()}…</span>
        ) : (
          options
            .filter((o) => selected.has(o.value))
            .map((o) => (
              <span
                key={o.value}
                className="inline-flex items-center gap-1 bg-secondary border border-border rounded px-1.5 py-0.5 text-xs font-medium"
              >
                {o.dot && <span className={cn("size-1.5 rounded-full shrink-0", o.dot)} />}
                {o.label}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); toggle(o.value); }}
                  onKeyDown={(e) => e.key === "Enter" && toggle(o.value)}
                  className="ml-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <X className="size-2.5" />
                </span>
              </span>
            ))
        )}
        <span className="ml-auto text-muted-foreground shrink-0">
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </Button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-border bg-card shadow-xl overflow-hidden">
          <div className="px-2 py-1.5 border-b border-border">
            <div className="flex items-center gap-2 px-1">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search or type to add…"
                className="h-auto flex-1 border-0 bg-transparent px-0 py-0 text-xs shadow-none outline-none placeholder:text-muted-foreground/60"
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No results</p>
            ) : (
              filtered.map((o) => {
                const active = selected.has(o.value);
                return (
                  <Button
                    key={o.value}
                    type="button"
                    variant="ghost"
                    onClick={() => toggle(o.value)}
                    className={cn(
                      "w-full h-auto justify-start gap-2.5 rounded-none px-3 py-2 text-sm font-normal",
                      active && "bg-secondary"
                    )}
                  >
                    {o.dot && <span className={cn("size-2 rounded-full shrink-0", o.dot)} />}
                    <span className="flex-1 text-left">{o.label}</span>
                    {active && <Check className="size-3.5 text-foreground shrink-0" />}
                  </Button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
