import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepperProps {
  steps: string[];
  current: number;
  className?: string;
}

/** Numbered step chips with connecting rails — shared by any multi-step form
 *  flow (Add Leads' Apollo/Excel/Manual wizards, etc). Reused, never redefined
 *  per-form. */
export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <div className={cn("flex items-center", className)}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={label}>
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1 shrink-0",
                active ? "border-primary/40 bg-primary/5" : done ? "border-border bg-field" : "border-border bg-field",
              )}
            >
              <span
                className={cn(
                  "flex items-center justify-center size-[18px] rounded-full text-[11px] leading-none font-semibold tabular-nums shrink-0",
                  active || done ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
                )}
              >
                {done ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : (
                  // Digits have no descender, so a mathematically centered line box
                  // reads as sitting visibly high — nudge down to its optical center.
                  <span className="translate-y-px">{i + 1}</span>
                )}
              </span>
              <span
                className={cn(
                  "text-[13px] font-medium whitespace-nowrap",
                  active ? "text-foreground" : done ? "text-foreground/80" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn("h-px flex-1 min-w-4 mx-1.5", done ? "bg-primary/40" : "bg-border")} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
