"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Building2, Globe2, X, Loader2, Pencil, Save,
  AlertCircle, MapPin, Factory, Users, Plus, Link2, Activity, LayoutGrid, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { patchOrg, queryCache, cacheKeys, cachedFetchers, prefetchLead } from "@/lib/api-client";
import { useApp } from "@/lib/app-context";
import type { Lead } from "@/lib/leads";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RecordLayout, RecordHeader, DetailSection, DetailRow } from "@/components/ui/record-layout";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Avatar } from "@/components/leads/lead-ui";
import { getBatchColor } from "@/lib/constants";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrgData {
  id: string;
  name: string | null;
  domain: string | null;
  domain_source: string | null;
  website: string | null;
  description: string | null;
  company_description: string | null;
  sells_to: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
  enrichment_stage: string | null;
  scored_batch?: { name: string; color: string } | null;
  leads?: Array<{ id: string; first_name: string | null; last_name: string | null; title: string | null; email: string | null }>;
}

const ENRICH_DOT: Record<string, string> = {
  queued:   "bg-muted-foreground/40",
  scraping: "bg-yellow-500 animate-pulse",
  done:     "bg-green-500",
  failed:   "bg-red-500",
};
const ENRICH_LABEL: Record<string, string> = {
  queued: "Queued", scraping: "Enriching…", done: "Done", failed: "Failed",
};

type OrgForm = {
  name: string;
  domain: string;
  website: string;
  description: string;
  industry: string;
  city: string;
  country: string;
};

// ── Helper ────────────────────────────────────────────────────────────────────

function toUrl(val: string) {
  return /^https?:\/\//i.test(val) ? val : `https://${val}`;
}

