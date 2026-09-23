"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Building2, Globe2, X, Loader2, Pencil, Save,
  AlertCircle, MapPin, Factory, Users, Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchOrg, patchOrg, fetchLeadsByOrg } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";

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
  leads?: Array<{ id: string; first_name: string | null; last_name: string | null; title: string | null; email: string | null }>;
}

const ENRICH_DOT: Record<string, string> = {
  queued:   "bg-muted-foreground/40",
  scraping: "bg-yellow-400 animate-pulse",
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

function Field({ label, value, link }: { label: string; value: string | null | undefined; link?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <p className="eyebrow mb-0.5">{label}</p>
      {link ? (
        <a href={toUrl(value)} target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-blue-400 hover:underline truncate block">{value}</a>
      ) : (
        <p className="text-sm">{value}</p>
      )}
    </div>
  );
}

function Section({
  icon: Icon, label, children, action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-secondary p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 eyebrow">
          <Icon className="size-3" /> {label}
        </div>
        {action}
      </div>
      <div className="space-y-2.5">{children}</div>
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
  const [form,    setForm   ] = useState<OrgForm>({
    name: "", domain: "", website: "", description: "", industry: "", city: "", country: "",
  });

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  }

  const loadOrg = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      const tok = await getToken();
      const data = await fetchOrg(tok, id) as unknown as OrgData;
      const linkedLeads = await fetchLeadsByOrg(tok, id);
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
      setForm({
        name:        data.name        ?? "",
        domain:      data.domain      ?? "",
        website:     data.website     ?? "",
        description: data.description ?? data.company_description ?? "",
        industry:    data.industry    ?? "",
        city:        data.city        ?? "",
        country:     data.country     ?? "",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

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
      setOrg(updated);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!orgId) { setOrg(null); setEditing(false); setError(""); return; }
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

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/40 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
      />

      {/* Drawer */}
      <div className={cn(
        "fixed top-0 right-0 z-60 h-full w-[480px] max-w-[95vw] bg-card border-l border-border shadow-2xl",
        "flex flex-col transition-transform duration-300 ease-in-out",
        open ? "translate-x-0" : "translate-x-full",
      )}>
        {/* Header */}
        <div className="swatch-bar-top flex items-center gap-3 p-5 border-b border-border shrink-0">
          <div className="size-9 rounded-full bg-secondary border border-border flex items-center justify-center shrink-0">
            <Building2 className="size-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="eyebrow">Organization</p>
            <h2 className="font-display text-lg font-semibold truncate mt-0.5">
              {org?.name ?? (loading ? "Loading…" : "Organization")}
            </h2>
            {org?.domain && (
              <div className="flex items-center gap-1.5 min-w-0">
                <a href={toUrl(org.domain)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-400 truncate hover:underline">{org.domain}</a>
                {org.domain_source === "email_inferred" && (
                  <span className="text-[9px] font-medium uppercase tracking-wide text-amber-500/80 border border-amber-500/30 rounded px-1 py-0.5 shrink-0">Inferred</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {org && !editing && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => { setEditing(true); setError(""); }}
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                title="Edit organization"
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
            {editing && (
              <>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setEditing(false); setError(""); }}>
                  Cancel
                </Button>
                <Button size="sm" className="h-7 px-3 text-xs gap-1.5" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                  {saving ? "Saving…" : "Save"}
                </Button>
              </>
            )}
            <Button
              type="button" variant="ghost" size="icon" onClick={onClose}
              className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading && (
            <div className="space-y-4 animate-pulse">
              {/* Name + domain */}
              <div className="space-y-2">
                <div className="h-5 w-2/3 bg-secondary rounded" />
                <div className="h-3 w-1/3 bg-secondary rounded" />
              </div>
              {/* Enrichment dot row */}
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full bg-secondary shrink-0" />
                <div className="h-3 w-16 bg-secondary rounded" />
              </div>
              {/* Field rows */}
              {[70, 50, 60, 80].map((w, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-2.5 w-16 bg-secondary rounded" />
                  <div className="h-8 bg-secondary rounded-lg" style={{ width: `${w}%` }} />
                </div>
              ))}
              {/* Description block */}
              <div className="space-y-1.5">
                <div className="h-2.5 w-20 bg-secondary rounded" />
                <div className="h-16 bg-secondary rounded-lg" />
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5">
              <AlertCircle className="size-3.5 shrink-0" /> {error}
            </div>
          )}

          {!loading && org && (
            <>
              {editing ? (
                /* ── Edit mode ── */
                <div className="space-y-4">
                  {error && (
                    <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5">
                      <AlertCircle className="size-3.5 shrink-0" /> {error}
                    </div>
                  )}
                  <fieldset className="rounded-xl border border-border p-4 space-y-3">
                    <legend className="eyebrow px-1">Details</legend>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Name</Label>
                      <Input className="h-8 text-sm" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1.5"><Globe2 className="size-3" /> Domain</Label>
                      <Input className="h-8 text-sm" placeholder="acme.com" value={form.domain} onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Website URL</Label>
                      <Input className="h-8 text-sm" placeholder="https://acme.com" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1.5"><Factory className="size-3" /> Industry</Label>
                      <Input className="h-8 text-sm" placeholder="Manufacturing" value={form.industry} onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))} />
                    </div>
                  </fieldset>
                  <fieldset className="rounded-xl border border-border p-4 space-y-3">
                    <legend className="eyebrow px-1 flex items-center gap-1"><MapPin className="size-3" /> Location</legend>
                    <div className="space-y-1.5">
                      <Label className="text-xs">City</Label>
                      <Input className="h-8 text-sm" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Country</Label>
                      <Input className="h-8 text-sm" value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
                    </div>
                  </fieldset>
                  <fieldset className="rounded-xl border border-border p-4 space-y-3">
                    <legend className="eyebrow px-1">About</legend>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Description</Label>
                      <Textarea
                        rows={4}
                        className="resize-none"
                        value={form.description}
                        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                        placeholder="What does this company do?"
                      />
                    </div>
                  </fieldset>
                </div>
              ) : (
                /* ── View mode ── */
                <>
                  {org.enrichment_stage && (
                    <div className="flex items-center gap-2 px-1">
                      <span className={cn("size-2.5 rounded-full shrink-0", ENRICH_DOT[org.enrichment_stage] ?? "bg-border")} />
                      <span className="font-mono text-xs font-semibold uppercase tracking-wider">{ENRICH_LABEL[org.enrichment_stage] ?? org.enrichment_stage}</span>
                    </div>
                  )}

                  <Section icon={Building2} label="Details">
                    <Field label="Name"     value={org.name} />
                    <Field label="Domain"   value={org.domain}  link />
                    <Field label="Website"  value={org.website} link />
                    <Field label="Industry" value={org.industry} />
                  </Section>

                  {(org.city || org.country) && (
                    <Section icon={MapPin} label="Location">
                      <Field label="City"    value={org.city} />
                      <Field label="Country" value={org.country} />
                    </Section>
                  )}

                  {(org.company_description || org.description) && (
                    <Section icon={Globe2} label="About">
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {org.company_description ?? org.description}
                      </p>
                    </Section>
                  )}

                  {org.sells_to && (
                    <Section icon={Factory} label="Sells to">
                      <p className="text-sm text-muted-foreground leading-relaxed">{org.sells_to}</p>
                    </Section>
                  )}

                  <Section
                    icon={Users}
                    label="People"
                    action={onAddLead && org ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] gap-1"
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
                        <Plus className="size-3" /> Add lead
                      </Button>
                    ) : undefined}
                  >
                    {(org.leads ?? []).length === 0 ? (
                      <EmptyState boxed={false} message="No leads linked to this org." className="py-6" />
                    ) : (
                      <div className="space-y-2">
                        {(org.leads ?? []).map((lead) => (
                          <div
                            key={lead.id}
                            onClick={() => onLeadClick?.(lead.id)}
                            className={cn(
                              "rounded-lg border border-border bg-card px-3 py-2",
                              onLeadClick && "cursor-pointer hover:bg-secondary hover:border-primary/30 transition-colors",
                            )}
                          >
                            <p className={cn("text-sm font-medium", onLeadClick && "group-hover:text-primary")}>
                              {[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unnamed"}
                            </p>
                            {lead.title && <p className="text-xs text-muted-foreground">{lead.title}</p>}
                            {lead.email && <p className="font-mono text-xs text-blue-400">{lead.email}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </Section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
