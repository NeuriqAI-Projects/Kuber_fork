import { cn } from "@/lib/utils";
import { getBatchColor, type BatchColorName } from "@/lib/constants";

/** Every tone a Pill can take: the batch palette plus the status-only tones. */
export type PillColor = BatchColorName | "neutral" | "red" | "primary";

/** Status tones that aren't batch colours. Same light/dark pair rule as
 *  BATCH_COLORS (root CLAUDE.md "Tags / status pills"). */
const STATUS_TONES: Record<"neutral" | "red" | "primary", { pill: string; bg: string }> = {
  neutral: { pill: "bg-secondary border-border text-muted-foreground", bg: "bg-muted-foreground" },
  red: {
    pill: "bg-red-100 border-red-200/70 text-red-800 dark:bg-red-500/15 dark:border-red-500/25 dark:text-red-300",
    bg: "bg-red-500",
  },
  primary: { pill: "bg-primary/10 border-primary/20 text-primary", bg: "bg-primary" },
};

function tone(color: PillColor) {
  return color in STATUS_TONES
    ? STATUS_TONES[color as keyof typeof STATUS_TONES]
    : getBatchColor(color);
}

/** Just the tone's fill/border/text classes (light + dark), for tinting a
 *  control that keeps its own shape, e.g. `<Badge variant="outline">`. */
export function pillTone(color: PillColor) {
  return tone(color).pill;
}

/**
 * The Pill's classes as a string, for a chip that has to be another element —
 * a <button> that removes a filter, a link. Prefer <Pill> when a <span> will do.
 */
export function pillClass({
  color = "violet",
  shape = "full",
  className,
}: { color?: PillColor; shape?: "full" | "sm"; className?: string } = {}) {
  // No leading-* here: the text size below sets the line height (a
  // `leading-none` before it was always dropped by tailwind-merge). Dense chips
  // in tight rows pass `className: "leading-none"`.
  return cn(
    "inline-flex items-center justify-center gap-1 rounded-[5px] border font-medium whitespace-nowrap",
    shape === "full" ? "px-1.5 py-[3px] text-xs" : "px-1.5 py-[3px] text-[11px]",
    tone(color).pill,
    className,
  );
}

/** A single reusable colour + text pill — batch tags, status/score chips,
 *  and any other "small coloured label" in the app render through this, so a
 *  palette, shape, or text-alignment fix only needs to happen once.
 *
 *  `color` picks a tone: the batch palette, or a status tone ("neutral" gray,
 *  "red", "primary"). Status maps in screens should pick a `color` rather than
 *  pass light-only bg/text classes: those leave the default violet `dark:`
 *  classes in place and the tag turns violet in dark mode. A one-off colour
 *  that isn't a tone (yellow score chip) may still pass a full light/dark
 *  class set via `className`. */
export function Pill({
  color = "violet",
  dot = false,
  icon,
  shape = "full",
  className,
  children,
  ...rest
}: {
  color?: PillColor;
  dot?: boolean;
  icon?: React.ReactNode;
  /** "full" — an Attio-style tag (batches, leads table). "sm" — a tighter
   *  status/score chip. */
  shape?: "full" | "sm";
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className={pillClass({ color, shape, className })}>
      {dot && <span className={cn("size-1.5 rounded-full shrink-0", tone(color).bg)} />}
      {icon}
      {children}
    </span>
  );
}
