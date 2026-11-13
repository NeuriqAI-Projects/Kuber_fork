"use client";

import { AlertTriangle } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { fetchServiceHealth, getAccessToken, useCached } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const HEALTH_MS = 5 * 60_000;
const fetchHealth = async () => fetchServiceHealth(await getAccessToken());

// Red banner for the dashboard — surfaces paid upstream failures (OpenRouter,
// Firecrawl, Apollo, OpenAI) so dead API keys / empty credit balances show as
// clear, actionable messages instead of raw HTTP 402s buried in lead logs.
// One shared cache entry for the five screens that show it: a screen change
// reuses an answer under 5 min old (each mount used to ask again). A Settings
// write marks it stale (query-cache RELATED), so a fixed key shows on the next screen.
export function ServiceHealthBanner() {
  const { session } = useApp();
  const { data } = useCached(session ? "/api/v1/service-health" : null, fetchHealth, { dedupeMs: HEALTH_MS, refreshMs: HEALTH_MS });
  const issues = data ?? [];

  if (issues.length === 0) return null;

  return (
    <div className="space-y-2">
      {issues.map((issue) => (
        <div
          key={issue.service}
          className={cn(
            "flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]",
            issue.severity === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300"
              : "border-red-200 bg-red-50 text-red-900 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300",
          )}
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold">{issue.service} issue:</span> {issue.message}
          </span>
        </div>
      ))}
    </div>
  );
}
