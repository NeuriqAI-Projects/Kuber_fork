import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "@/components/ui/pill";
import {
  KANBAN_STAGES,
  STEP_DESCRIPTIONS,
  STATUS_ORDER,
  STATUS_LABELS,
  inputRequiredReason,
  inputRequiredLabel,
  type Lead,
  type LeadScore,
  type LeadStatus,
} from "@/lib/leads";

const STATUS_STYLES: Record<LeadStatus, string> = {
  "Input Required": "bg-yellow-100 text-yellow-800 border-yellow-200/70 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/25",
  New:      "bg-secondary text-muted-foreground border-border",
  Enriching:"bg-amber-100 text-amber-800 border-amber-200/70 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25",
  Enriched: "bg-blue-100 text-blue-800 border-blue-200/70 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/25",
  Open:     "bg-green-100 text-green-800 border-green-200/70 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/25",
  Closed:   "bg-secondary text-muted-foreground border-border",
};

export function StatusBadge({ status, lead }: { status: LeadStatus; lead?: Lead }) {
  // Input Required is two different situations — label them apart:
  // "Needs email" (unusable, red-ish) vs "No website · generic" (usable, yellow).
  if (status === "Input Required" && lead) {
    const reason = inputRequiredReason(lead);
    const cls = reason === "missing_data"
      ? "bg-red-100 text-red-800 border-red-200/70 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/25"
      : "bg-yellow-100 text-yellow-800 border-yellow-200/70 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/25";
    return (
      <Pill
        shape="sm"
        className={cn("gap-1", cls)}
        title={reason === "missing_data"
          ? "Enrichment finished but no email was found — add one before this lead can be contacted"
          : "No usable website/profile — campaigns will use the generic name-swap template"}
      >
        {inputRequiredLabel(lead)}
      </Pill>
    );
  }
  return (
    <Pill shape="sm" className={STATUS_STYLES[status]}>
      {STATUS_LABELS[status]}
    </Pill>
  );
}

export function ScoreBadge({ score }: { score: LeadScore }) {
  if (score === "—") return <span className="text-xs text-muted-foreground/60">—</span>;
  return (
    <Pill
      shape="sm"
      className={cn(
        "font-semibold",
        score === "Hot" ? "bg-orange-100 text-orange-800 border-orange-200/70 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/25" : "bg-blue-100 text-blue-800 border-blue-200/70 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/25",
      )}
    >
      {score}
    </Pill>
  );
}

// Attio gives every person a tinted initials avatar; the tint is picked from
// the name so the same lead always gets the same colour.
const AVATAR_TINTS = [
  "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
  "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-200",
  "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
  "bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
] as const;

function avatarTint(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

export function Avatar({ name, size = "sm" }: { name: string; size?: "xs" | "sm" | "md" | "lg" }) {
  const initials = name.split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className={cn(
      "rounded-full flex items-center justify-center font-semibold shrink-0",
      initials ? avatarTint(name) : "bg-secondary text-muted-foreground",
      size === "xs" && "size-5 text-[9px]",
      size === "sm" && "size-7 text-[11px]",
      size === "md" && "size-10 text-sm",
      size === "lg" && "size-14 text-base",
    )}>
      {initials}
    </div>
  );
}

const STEPPER_STAGES: LeadStatus[] = ["New", "Enriched"];

export function PipelineStepper({ currentStatus }: { currentStatus: LeadStatus }) {
  const stepperStatus: LeadStatus =
    currentStatus === "Input Required" || currentStatus === "New" || currentStatus === "Enriching" ? "New"
    : "Enriched";
  const current = STEPPER_STAGES.indexOf(stepperStatus);
  return (
    <div>
      {STEPPER_STAGES.map((stage, i) => {
        const done = i <= current;
        const active = i === current;
        const last = i === STEPPER_STAGES.length - 1;
        return (
          <div key={stage} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={cn(
                "size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5",
                done && "bg-primary border-primary",
                active && "border-primary",
                !done && !active && "border-border",
              )}>
                {done
                  ? <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />
                  // Digits have no descender, so a mathematically centered line box
                  // reads as sitting visibly high — nudge down to its optical center.
                  : <span className={cn("text-[10px] font-bold translate-y-px", active ? "text-primary" : "text-muted-foreground/30")}>{i + 1}</span>}
              </div>
              {!last && <div className={cn("w-px flex-1 my-1", (done && !active) ? "bg-primary" : "bg-border")} />}
            </div>
            <div className={cn("pb-4", last && "pb-0")}>
              <p className={cn(
                "text-[13px] font-medium",
                active ? "text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/40",
              )}>
                {stage}
              </p>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">{STEP_DESCRIPTIONS[stage]}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
