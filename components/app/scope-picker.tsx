"use client";

import { AppCheckbox } from "@/components/ui/app-checkbox";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { SCOPE_AREAS, SCOPE_TEMPLATES, templateName } from "@/lib/auth/scope-areas";
import { SCOPES, canGrant, type Member, type Scope } from "@/lib/auth/scopes";
import { cn } from "@/lib/utils";

/**
 * Settings → Team permission picker: template buttons on top, then one row per
 * area with one checkbox per scope. A box (or template) the caller may not
 * change is disabled and its tooltip says why — the reason comes from canGrant,
 * the same rule the API applies, so the UI never offers what the server refuses.
 */
export function ScopePicker({ me, target, value, onChange, disabled = false }: {
  /** The signed-in member doing the granting. */
  me: Member;
  /** The member being edited as stored (scopes = saved scopes); a new member has none. */
  target: Member;
  /** The ticked scopes being drafted. */
  value: readonly Scope[];
  onChange: (next: Scope[]) => void;
  disabled?: boolean;
}) {
  const ticked = new Set(value);
  const refusal = (next: readonly Scope[]) => {
    const v = canGrant(me, target, next);
    return v.ok ? null : v.error;
  };
  const toggled = (s: Scope) => SCOPES.filter((x) => (x === s ? !ticked.has(x) : ticked.has(x)));

  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">Start from</span>
        {SCOPE_TEMPLATES.map((t) => {
          const reason = refusal(t.scopes);
          return (
            <Tip key={t.id} text={reason}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !!reason}
                onClick={() => onChange([...t.scopes])}
              >
                {t.label}
              </Button>
            </Tip>
          );
        })}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {templateName(value)} · {value.length} of {SCOPES.length}
        </span>
      </div>

      {SCOPE_AREAS.map((area) => (
        <div key={area.id} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[150px_1fr]">
          <p className="text-[13px] font-medium">{area.label}</p>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {area.options.map((o) => {
              const checked = ticked.has(o.scope);
              const reason = refusal(toggled(o.scope));
              const off = disabled || !!reason;
              return (
                <Tip key={o.scope} text={reason} block>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    disabled={off}
                    onClick={() => onChange(toggled(o.scope))}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
                      off ? "cursor-not-allowed" : "cursor-pointer hover:bg-hover",
                    )}
                  >
                    <span aria-hidden className="contents">
                      <AppCheckbox checked={checked} disabled={off} className="mt-0.5" />
                    </span>
                    <span className="min-w-0">
                      <span className={cn("block text-[13px] leading-tight", off && "text-muted-foreground")}>{o.label}</span>
                      <span className="block text-xs text-muted-foreground">{o.description}</span>
                    </span>
                  </button>
                </Tip>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
