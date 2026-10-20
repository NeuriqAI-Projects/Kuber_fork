"use client";

// The non-text pieces of an assistant answer: the live "what I'm looking up"
// steps, and the confirm cards for actions.
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Check, ChevronRight, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { cn } from "@/lib/utils";

type ToolOutput = Record<string, unknown> | undefined;

/** Running label, and a done label built from the tool's own result. */
const TOOL_LABELS: Record<string, { running: string; done: (o: ToolOutput) => string }> = {
  pipeline_overview: { running: "Checking the pipeline", done: () => "Checked the pipeline" },
  search_leads: { running: "Searching leads", done: (o) => `Found ${fmt(o?.total)} lead${o?.total === 1 ? "" : "s"}` },
  lead_breakdown: { running: "Counting leads", done: (o) => `Counted ${fmt(o?.total_leads)} leads by ${String(o?.group_by ?? "group").replace("_", " ")}` },
  get_lead: { running: "Opening the lead", done: (o) => (o?.ambiguous ? "Found several matches" : `Read ${o?.name ?? "lead"}`) },
  search_organizations: { running: "Searching companies", done: (o) => `Found ${fmt(o?.total)} compan${o?.total === 1 ? "y" : "ies"}` },
  get_organization: { running: "Opening the company", done: (o) => (o?.ambiguous ? "Found several matches" : `Read ${o?.name ?? "company"}`) },
  list_campaigns: { running: "Looking at campaigns", done: (o) => `Looked at ${fmt(o?.total)} campaign${o?.total === 1 ? "" : "s"}` },
  get_campaign: { running: "Opening the campaign", done: (o) => `Read ${o?.name ? `"${o.name}"` : "campaign"}` },
  search_inbox: { running: "Searching the inbox", done: (o) => `Found ${fmt(o?.matching_threads)} conversation${o?.matching_threads === 1 ? "" : "s"}` },
  get_thread: { running: "Reading the conversation", done: (o) => `Read ${fmt(o?.total_messages)} email${o?.total_messages === 1 ? "" : "s"}` },
  team_overview: { running: "Checking the team", done: (o) => `Checked ${Array.isArray(o?.members) ? o.members.length : ""} teammates` },
  recent_activity: { running: "Checking recent activity", done: (o) => `Read ${fmt(o?.total_events)} events` },
  drafts_overview: { running: "Checking drafts", done: (o) => `${fmt(o?.email_drafts)} drafts` },
  usage_and_credits: { running: "Checking usage and credits", done: () => "Checked usage and credits" },
};

function fmt(v: unknown): string {
  return typeof v === "number" ? v.toLocaleString() : "the";
}

export type ToolPartLike = {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export function toolNameOf(part: { type: string }): string {
  return part.type.startsWith("tool-") ? part.type.slice(5) : part.type;
}

export function isActionTool(name: string): boolean {
  return name.startsWith("propose_");
}

/** One line per lookup the assistant made, so a slow answer never looks stuck. */
export function ToolSteps({ parts }: { parts: ToolPartLike[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-0.5">
      {parts.map((p) => {
        const name = toolNameOf(p);
        const labels = TOOL_LABELS[name] ?? { running: "Working", done: () => "Done" };
        const out = p.output as ToolOutput;
        const failed = p.state === "output-error" || (p.state === "output-available" && typeof out?.error === "string");
        const done = p.state === "output-available" && !failed;
        const running = !done && !failed;
        const detail = typeof out?.filter === "string" ? out.filter : typeof out?.error === "string" ? out.error : p.errorText ?? null;
        const expanded = open === p.toolCallId;
        return (
          <div key={p.toolCallId}>
            <button
              type="button"
              onClick={() => detail && setOpen(expanded ? null : p.toolCallId)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12.5px] text-muted-foreground",
                detail && "hover:bg-hover hover:text-foreground transition-colors",
              )}
            >
              {running && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
              {done && <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
              {failed && <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}
              <span className="truncate">{running ? `${labels.running}…` : failed ? `${labels.running} — couldn't` : labels.done(out)}</span>
              {detail && <ChevronRight className={cn("ml-auto size-3 shrink-0", expanded && "rotate-90")} />}
            </button>
            {expanded && detail && <p className="ml-6 pb-1 text-[12px] text-muted-foreground/90">{detail}</p>}
          </div>
        );
      })}
    </div>
  );
}

export type ActionProposalView = {
  token: string;
  kind: string;
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  warnings: string[];
  apollo_credits?: number;
  uses_ai?: boolean;
  confirm_label: string;
};

export type ActionOutcome = { ok: boolean; message: string; link?: string };

/**
 * The confirm card. The assistant can only propose; this button is the only
 * way an action runs, and it says exactly what it will do (and what it costs).
 */
export function ActionCard({
  part,
  onConfirm,
  onCancel,
  disabled,
}: {
  part: ToolPartLike;
  onConfirm: (proposal: ActionProposalView) => Promise<void>;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const out = part.output as { proposal?: ActionProposalView; error?: string; executed?: ActionOutcome; cancelled?: boolean } | undefined;

  if (part.state !== "output-available" && part.state !== "output-error") {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-[12.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Preparing the action…
      </div>
    );
  }
  if (!out?.proposal) {
    return (
      <div className="flex items-start gap-1.5 px-1 py-0.5 text-[12.5px] text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>{out?.error ?? part.errorText ?? "This action could not be prepared."}</span>
      </div>
    );
  }

  const p = out.proposal;
  const executed = out.executed;
  const settled = !!executed || !!out.cancelled;

  return (
    <div className={cn("rounded-lg border bg-card shadow-xs", executed?.ok ? "border-emerald-300/70 dark:border-emerald-500/30" : "border-border")}>
      <div className="flex items-start gap-2.5 px-3 pt-3">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Sparkles className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug">{p.title}</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{p.summary}</p>
        </div>
      </div>

      {p.details.length > 0 && (
        <dl className="mx-3 mt-2.5 divide-y divide-border rounded-md border border-border">
          {p.details.map((d) => (
            <div key={d.label} className="flex gap-3 px-2.5 py-1.5 text-[12.5px]">
              <dt className="w-20 shrink-0 text-muted-foreground">{d.label}</dt>
              <dd className="min-w-0 flex-1 break-words tabular-nums">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {p.warnings.length > 0 && (
        <ul className="mx-3 mt-2 space-y-1">
          {p.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-[12px] text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}

      {typeof p.apollo_credits === "number" && p.apollo_credits > 0 && (
        <ApolloCostNote className="mx-3 mt-2.5" credits={p.apollo_credits} spendingOn="to reveal these emails" rate="1 credit per email revealed." />
      )}
      {p.uses_ai && !settled && (
        <p className="mx-3 mt-2 text-[12px] text-muted-foreground">Uses your AI provider (billed per token, shown in Credits &gt; AI).</p>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-border px-3 py-2">
        {executed ? (
          <div className="flex min-w-0 flex-1 items-start gap-1.5 text-[12.5px]">
            {executed.ok
              ? <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
            <span className={cn("min-w-0", !executed.ok && "text-destructive")}>{executed.message}</span>
            {executed.link && (
              <Link href={executed.link} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-primary hover:underline">
                Open <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
        ) : out.cancelled ? (
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground"><X className="size-3.5" /> Cancelled</span>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy || disabled}
              onClick={async () => {
                setBusy(true);
                try { await onConfirm(p); } finally { setBusy(false); }
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              {p.confirm_label}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          </>
        )}
      </div>
    </div>
  );
}