/** A detail-rail value: plain text, or an outbound link; "—" when empty. */
function Value({ value, link }: { value: string | null | undefined; link?: boolean }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return link ? (
    <a href={toUrl(value)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" title={value}>{value}</a>
  ) : (
    <span title={value}>{value}</span>
  );
}

/** Label + field for the edit form. */
function FormRow({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-[13px] font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">{icon}{label}</Label>
      {children}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function OrgDrawer({ orgId, onClose, onAddLead, onLeadClick }: {
  orgId: string | null;
  onClose: () => void;
  onAddLead?: (org: { id: string; name: string; industry: string; domain: string; country: string; leads: Array<{ id: string; firstName: string; lastName: string; email: string; jobTitle: string }> }) => void;
  onLeadClick?: (leadId: string) => void;
}) {
  const [org,     setOrg    ] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving,  setSaving ] = useState(false);
  const [error,   setError  ] = useState("");
  // Record tabs (UI only): Overview (about / sells to) and People.
  const [tab,     setTab    ] = useState<"overview" | "people">("overview");
  const [form,    setForm   ] = useState<OrgForm>({
    name: "", domain: "", website: "", description: "", industry: "", city: "", country: "",
  });

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  }

  // Until the org record arrives, title the drawer with the company name of
  // any lead already loaded for it instead of "Loading…".
  const { leads: knownLeads } = useApp();
  const fallbackName = orgId ? knownLeads.find((l) => l.orgId === orgId)?.company || null : null;

  const activeOrgIdRef = useRef<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const applyOrg = useCallback((data: OrgData, linkedLeads: Lead[]) => {
    setOrg({
      ...data,
      leads: linkedLeads.map((l) => ({
        id: l.id,
        first_name: l.firstName,
        last_name: l.lastName,
        title: l.jobTitle,
        email: l.email,
      })),
    });
    // Never overwrite a form the user has started editing (a background
    // refresh can land after the cached copy was shown).
    if (editingRef.current) return;
    setForm({
      name:        data.name        ?? "",
      domain:      data.domain      ?? "",
      website:     data.website     ?? "",
      description: data.description ?? data.company_description ?? "",
      industry:    data.industry    ?? "",
      city:        data.city        ?? "",
      country:     data.country     ?? "",
    });
  }, []);

  const loadOrg = useCallback(async (id: string) => {
    activeOrgIdRef.current = id;
    // Cached (opened before, or hover-prefetched): show it now, refresh below.
    const cachedOrg = queryCache.getData<OrgData>(cacheKeys.org(id));
    const cachedLeads = queryCache.getData<Lead[]>(cacheKeys.orgLeads(id));
    if (cachedOrg) applyOrg(cachedOrg, cachedLeads ?? []);
    else setOrg(null);
    setLoading(!cachedOrg);
    setError("");
    try {
      // The org and its leads are independent — fetch them in parallel.
      const [data, linkedLeads] = await Promise.all([
        queryCache.fetch(cacheKeys.org(id), cachedFetchers.org(id)) as Promise<unknown> as Promise<OrgData>,
        queryCache.fetch(cacheKeys.orgLeads(id), cachedFetchers.orgLeads(id)),
      ]);
      if (activeOrgIdRef.current !== id) return;
      applyOrg(data, linkedLeads);
    } catch (e) {
      if (activeOrgIdRef.current === id) setError((e as Error).message);
    } finally {
      if (activeOrgIdRef.current === id) setLoading(false);
    }
  }, [applyOrg]);

  async function handleSave() {
    if (!orgId) return;
    setSaving(true);
    setError("");
    try {
      const tok = await getToken();
      const updated = await patchOrg(tok, orgId, {
        name:        form.name        || undefined,
        domain:      form.domain      || undefined,
        website:     form.website     || undefined,
        description: form.description || undefined,
        industry:    form.industry    || undefined,
        city:        form.city        || undefined,
        country:     form.country     || undefined,
      }) as unknown as OrgData;
      queryCache.set(cacheKeys.org(orgId), updated);
      setOrg(updated);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!orgId) { activeOrgIdRef.current = null; setOrg(null); setEditing(false); setError(""); return; }
    setTab("overview");
    setEditing(false);
    setError("");
    void loadOrg(orgId);
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const open = orgId !== null;
  if (!open) return null;

  const title = org?.name ?? fallbackName ?? (loading ? "Loading…" : "Organization");
  const people = org?.leads ?? [];
  const errorBox = error && (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300">
      <AlertCircle className="size-3.5 shrink-0" /> {error}
    </div>
  );

  // Attributes: the Details rail on wide screens, top of Overview below `lg`.
  const details = org && (
    <>
      <DetailSection title="Record details">
        <DetailRow icon={<Building2 />} label="Name"><Value value={org.name} /></DetailRow>
        <DetailRow icon={<Globe2 />} label="Domain"><Value value={org.domain} link /></DetailRow>
        <DetailRow icon={<Link2 />} label="Website"><Value value={org.website} link /></DetailRow>
        <DetailRow icon={<Factory />} label="Industry"><Value value={org.industry} /></DetailRow>
        {org.enrichment_stage && (
          <DetailRow icon={<Activity />} label="Enrichment">
            <span className="inline-flex items-center gap-1.5">
              <span className={cn("size-2 shrink-0 rounded-full", ENRICH_DOT[org.enrichment_stage] ?? "bg-border")} />
              {ENRICH_LABEL[org.enrichment_stage] ?? org.enrichment_stage}
            </span>
          </DetailRow>
        )}
      </DetailSection>
      <DetailSection title="Location">
        <DetailRow icon={<MapPin />} label="City"><Value value={org.city} /></DetailRow>
        <DetailRow icon={<MapPin />} label="Country"><Value value={org.country} /></DetailRow>
      </DetailSection>
    </>
  );

  const addLeadButton = onAddLead && org ? (
    <Button
      size="sm"
      variant="outline"
      onClick={() => onAddLead({
        id: org.id,
        name: org.name ?? "",
        industry: org.industry ?? "",
        domain: org.domain ?? "",
        country: org.country ?? "",
        leads: (org.leads ?? []).map((l) => ({
          id: l.id,
          firstName: l.first_name ?? "",
          lastName: l.last_name ?? "",
          email: l.email ?? "",
          jobTitle: l.title ?? "",
        })),
      })}
    >
      <Plus className="size-3.5" /> Add lead
    </Button>
  ) : null;

  const peopleList = people.length === 0 ? (
    <EmptyState boxed={false} icon={Users} message="No leads linked to this org." className="py-8" />
  ) : (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {people.map((lead) => {
        const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unnamed";
        return (
          <div
            key={lead.id}
            onClick={() => onLeadClick?.(lead.id)}
            onMouseEnter={() => prefetchLead(lead.id)}
            className={cn(
              "group flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0",
              onLeadClick && "cursor-pointer transition-colors hover:bg-hover",
            )}
          >
            <span className="shrink-0 [&>div]:size-6 [&>div]:text-[10px]"><Avatar name={name} size="sm" /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{name}</p>
              {lead.title && <p className="truncate text-xs text-muted-foreground">{lead.title}</p>}
            </div>
            {lead.email && <span className="hidden max-w-[45%] truncate text-xs text-muted-foreground sm:block" title={lead.email}>{lead.email}</span>}
            {onLeadClick && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/25 dark:bg-black/60" onClick={onClose} />

      {/* Record sheet from the right */}
      <div
        role="dialog"
        aria-label={title}
        className="fixed right-0 top-0 z-60 flex h-full w-[min(1100px,92vw)] flex-col border-l border-border bg-background shadow-xl"
      >
        <PageHeader
          crumbs={[{ icon: <Building2 />, label: "Organization" }, { label: title }]}
          actions={
            <>
              {org && !editing && (
                <Button
                  type="button" variant="ghost" size="sm"
                  onClick={() => { setEditing(true); setError(""); }}
                  className="text-muted-foreground"
                  title="Edit organization"
                >
                  <Pencil className="size-3.5" /> Edit
                </Button>
              )}
              {editing && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(""); }}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </>
              )}
              <Button
                type="button" variant="ghost" size="icon-sm" onClick={onClose}
                className="text-muted-foreground"
                aria-label="Close organization"
              >
                <X className="size-4" />
              </Button>
            </>
          }
        />

        {loading ? (
          <div className="flex min-h-0 flex-1 animate-pulse">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 px-6 pb-3 pt-5">
                <div className="size-10 rounded-lg bg-secondary" />
                <div className="space-y-2">
                  <div className="h-4 w-44 rounded bg-secondary" />
                  <div className="h-3 w-28 rounded bg-secondary" />
                </div>
              </div>
              <div className="flex gap-5 border-b border-border px-6 pb-3 pt-1">
                {Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-3 w-16 rounded bg-secondary" />)}
              </div>
              <div className="space-y-3 px-6 py-5">
                <div className="h-24 rounded-lg border border-border bg-card" />
                <div className="h-16 rounded-lg border border-border bg-card" />
              </div>
            </div>
            <div className="hidden w-[340px] shrink-0 space-y-3 border-l border-border bg-card p-4 lg:block">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-3 w-20 rounded bg-secondary" />
                  <div className="h-3 flex-1 rounded bg-secondary" />
                </div>
              ))}
            </div>
          </div>
        ) : !org ? (
          <div className="p-6">{errorBox}</div>
        ) : (
          <RecordLayout
            header={
              <RecordHeader
                avatar={
                  <span className="grid size-10 place-items-center rounded-lg border border-border bg-field text-muted-foreground">
                    <Building2 className="size-[18px]" />
                  </span>
                }
                title={title}
                subtitle={org.domain ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <a href={toUrl(org.domain)} target="_blank" rel="noopener noreferrer" className="truncate text-primary hover:underline">{org.domain}</a>
                    {org.domain_source === "email_inferred" && (
                      <span className="shrink-0 rounded-[4px] border border-amber-200 bg-amber-50 px-1 py-0.5 text-[11px] leading-none text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">Inferred</span>
                    )}
                  </span>
                ) : undefined}
                badges={org.scored_batch ? (
                  <span className={cn("inline-flex max-w-full truncate rounded-[5px] border px-1.5 py-[3px] text-xs font-medium leading-none", getBatchColor(org.scored_batch.color).pill)} title="Scored-search batch">
                    Batch: {org.scored_batch.name}
                  </span>
                ) : undefined}
              />
            }
            tabs={editing ? undefined : (
              <SegmentedTabs
                variant="underline"
                value={tab}
                onValueChange={setTab}
                options={[
                  { value: "overview", label: "Overview", icon: LayoutGrid },
                  { value: "people",   label: "People",   icon: Users, count: people.length },
                ]}
              />
            )}
            details={details}
          >
            {editing ? (
              /* ── Edit mode ── */
              <div className="max-w-xl space-y-6">
                {errorBox}
                <section className="space-y-3">
                  <h3 className="text-[15px] font-semibold">Details</h3>
                  <FormRow label="Name">
                    <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                  </FormRow>
                  <FormRow label="Domain" icon={<Globe2 />}>
                    <Input placeholder="acme.com" value={form.domain} onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} />
                  </FormRow>
                  <FormRow label="Website URL">
                    <Input placeholder="https://acme.com" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
                  </FormRow>
                  <FormRow label="Industry" icon={<Factory />}>
                    <Input placeholder="Manufacturing" value={form.industry} onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))} />
                  </FormRow>
                </section>
                <section className="space-y-3">
                  <h3 className="flex items-center gap-1.5 text-[15px] font-semibold">Location</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormRow label="City">
                      <Input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
                    </FormRow>
                    <FormRow label="Country">
                      <Input value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
                    </FormRow>
                  </div>
                </section>
                <section className="space-y-3">
                  <h3 className="text-[15px] font-semibold">About</h3>
                  <FormRow label="Description">
                    <Textarea
                      rows={4}
                      className="resize-none"
                      value={form.description}
                      onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="What does this company do?"
                    />
                  </FormRow>
                </section>
              </div>
            ) : tab === "overview" ? (
              /* ── View mode: overview ── */
              <div className="space-y-6">
                {errorBox}
                {/* Below lg the Details rail is hidden — show the same attributes here. */}
                <div className="overflow-hidden rounded-lg border border-border bg-card lg:hidden">{details}</div>

                <section>
                  <h3 className="pb-2 text-[15px] font-semibold">About</h3>
                  {org.company_description || org.description ? (
                    <p className="text-sm leading-relaxed text-foreground">{org.company_description ?? org.description}</p>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">No description yet.</p>
                  )}
                </section>

                {org.sells_to && (
                  <section>
                    <h3 className="pb-2 text-[15px] font-semibold">Sells to</h3>
                    <p className="text-sm leading-relaxed text-foreground">{org.sells_to}</p>
                  </section>
                )}

                <section>
                  <div className="flex items-center justify-between gap-2 pb-2">
                    <h3 className="text-[15px] font-semibold">People <span className="font-normal tabular-nums text-muted-foreground">{people.length}</span></h3>
                    {addLeadButton}
                  </div>
                  {peopleList}
                </section>
              </div>
            ) : (
              /* ── View mode: people ── */
              <div className="space-y-3">
                {errorBox}
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] text-muted-foreground">Leads at this organization.</p>
                  {addLeadButton}
                </div>
                {peopleList}
              </div>
            )}
          </RecordLayout>
        )}
      </div>
    </>
  );
}
