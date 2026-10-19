export type TemperatureKey = "hot" | "warm" | "cold" | "neutral" | "ooo" | "unsubscribed";

export const TEMPERATURE_BADGE: Record<
  TemperatureKey,
  { label: string; cls: string }
> = {
  hot: { label: "HOT", cls: "bg-red-100 text-red-800 border-red-200/70 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/25" },
  warm: { label: "WARM", cls: "bg-orange-100 text-orange-800 border-orange-200/70 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/25" },
  cold: { label: "COLD", cls: "bg-sky-100 text-sky-800 border-sky-200/70 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/25" },
  neutral: { label: "NEUTRAL", cls: "bg-secondary text-muted-foreground border-border" },
  ooo: { label: "OUT OF OFFICE", cls: "bg-amber-100 text-amber-800 border-amber-200/70 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25" },
  unsubscribed: { label: "UNSUBSCRIBED", cls: "bg-secondary text-muted-foreground/80 border-border" },
};

export function temperatureBadge(temp: string | null | undefined): { label: string; cls: string } {
  const key = (temp ?? "neutral") as TemperatureKey;
  return TEMPERATURE_BADGE[key] ?? TEMPERATURE_BADGE.neutral;
}
