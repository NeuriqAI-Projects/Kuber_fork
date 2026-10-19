"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import { INTEREST_FILTER_OPTIONS } from "@/components/app/unibox/unibox-status-filter";

const INTEREST_OPTIONS: { value: number | null; label: string; dot: string }[] = [
  { value: null, label: "Lead", dot: "bg-muted-foreground/50" },
  ...INTEREST_FILTER_OPTIONS.filter((o) => o.value !== "lead").map((o) => ({
    value: o.value as number,
    label: o.label,
    dot: o.dot,
  })),
];

function currentOption(interestStatus: number | null) {
  return INTEREST_OPTIONS.find((o) => o.value === interestStatus)
    ?? INTEREST_OPTIONS.find((o) => o.value === null)!;
}

type Props = {
  interestStatus: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  /** "button" = outline h-8 control (thread header); "inline" = borderless value
   *  that fits a Details-rail row. */
  variant?: "button" | "inline";
  className?: string;
};

export function UniboxInstantlyInterestMenu({ interestStatus, onChange, disabled, variant = "button", className }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = currentOption(interestStatus);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return INTEREST_OPTIONS;
    return INTEREST_OPTIONS.filter((o) => o.label.toLowerCase().includes(q));
  }, [search]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={variant === "inline" ? "ghost" : "outline"}
          disabled={disabled}
          title="Instantly status"
          className={cn(
            "gap-1.5 font-normal data-[state=open]:bg-hover",
            variant === "inline" ? "-ml-2 h-7 max-w-full px-2" : "h-8 px-2.5",
            className,
          )}
        >
          <span className={cn("size-2 shrink-0 rounded-full", current.dot)} />
          <span className="truncate">{current.label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={variant === "inline" ? "start" : "end"} className="w-56 p-0 overflow-hidden">
        <div className="p-1.5 border-b border-border">
          <SearchInput value={search} onChange={setSearch} placeholder="Instantly status…" size="sm" />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.map((o) => {
            const selected = interestStatus === o.value || (o.value === null && interestStatus === null);
            return (
              <button
                key={o.label}
                type="button"
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground transition-colors hover:bg-hover",
                  selected && "bg-accent",
                )}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <span className={cn("size-2 shrink-0 rounded-full", o.dot)} />
                <span className="flex-1 truncate">{o.label}</span>
                {selected && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
          {filtered.length === 0 && <p className="py-3 text-center text-[13px] text-muted-foreground">No matches</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
