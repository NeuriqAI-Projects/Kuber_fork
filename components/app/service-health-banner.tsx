"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { fetchServiceHealth, type ServiceIssue } from "@/lib/api-client";
import { cn } from "@/lib/utils";

// Red banner for the dashboard — surfaces paid upstream failures (OpenRouter,
// Firecrawl, Apollo, OpenAI) so dead API keys / empty credit balances show as
// clear, actionable messages instead of raw HTTP 402s buried in lead logs.
export function ServiceHealthBanner() {
  const { session } = useApp();
  const [issues, setIssues] = useState<ServiceIssue[]>([]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = () => {
      fetchServiceHealth(session.access_token)
        .then((i) => { if (!cancelled) setIssues(i); })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [session]);

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
