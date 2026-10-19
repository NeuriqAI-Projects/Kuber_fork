"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Building2, Globe2, Mail, Megaphone, Target, User } from "lucide-react";
import { isAppUser } from "@/lib/auth/roles";
import { supabase } from "@/lib/supabase";
import { useCached, cacheKeys, cachedFetchers } from "@/lib/api-client";
import { useApp } from "@/lib/app-context";
import type { Lead } from "@/lib/leads";
import { Avatar, PipelineStepper, ScoreBadge, StatusBadge } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

export default function LeadDetailPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = typeof params.id === "string" ? params.id : "";

  // The lead renders straight from the cache (or the row the Leads page already
  // holds) and refreshes in the background; only an unknown lead shows the
  // loading line. The auth check runs alongside instead of in front of it.
  const { leadsByIds } = useApp();
  const known = leadId ? leadsByIds(new Set([leadId]))[0] ?? null : null;
  const leadQuery = useCached<Lead>(leadId ? cacheKeys.lead(leadId) : null, cachedFetchers.lead(leadId));
  const lead = leadQuery.data ?? known;
  const loading = !lead && leadQuery.isLoading;
  const error = !lead && leadQuery.error ? (leadQuery.error as Error).message : "";

  useEffect(() => {
    let mounted = true;

    async function init() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!mounted) return;
      if (!user || !isAppUser(user)) { router.replace("/"); return; }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/"); return; }
    }

    void init();
    return () => { mounted = false; };
  }, [leadId, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-xs font-mono text-muted-foreground tracking-widest uppercase">Loading lead...</p>
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-lg font-semibold">{error || "Lead not found"}</p>
        <Button variant="outline" asChild>
          <Link href="/leads">Back to leads</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto p-8 space-y-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5 -ml-2" asChild>
            <Link href="/leads">
              <ArrowLeft className="size-3.5" />
              Back
            </Link>
          </Button>
        </div>

        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <Avatar name={`${lead.firstName} ${lead.lastName}`} size="lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm text-muted-foreground">{lead.company}</p>
              <h1 className="text-2xl font-bold break-all">{lead.email}</h1>
              <p className="text-sm text-muted-foreground">
                {lead.firstName} {lead.lastName} · {lead.jobTitle}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <StatusBadge status={lead.status} />
                <ScoreBadge score={lead.score} />
              </div>
            </div>
          </div>
        </div>

        <Separator />

        <div className="grid gap-4">
          {lead.companyDescription && (
            <DetailRow icon={Building2} label="What the company does">
              {lead.companyDescription}
            </DetailRow>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <DetailRow icon={Globe2} label="Fetched from">
              <span className="font-medium">{lead.source}</span>
              <p className="text-xs text-muted-foreground mt-1">Added {lead.createdAt}</p>
            </DetailRow>

            <DetailRow icon={Megaphone} label="Campaign">
              {lead.campaign ? (
                <span className="font-medium">{lead.campaign}</span>
              ) : (
                <span className="text-muted-foreground">Not assigned to any campaign</span>
              )}
            </DetailRow>
          </div>

          <DetailRow icon={User} label="Lead status">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <StatusBadge status={lead.status} />
                <span className="text-xs text-muted-foreground">Current pipeline stage</span>
              </div>
              <PipelineStepper currentStatus={lead.status} />
            </div>
          </DetailRow>

          <DetailRow icon={Mail} label="Contact">
            <div className="space-y-2">
              <p><span className="text-muted-foreground">Email:</span> {lead.email}</p>
              <p><span className="text-muted-foreground">Domain:</span> {lead.domain || "—"}</p>
            </div>
          </DetailRow>

          {lead.sellsTo && (
            <DetailRow icon={Target} label="Who they sell to">
              {lead.sellsTo}
            </DetailRow>
          )}
        </div>
      </div>
    </div>
  );
}
