"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Building2, CalendarDays, Globe2, LayoutGrid, Mail, Megaphone, Target, User, Users, Zap } from "lucide-react";
import { isAppUser } from "@/lib/auth/roles";
import { supabase } from "@/lib/supabase";
import { useCached, cacheKeys, cachedFetchers } from "@/lib/api-client";
import { useApp } from "@/lib/app-context";
import type { Lead } from "@/lib/leads";
import { Avatar, PipelineStepper, ScoreBadge, StatusBadge } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RecordLayout, RecordHeader, DetailSection, DetailRow } from "@/components/ui/record-layout";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { RecordSkeleton } from "@/components/app/page-skeletons";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
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

  if (loading) return <RecordSkeleton />;

  if (error || !lead) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader crumbs={[{ icon: <Users />, label: "Leads", href: "/leads" }, { label: "Lead" }]} />
        <EmptyState boxed={false} icon={User} title={error || "Lead not found"} message="It may have been deleted, or you may not have access to it." className="flex-1">
          <Button variant="outline" size="sm" asChild>
            <Link href="/leads">Back to leads</Link>
          </Button>
        </EmptyState>
      </div>
    );
  }

  const fullName = `${lead.firstName} ${lead.lastName}`.trim();

  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ icon: <Users />, label: "Leads", href: "/leads" }, { label: fullName || lead.email || "Lead" }]} />
      <RecordLayout
        header={
          <RecordHeader
            avatar={<Avatar name={fullName} size="md" />}
            title={fullName || lead.email}
            subtitle={[lead.jobTitle, lead.company].filter(Boolean).join(" · ") || undefined}
            badges={
              <>
                <StatusBadge status={lead.status} />
                {lead.score !== "—" && <ScoreBadge score={lead.score} />}
              </>
            }
          />
        }
        tabs={
          <SegmentedTabs
            variant="underline"
            value="overview"
            onValueChange={() => {}}
            options={[{ value: "overview", label: "Overview", icon: LayoutGrid }]}
          />
        }
        details={
          <>
            <DetailSection title="Record details">
              <DetailRow icon={<Zap />} label="Status"><StatusBadge status={lead.status} /></DetailRow>
              <DetailRow icon={<Mail />} label="Email"><span title={lead.email}>{lead.email || "—"}</span></DetailRow>
              <DetailRow icon={<Globe2 />} label="Domain"><span title={lead.domain}>{lead.domain || "—"}</span></DetailRow>
              <DetailRow icon={<Building2 />} label="Organization"><span title={lead.company}>{lead.company || "—"}</span></DetailRow>
              <DetailRow icon={<Megaphone />} label="Campaign">
                {lead.campaign ? <span title={lead.campaign}>{lead.campaign}</span> : <span className="text-muted-foreground">Not assigned to any campaign</span>}
              </DetailRow>
              <DetailRow icon={<Globe2 />} label="Fetched from">{lead.source}</DetailRow>
              <DetailRow icon={<CalendarDays />} label="Added"><span className="tabular-nums">{formatDate(lead.createdAt)}</span></DetailRow>
            </DetailSection>
          </>
        }
      >
        <div className="max-w-3xl space-y-6">
          <section>
            <h3 className="pb-3 text-[15px] font-semibold">Lead status</h3>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <StatusBadge status={lead.status} />
                <span className="text-xs text-muted-foreground">Current pipeline stage</span>
              </div>
              <PipelineStepper currentStatus={lead.status} />
            </div>
          </section>

          {lead.companyDescription && (
            <section>
              <h3 className="flex items-center gap-1.5 pb-2 text-[15px] font-semibold"><Building2 className="size-4 text-muted-foreground" />What the company does</h3>
              <p className="text-sm leading-relaxed">{lead.companyDescription}</p>
            </section>
          )}

          {lead.sellsTo && (
            <section>
              <h3 className="flex items-center gap-1.5 pb-2 text-[15px] font-semibold"><Target className="size-4 text-muted-foreground" />Who they sell to</h3>
              <p className="text-sm leading-relaxed">{lead.sellsTo}</p>
            </section>
          )}

          {/* Below lg the Details rail is hidden — keep the contact facts reachable. */}
          <section className="lg:hidden">
            <h3 className="pb-2 text-[15px] font-semibold">Contact</h3>
            <div className="space-y-1 text-[13px]">
              <p><span className="text-muted-foreground">Email:</span> {lead.email}</p>
              <p><span className="text-muted-foreground">Domain:</span> {lead.domain || "—"}</p>
              <p><span className="text-muted-foreground">Fetched from:</span> {lead.source} · added {formatDate(lead.createdAt)}</p>
              <p><span className="text-muted-foreground">Campaign:</span> {lead.campaign || "Not assigned to any campaign"}</p>
            </div>
          </section>
        </div>
      </RecordLayout>
    </div>
  );
}
