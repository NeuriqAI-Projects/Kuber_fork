"use client";

import { bulkDeleteLeads, bulkAssignLeads, fetchUsers, fetchImports, retryAllFailedEnrichment, fetchLeadStatusCounts, DB_LEAD_STATUS, DB_LEAD_SOURCE, type ImportBatch, type Profile, type BulkAssignStrategy, type AssignmentSummary, type LeadListFilters } from "@/lib/api-client";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { getBatchColor, type BatchColorName } from "@/lib/constants";
import { ServiceHealthBanner } from "@/components/app/service-health-banner";

import { useRef, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  type Lead,
  type LeadStatus,
  type LeadSource,
  type LeadsSort,
  isCampaignEligible,
  campaignIneligibleReason,
  sortLeads,
  PIPELINE_STAGES,
  STATUS_LABELS,
  CAMPAIGN_ACTION_HELP,
  type EnrichmentStage,
} from "@/lib/leads";
import { useApp } from "@/lib/app-context";
import { Avatar, StatusBadge } from "@/components/leads/lead-ui";
import { KanbanBoard } from "@/components/app/kanban-board";
import {
  EMPTY_SCORED_FILTER, GroupPill, RunningSearchesBar, scoredFilterCount, ScoredCompanyDrawer, type ScoredCompany, type DecideAction, ScoredFiltersDialog, ScoredOrgsKanban, ScoredOrgsTable,
  decideScored, scoredFilterActive, useScoredOrgs, type ScoredFilter,
} from "@/components/app/scored-orgs";
import { GROUPS, type Group } from "@/lib/services/prospects/groups";
import { InfoTip } from "@/components/ui/info-tip";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Tip } from "@/components/ui/tip";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { Pill } from "@/components/ui/pill";
import { MultiSelectDropdown, type DropdownOption } from "@/components/ui/multi-select-dropdown";
import { FilterModal } from "@/components/ui/filter-modal";
import { AppRadio } from "@/components/ui/app-radio";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Users, Megaphone, Plus, List, Kanban, RefreshCw, Columns3,
  Building2, SlidersHorizontal, Trash2, UserPlus, User,
} from "lucide-react";

// ── Types & constants ─────────────────────────────────────────────────────────

type LeadsViewMode = "list" | "kanban";
type LeadsEntityMode = "individual" | "orgs";

const ASSIGN_STRATEGIES: { value: BulkAssignStrategy; label: string; description: string }[] = [
  { value: "manual", label: "Manual", description: "Assign every selected lead to one employee you pick." },
  { value: "round_robin", label: "Round robin", description: "Split the selected leads evenly across all active employees." },
  { value: "territory", label: "Territory-based", description: "Route each selected lead to whoever covers its country." },
];

type FilterState = {
  statuses: Set<LeadStatus>;
  assignees: Set<string>;
  sources: Set<LeadSource>;
  batchLabels: Set<string>;
  createdFrom: Date | undefined;
  createdTo: Date | undefined;
};

const EMPTY_FILTERS: FilterState = {
  statuses: new Set(),
  assignees: new Set(),
  sources: new Set(),
  batchLabels: new Set(),
  createdFrom: undefined,
  createdTo: undefined,
};

function isFiltersEmpty(f: FilterState) {
  return (
    f.statuses.size === 0 &&
    f.assignees.size === 0 &&
    f.sources.size === 0 &&
    f.batchLabels.size === 0 &&
    !f.createdFrom &&
    !f.createdTo
  );
}

function activeFilterCount(f: FilterState) {
  return (
    (f.statuses.size > 0 ? 1 : 0) +
    (f.assignees.size > 0 ? 1 : 0) +
    (f.sources.size > 0 ? 1 : 0) +
    (f.batchLabels.size > 0 ? 1 : 0) +
    (f.createdFrom || f.createdTo ? 1 : 0)
  );
}

const UNASSIGNED_FILTER_VALUE = "unassigned";

/** db enum -> display label, the inverse of DB_LEAD_STATUS. */
const LEAD_STATUS_LABEL: Record<string, LeadStatus> = Object.fromEntries(
  Object.entries(DB_LEAD_STATUS).map(([label, db]) => [db, label as LeadStatus]),
) as Record<string, LeadStatus>;

function assigneeDisplayName(
  assignedTo: string | null,
  session: { user: { id: string } } | null,
  employees: Profile[],
): string {
  if (!assignedTo) return "Unassigned";
  if (session?.user.id === assignedTo) return "You";
  const match = employees.find((e) => e.id === assignedTo);
  return match ? (match.full_name || match.email) : "—";
}

type OrgRow = {
  id: string;
  name: string;
  domain: string;
  enrichmentStage: EnrichmentStage | null;
  companyDescription: string | null;
  sellsTo: string | null;
  leads: Lead[];
};

// ── Column definitions ────────────────────────────────────────────────────────

const COLUMN_DEFS = [
  { key: "email",        label: "Email",        defaultVisible: true  },
  { key: "job_title",   label: "Job Title",    defaultVisible: false },
  { key: "status",      label: "Status",       defaultVisible: true  },
  { key: "assigned",    label: "Assigned",     defaultVisible: true  },
  { key: "source",      label: "Source",       defaultVisible: false },
  { key: "added",       label: "Created",      defaultVisible: true  },
  { key: "organization",label: "Organization", defaultVisible: true  },
  { key: "phone",       label: "Phone",        defaultVisible: false },
  { key: "country",     label: "Country",      defaultVisible: false },
  { key: "domain",      label: "Domain",       defaultVisible: false },
  { key: "campaign",    label: "Campaign",     defaultVisible: false },
  { key: "batch",       label: "Batch",        defaultVisible: true  },
] as const;

type ColKey = typeof COLUMN_DEFS[number]["key"];
type ColVisibility = Record<ColKey, boolean>;

const DEFAULT_VISIBILITY: ColVisibility = Object.fromEntries(
  COLUMN_DEFS.map((c) => [c.key, c.defaultVisible])
) as ColVisibility;

const ORG_COLUMN_DEFS = [
  { key: "fit_status",  label: "Status",      defaultVisible: true  },
  { key: "domain",      label: "Domain",      defaultVisible: true  },
  { key: "description", label: "Description", defaultVisible: true  },
  { key: "sells_to",    label: "Sells To",    defaultVisible: true  },
  { key: "leads",       label: "Leads",       defaultVisible: true  },
] as const;

type OrgColKey = typeof ORG_COLUMN_DEFS[number]["key"];
type OrgColVisibility = Record<OrgColKey, boolean>;

const DEFAULT_ORG_VISIBILITY: OrgColVisibility = Object.fromEntries(
  ORG_COLUMN_DEFS.map((c) => [c.key, c.defaultVisible])
) as OrgColVisibility;

// ── Status dot ────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<LeadStatus, string> = {
  "Input Required": "bg-yellow-400",
  New:       "bg-zinc-400",
  Enriching: "bg-amber-400",
  Enriched:  "bg-blue-400",
  Open:      "bg-green-400",
  Closed:    "bg-zinc-300",
};

function StatusDot({ status }: { status: LeadStatus }) {
  return (
    <span
      className={cn("size-2 rounded-full inline-block", STATUS_DOT[status])}
      title={status}
    />
  );
}

// ── Columns dropdown ──────────────────────────────────────────────────────────

function ColumnsDropdown<K extends string>({
  defs,
  visible,
  onChange,
  defaultVisible,
}: {
  defs: readonly { key: K; label: string }[];
  visible: Record<K, boolean>;
  onChange: (v: Record<K, boolean>) => void;
  defaultVisible: Record<K, boolean>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function toggle(key: K) {
    onChange({ ...visible, [key]: !visible[key] });
  }

  return (
    <div ref={ref} className="relative">
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen((o) => !o)}>
        <Columns3 className="size-3.5" />
        Columns
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-44 rounded-xl border border-border bg-card shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <p className="eyebrow">Toggle columns</p>
          </div>
          <div className="py-1">
            {defs.map((col) => (
              <Button
                key={col.key}
                type="button"
                variant="ghost"
                onClick={() => toggle(col.key)}
                className="w-full h-auto justify-start gap-2.5 rounded-none px-3 py-2 text-sm font-normal"
              >
                <AppCheckbox checked={!!visible[col.key]} />
                <span className="text-sm text-foreground">{col.label}</span>
              </Button>
            ))}
          </div>
          <div className="border-t border-border px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(defaultVisible)}
              className="h-auto p-0 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              Reset to default
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function sortOrgs(rows: OrgRow[], sort: LeadsSort): OrgRow[] {
  const copy = [...rows];
  const newestLead = (org: OrgRow) =>
    Math.max(0, ...org.leads.map((l) => new Date(l.createdAt).getTime()));
  switch (sort) {
    case "az":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case "za":
      return copy.sort((a, b) => b.name.localeCompare(a.name));
    case "oldest":
      return copy.sort((a, b) => newestLead(a) - newestLead(b));
    case "newest":
    default:
      return copy.sort((a, b) => newestLead(b) - newestLead(a));
  }
}

// ── Filters modal helpers ─────────────────────────────────────────────────────

const ALL_SOURCES: LeadSource[] = ["Apollo", "Excel", "Manual"];

function DateRangePicker({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: Date | undefined;
  to: Date | undefined;
  onFromChange: (d: Date | undefined) => void;
  onToChange: (d: Date | undefined) => void;
}) {
  return (
    <div>
      <p className="eyebrow mb-2">Created Date</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">From</p>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal h-9 px-3 text-xs bg-card",
                  !from && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="size-3.5 mr-2 shrink-0" />
                {from ? format(from, "MMM d, yyyy") : "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={from}
                onSelect={onFromChange}
                disabled={(d: Date) => (to ? d > to : false)}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">To</p>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal h-9 px-3 text-xs bg-card",
                  !to && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="size-3.5 mr-2 shrink-0" />
                {to ? format(to, "MMM d, yyyy") : "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={to}
                onSelect={onToChange}
                disabled={(d: Date) => (from ? d < from : false)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}

// ── Filters modal ─────────────────────────────────────────────────────────────
// Overlay (not the shared Dialog primitive — matches this file's own
// bulk-assign modal precedent below: a custom fixed overlay with
// swatch-bar-top + eyebrow chrome) triggered by the "Filters" button in the
// toolbar. Uses a draft/Apply step (unlike an always-live rail) since this is
// an explicit commit surface, not a persistent layout element.

function FiltersModal({
  filters,
  onChange,
  onClose,
  imports,
  employees,
}: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  onClose: () => void;
  imports?: ImportBatch[];
  employees?: Profile[];
}) {
  const safeImports = imports ?? [];
  const safeEmployees = employees ?? [];
  const [draft, setDraft] = useState<FilterState>({
    statuses:    new Set(filters.statuses),
    assignees:   new Set(filters.assignees),
    sources:     new Set(filters.sources),
    batchLabels: new Set(filters.batchLabels),
    createdFrom: filters.createdFrom,
    createdTo:   filters.createdTo,
  });

  const statusOptions: DropdownOption<LeadStatus>[] = PIPELINE_STAGES.map((s) => ({
    value: s, label: STATUS_LABELS[s], dot: STATUS_DOT[s],
  }));
  const assigneeOptions: DropdownOption<string>[] = [
    { value: UNASSIGNED_FILTER_VALUE, label: "Unassigned" },
    ...safeEmployees.map((e) => ({ value: e.id, label: e.full_name || e.email })),
  ];
  const sourceOptions: DropdownOption<LeadSource>[] = ALL_SOURCES.map((s) => ({
    value: s, label: s,
  }));

  return (
    <FilterModal
      onClose={onClose}
      onClear={() => setDraft({ statuses: new Set(), assignees: new Set(), sources: new Set(), batchLabels: new Set(), createdFrom: undefined, createdTo: undefined })}
      onApply={() => { onChange(draft); onClose(); }}
    >
          <MultiSelectDropdown
            label="Status"
            options={statusOptions}
            selected={draft.statuses}
            onChange={(s) => setDraft((d) => ({ ...d, statuses: s }))}
          />
          {safeEmployees.length > 0 && (
            <MultiSelectDropdown
              label="Assigned"
              options={assigneeOptions}
              selected={draft.assignees}
              onChange={(s) => setDraft((d) => ({ ...d, assignees: s }))}
            />
          )}
          <MultiSelectDropdown
            label="Source"
            options={sourceOptions}
            selected={draft.sources}
            onChange={(s) => setDraft((d) => ({ ...d, sources: s }))}
          />
          {safeImports.length > 0 && (
            <MultiSelectDropdown
              label="Batch"
              options={safeImports.map((b) => ({
                value: b.label,
                label: `${b.label} (${b.lead_count})`,
                dot: getBatchColor(b.color).bg,
              }))}
              selected={draft.batchLabels}
              onChange={(s) => setDraft((d) => ({ ...d, batchLabels: s }))}
            />
          )}
          <DateRangePicker
            from={draft.createdFrom}
            to={draft.createdTo}
            onFromChange={(d) => setDraft((prev) => ({ ...prev, createdFrom: d }))}
            onToChange={(d) => setDraft((prev) => ({ ...prev, createdTo: d }))}
          />
    </FilterModal>
  );
}

// ── Main leads page ───────────────────────────────────────────────────────────

export default function LeadsPage() {
  const {
    leads,
    session,
    role,
    loadLeads,
    loadingLeads,
    leadsTotal,
    loadMoreLeads,
    loadingMoreLeads,
    loadAllLeads,
    loadingAllLeads,
    searchLeads,
    leadsByIds,
    checkedIds,
    setCheckedIds,
    setSelectedLead,
    setSelectedOrgId,
    setShowCreateCampaign,
    setDeletingLead,
    setShowAddLeads,
  } = useApp();

  const router      = useRouter();
  const pathname    = usePathname();
  const searchParams = useSearchParams();

  const [leadsViewMode,   setLeadsViewMode  ] = useState<LeadsViewMode>(
    (searchParams.get("view") as LeadsViewMode) || "list"
  );
  const [leadsEntityMode, setLeadsEntityMode] = useState<LeadsEntityMode>(
    (searchParams.get("entity") as LeadsEntityMode) || "individual"
  );
  const [visibleCols,     setVisibleCols    ] = useState<ColVisibility>(DEFAULT_VISIBILITY);
  const [orgVisibleCols,  setOrgVisibleCols ] = useState<OrgColVisibility>(DEFAULT_ORG_VISIBILITY);
  const [searchQuery,     setSearchQuery    ] = useState(searchParams.get("q") ?? "");
  const [searchResults,   setSearchResults  ] = useState<Lead[] | null>(null);
  const [searchLoading,   setSearchLoading  ] = useState(false);
  const [leadsSort,       setLeadsSort      ] = useState<LeadsSort>(
    (searchParams.get("sort") as LeadsSort) || "newest"
  );
  const [filters,         setFilters        ] = useState<FilterState>(() => {
    const statusesParam  = searchParams.get("statuses");
    const assigneesParam = searchParams.get("assignees");
    const sourcesParam   = searchParams.get("sources");
    const batchesParam   = searchParams.get("batches");
    const fromParam      = searchParams.get("from");
    const toParam        = searchParams.get("to");
    return {
      statuses:    statusesParam  ? new Set(statusesParam.split(",") as LeadStatus[]) : new Set(),
      assignees:   assigneesParam ? new Set(assigneesParam.split(","))               : new Set(),
      sources:     sourcesParam   ? new Set(sourcesParam.split(",")  as LeadSource[]) : new Set(),
      batchLabels: batchesParam   ? new Set(batchesParam.split(","))                  : new Set(),
      createdFrom: fromParam ? new Date(fromParam) : undefined,
      createdTo:   toParam   ? new Date(toParam)   : undefined,
    };
  });
  const [showFilters,      setShowFilters     ] = useState(false);
  // Scored companies (Add leads > Scored Companies): batch / status filters for the Organization view.
  const [scoredFilter, setScoredFilter] = useState<ScoredFilter>(() => ({
    searchIds: (searchParams.get("sbatch") ?? "").split(",").filter(Boolean),
    groups: (searchParams.get("sgroups") ?? "").split(",").filter((g): g is Group => (GROUPS as readonly string[]).includes(g)),
    hidden: searchParams.get("shidden") === "1",
  }));
  const [showScoredFilters, setShowScoredFilters] = useState(false);
  const [page,             setPage            ] = useState(1);
  const [pageSize,         setPageSize        ] = useState(50);
  const [importBatches,    setImportBatches   ] = useState<ImportBatch[]>([]);
  const [showBulkDelete,   setShowBulkDelete  ] = useState(false);
  const [bulkDeleting,     setBulkDeleting    ] = useState(false);
  const [showBulkAssign,   setShowBulkAssign  ] = useState(false);
  const [bulkAssigning,    setBulkAssigning   ] = useState(false);
  const [assignStrategy,   setAssignStrategy  ] = useState<BulkAssignStrategy>("manual");
  const [assignTarget,     setAssignTarget    ] = useState<string>("unassigned");
  const [assignOverwriteConfirmed, setAssignOverwriteConfirmed] = useState(false);
  const [assignSkipAssigned, setAssignSkipAssigned] = useState(false);
  const [employees,        setEmployees       ] = useState<Profile[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [retryingAll,      setRetryingAll     ] = useState(false);

  async function handleRetryAllFailed() {
    if (!session || retryingAll) return;
    setRetryingAll(true);
    try {
      const { requeued } = await retryAllFailedEnrichment(session.access_token);
      toast.success(requeued > 0 ? `Retrying enrichment for ${requeued} compan${requeued === 1 ? "y" : "ies"}…` : "Nothing left to retry.");
      setTimeout(() => { if (session) void loadLeads(session.access_token); }, 3000);
    } catch (e) {
      toast.error((e as Error).message || "Retry failed");
    } finally {
      setRetryingAll(false);
    }
  }

  useEffect(() => {
    if (role !== "manager" || !session) return;
    setEmployeesLoading(true);
    fetchUsers(session.access_token).then((users) => {
      setEmployees(users.filter((u) => u.role === "employee" && u.is_active));
    }).catch(() => {}).finally(() => setEmployeesLoading(false));
  }, [role, session]);

  // Sync filter/view state into URL so refresh preserves it
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchQuery)                  params.set("q",        searchQuery);
    if (leadsSort !== "newest")       params.set("sort",     leadsSort);
    if (leadsViewMode !== "list")     params.set("view",     leadsViewMode);
    if (leadsEntityMode !== "individual") params.set("entity", leadsEntityMode);
    if (filters.statuses.size > 0)     params.set("statuses", [...filters.statuses].join(","));
    if (filters.assignees.size > 0)    params.set("assignees", [...filters.assignees].join(","));
    if (filters.sources.size  > 0)     params.set("sources",  [...filters.sources].join(","));
    if (filters.batchLabels.size > 0)  params.set("batches",  [...filters.batchLabels].join(","));
    if (filters.createdFrom)          params.set("from", filters.createdFrom.toISOString().slice(0, 10));
    if (filters.createdTo)            params.set("to",   filters.createdTo.toISOString().slice(0, 10));
    if (scoredFilter.searchIds.length) params.set("sbatch",  scoredFilter.searchIds.join(","));
    if (scoredFilter.groups.length)    params.set("sgroups", scoredFilter.groups.join(","));
    if (scoredFilter.hidden)           params.set("shidden", "1");
    const qs = params.toString();
    // Debounced. `searchQuery` is in the dep list and moves on every keystroke,
    // and Next 15 defaults staleTimes.dynamic to 0 — a dynamic route is never
    // reused from the client router cache — so each replace() refetched this
    // route's RSC payload, re-running the server layout's session check and its
    // exact count over the whole leads table once per character typed. The URL
    // still lands on exactly the same value; it just settles after typing stops.
    const handle = setTimeout(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchQuery, leadsSort, leadsViewMode, leadsEntityMode, filters, scoredFilter, pathname, router]);

  const scored = useScoredOrgs(scoredFilter, searchQuery, leadsEntityMode === "orgs");
  const scoredView = leadsEntityMode === "orgs" && (leadsViewMode === "kanban" || scoredFilterActive(scoredFilter));
  // Status of each organization that came from a scored search, for the classic list's Status column.
  const orgFitStatus = useMemo(() => {
    const m = new Map<string, { group: Group; status: string }>();
    for (const c of scored.data?.companies ?? []) if (c.organization_id) m.set(c.organization_id, { group: c.group, status: c.status });
    return m;
  }, [scored.data]);
  // Approved / contact-added companies have an organization: open the normal org
  // drawer. Anything else opens the scored-company drawer with what we know.
  const [scoredDrawerId, setScoredDrawerId] = useState<string | null>(null);
  const scoredDrawerCompany = scored.data?.companies.find((c) => c.id === scoredDrawerId) ?? null;
  function openScoredCompany(c: ScoredCompany) {
    if (c.organization_id) setSelectedOrgId(c.organization_id);
    else setScoredDrawerId(c.id);
  }
  async function handleScoredDecide(ids: string[], action: DecideAction) {
    try { await decideScored(ids, action); } catch (e) { toast.error((e as Error).message); }
    await scored.reload();
  }
  // "Open in Organizations" from Add leads > Scored Companies lands here, on that batch.
  useEffect(() => {
    function onOpen(e: Event) {
      const id = (e as CustomEvent<{ searchId: string }>).detail?.searchId;
      setLeadsEntityMode("orgs");
      setLeadsViewMode("list");
      setScoredFilter({ ...EMPTY_SCORED_FILTER, searchIds: id ? [id] : [] });
    }
    window.addEventListener("kuber:open-scored-batch", onOpen);
    return () => window.removeEventListener("kuber:open-scored-batch", onOpen);
  }, []);

  // Reset to page 1 whenever the filtered result set changes
  useEffect(() => { setPage(1); }, [searchQuery, filters, leadsSort]);

  // Load leads only when visiting this page (not globally on every route).
  // Gated on a ref rather than `leads.length === 0`: an empty list is a
  // perfectly valid answer — an employee with no assigned leads gets one every
  // time, and so does anyone whose fetch failed, since loadLeads swallows
  // errors and leaves the array empty. Inferring "not loaded yet" from it meant
  // the effect re-fired the instant `loadingLeads` fell back to false, with
  // nothing to ever satisfy the exit condition: an unbounded request loop that
  // strobed the page skeleton on and off for as long as the tab stayed open.
  // Keyed on the user id so a genuine account switch still forces a fresh load,
  // while the repeated same-user session objects supabase-js emits on tab focus
  // do not.
  const loadedForUser = useRef<string | null>(null);
  useEffect(() => {
    if (!session || loadedForUser.current === session.user.id) return;
    loadedForUser.current = session.user.id;
    void loadLeads(session.access_token);
  }, [session, loadLeads]);

  // Background enrichment (email reveal, website scraping) keeps changing lead
  // status after this page's initial load, but nothing pushes those changes to
  // the browser — without this, the list/Kanban silently goes stale and looks
  // like data disappeared even though the database is fine. Poll quietly
  // while this page is open. Skip hidden tabs — a backgrounded Leads page
  // polling every 30s is pure waste.
  //
  // `background: true` is what makes it quiet: the tick refreshes the rows in
  // place without touching `loadingLeads`, which the render below turns into a
  // full-page skeleton. Previously every tick tore the table out and put the
  // shimmer back for the length of the fetch — seconds, on a deployed serverless
  // function — so a page nobody was touching appeared to reload itself twice a
  // minute. Overlap protection moved into loadLeads with it (it now knows about
  // background loads too; the old ref here only ever saw foreground ones).
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadLeads(session.access_token, { background: true });
    }, 30_000);
    return () => clearInterval(interval);
  }, [session, loadLeads]);

  // Fetch import batches for the batch filter dropdown. Keyed on leads.length,
  // not `leads`: the 30s poll replaces the array with a fresh (equal-length)
  // one every tick, so depending on the array itself refetched this on every
  // poll forever. Length still changes when a new page or import lands, which
  // is the only time a new batch can actually appear.
  useEffect(() => {
    if (!session) return;
    fetchImports(session.access_token)
      .then((r) => setImportBatches(r.imports))
      .catch(() => {});
  }, [session, leads.length]);

  // Search runs against the whole DB, not just whatever's currently paged
  // into `leads` — a lead further back than the loaded window would
  // otherwise never be findable. Debounced so we're not hitting the API on
  // every keystroke.
  // EVERY filter goes to the database, not to the browser. `leads` only holds
  // the first page (500 rows, newest first), so filtering it was really
  // "filter the newest 500" — an employee, batch or status whose rows all sit
  // further back matched nothing, which is exactly what a bulk import of
  // historical leads produces. Filtering a window is not filtering.
  //
  // Batch is chosen by label in the UI but stored as import_id, and two imports
  // can share a label, so map the label to every id that carries it.
  const serverFilters: LeadListFilters | undefined = useMemo(() => {
    const f: LeadListFilters = {};
    if (filters.assignees.size === 1) f.assigned_to = [...filters.assignees][0];
    if (filters.statuses.size > 0) f.statuses = [...filters.statuses].map((s) => DB_LEAD_STATUS[s] ?? s);
    if (filters.sources.size > 0) f.sources = [...filters.sources].map((s) => DB_LEAD_SOURCE[s] ?? s);
    if (filters.batchLabels.size > 0) {
      f.import_ids = importBatches.filter((b) => filters.batchLabels.has(b.label)).map((b) => b.id);
      if (f.import_ids.length === 0) delete f.import_ids;
    }
    if (filters.createdFrom) f.created_after = filters.createdFrom.toISOString();
    if (filters.createdTo) {
      const to = new Date(filters.createdTo);
      to.setHours(23, 59, 59, 999);
      f.created_before = to.toISOString();
    }
    return Object.keys(f).length > 0 ? f : undefined;
  }, [filters, importBatches]);

  // True per-stage totals for the Kanban headers. The board renders whatever
  // cards are loaded (with its own "Show more" below), but the numbers on the
  // columns have to be the real ones or they contradict the Dashboard.
  const [kanbanTotals, setKanbanTotals] = useState<Partial<Record<LeadStatus, number>>>({});
  useEffect(() => {
    if (!session) return;
    fetchLeadStatusCounts(session.access_token)
      .then((byStatus) => {
        const totals: Partial<Record<LeadStatus, number>> = {};
        for (const [dbStatus, n] of Object.entries(byStatus)) {
          const label = LEAD_STATUS_LABEL[dbStatus];
          if (label) totals[label] = (totals[label] ?? 0) + n;
        }
        setKanbanTotals(totals);
      })
      .catch(() => {});
  }, [session, leads.length]);

  useEffect(() => {
    // Org tab filters client-side; don't burn lead-search requests while there.
    if (leadsEntityMode !== "individual") return;
    const trimmed = searchQuery.trim();
    if (!trimmed && !serverFilters) { setSearchResults(null); setSearchLoading(false); return; }
    if (!session) return;
    setSearchLoading(true);
    const handle = setTimeout(() => {
      searchLeads(session.access_token, trimmed, serverFilters)
        .then((res) => setSearchResults(res.leads))
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [searchQuery, session, searchLeads, serverFilters, leadsEntityMode]);

  const matchesFilters = (l: Lead) => {
    if (filters.statuses.size > 0 && !filters.statuses.has(l.status)) return false;
    if (filters.assignees.size > 0) {
      const matchesAssignee = [...filters.assignees].some((v) =>
        v === UNASSIGNED_FILTER_VALUE ? !l.assignedTo : l.assignedTo === v
      );
      if (!matchesAssignee) return false;
    }
    if (filters.sources.size  > 0 && !filters.sources.has(l.source)) return false;
    if (filters.batchLabels.size > 0 && !filters.batchLabels.has(l.batchLabel ?? "")) return false;
    if (filters.createdFrom) {
      const leadDate = new Date(l.createdAt);
      leadDate.setHours(0, 0, 0, 0);
      if (leadDate < filters.createdFrom) return false;
    }
    if (filters.createdTo) {
      const to = new Date(filters.createdTo);
      to.setHours(23, 59, 59, 999);
      if (new Date(l.createdAt) > to) return false;
    }
    return true;
  };

  // A search query runs against the whole DB (searchResults), not just the
  // leads currently paged into the client — see searchLeads in app-context.
  const q = searchQuery.trim();
  // searchResults is the server-side result set — populated by a search term, an
  // assignee filter, or both. Prefer it whenever it exists: it is the complete
  // match from the database, where `leads` is only the newest page.
  const displayLeads = sortLeads((searchResults ?? leads).filter(matchesFilters), leadsSort);

  // Org view is built from loaded leads, then searched/sorted as organizations.
  // Lead filters stay Individual-only — they don't apply here.
  const orgRows = (() => {
    const orgMap = new Map<string, OrgRow>();
    for (const lead of leads) {
      if (!lead.orgId) continue;
      if (!orgMap.has(lead.orgId)) {
        orgMap.set(lead.orgId, {
          id: lead.orgId,
          name: lead.company,
          domain: lead.domain,
          enrichmentStage: lead.enrichmentStage,
          companyDescription: lead.companyDescription,
          sellsTo: lead.sellsTo,
          leads: [],
        });
      }
      orgMap.get(lead.orgId)!.leads.push(lead);
    }
    const orgQ = q.toLowerCase();
    const filtered = Array.from(orgMap.values()).filter((org) => {
      if (!orgQ) return true;
      return (
        org.name.toLowerCase().includes(orgQ) ||
        org.domain.toLowerCase().includes(orgQ)
      );
    });
    return sortOrgs(filtered, leadsSort);
  })();

  const totalPages = Math.max(1, Math.ceil(displayLeads.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedLeads = displayLeads.slice((safePage - 1) * pageSize, safePage * pageSize);

  const eligibleInView = pagedLeads.filter(isCampaignEligible);
  const allEligibleChecked = eligibleInView.length > 0 && eligibleInView.every((l) => checkedIds.has(l.id));
  const someChecked = pagedLeads.some((l) => checkedIds.has(l.id));
  // Resolve against every lead seen this session, not the loaded page —
  // a selection made under a filter is mostly outside `leads`, which made
  // checkedCount undercount and canCreateCampaign go false.
  const checkedLeads = leadsByIds(checkedIds);
  const checkedCount = checkedLeads.length;
  const eligibleCheckedCount = checkedLeads.filter(isCampaignEligible).length;
  const ineligibleCheckedCount = checkedCount - eligibleCheckedCount;
  const canCreateCampaign = eligibleCheckedCount > 0 && ineligibleCheckedCount === 0;

  function toggleAll() {
    if (allEligibleChecked) {
      setCheckedIds((prev) => {
        const next = new Set(prev);
        eligibleInView.forEach((l) => next.delete(l.id));
        return next;
      });
    } else {
      setCheckedIds((prev) => {
        const next = new Set(prev);
        eligibleInView.forEach((l) => next.add(l.id));
        return next;
      });
    }
  }

  function toggleOne(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ── */}
      {/* No redundant page-title block here — the app shell's top bar already
          shows "Leads" as the section identity; this row is action controls only. */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          <SegmentedTabs
            value={leadsEntityMode}
            onValueChange={setLeadsEntityMode}
            className="shrink-0"
            options={[
              { value: "individual", label: "Individual", icon: Users, tip: "One row per person." },
              { value: "orgs", label: "Organization", icon: Building2, tip: "One row per company, including scored companies waiting for review." },
            ]}
          />

          {role === "manager" && (
            <Tip text={checkedIds.size === 0 ? "Select leads first, then give them to a team member." : "Give the selected leads to a team member."}>
              <Button
                size="sm" variant="outline" className="gap-1.5"
                disabled={checkedIds.size === 0}
                onClick={() => { if (checkedIds.size > 0) { setAssignOverwriteConfirmed(false); setAssignSkipAssigned(false); setShowBulkAssign(true); } }}
              >
                <UserPlus className="size-3.5" /> Assign{checkedIds.size > 0 ? ` (${checkedIds.size})` : ""}
              </Button>
            </Tip>
          )}
          <Tip text={!canCreateCampaign ? "Only enriched leads with a domain can be added to campaigns. Select some first." : "Start a campaign from the selected leads."}>
            <Button
              size="sm" className="gap-1.5"
              disabled={!canCreateCampaign}
              onClick={() => { setShowCreateCampaign(true); }}
            >
              <Megaphone className="size-3.5" /> Create campaign{eligibleCheckedCount > 0 ? ` (${eligibleCheckedCount})` : ""}
            </Button>
          </Tip>
          {someChecked && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCheckedIds(new Set())}
              className="h-auto p-0 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              Clear
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {(leadsEntityMode === "individual" || leadsEntityMode === "orgs") && (
            <SegmentedTabs
              value={leadsViewMode}
              onValueChange={setLeadsViewMode}
              options={[
                { value: "list", label: "List", icon: List, tip: "Show as a table." },
                { value: "kanban", label: "Kanban", icon: Kanban, tip: "Show as columns by stage." },
              ]}
            />
          )}
          <Tip text="Reload the latest data.">
            <Button
              variant="outline" size="sm" className="gap-1.5"
              disabled={loadingLeads}
              onClick={() => {
                if (!session) return;
                void loadLeads(session.access_token);
              }}
            >
              <RefreshCw className={cn("size-3.5", loadingLeads && "animate-spin")} />
              Refresh
            </Button>
          </Tip>
          {role === "manager" && (
            <Tip text="Import leads from Apollo, Excel or add one manually.">
              <Button size="sm" onClick={() => setShowAddLeads(true)} className="gap-1.5">
                <Plus className="size-3.5" /> Add leads
              </Button>
            </Tip>
          )}
        </div>
      </div>

      {/* Upstream credit/API-key failures — previously only shown on Dashboard,
          so a stalled queue here (leads stuck in New) had no visible cause. */}
      <div className="px-8 pt-3">
        <ServiceHealthBanner />
      </div>
      {leadsEntityMode === "orgs" && (
        <div className="px-8 pt-3">
          <RunningSearchesBar
            data={scored.data}
            onOpen={(searchId, group) => { setLeadsViewMode("list"); setScoredFilter({ ...EMPTY_SCORED_FILTER, searchIds: [searchId], groups: group ? [group] : [] }); }}
          />
        </div>
      )}

      {/* ── Search + Columns toolbar ── */}
      {(leadsEntityMode === "orgs" || (leadsEntityMode === "individual" && (leadsViewMode === "list" || leadsViewMode === "kanban"))) && (
        <div className="flex items-center gap-3 px-8 py-3 border-b border-border shrink-0 bg-secondary">
          <Tip block text={leadsEntityMode === "orgs" ? "Search by company name." : "Search by lead name, email or company."} className="flex-1 max-w-xs">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={leadsEntityMode === "orgs" ? "Search organizations…" : "Search leads or organization…"}
              size="sm"
              wrapperClassName="w-full"
              className="bg-field"
            />
          </Tip>
          {leadsEntityMode === "individual" && someChecked && role === "manager" && (
            <Button
              size="sm" variant="destructive" className="gap-1.5 text-white!"
              onClick={() => { if (checkedIds.size > 0) setShowBulkDelete(true); }}
            >
              <Trash2 className="size-3.5" /> Delete ({checkedIds.size})
            </Button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <Tip text="Order the list.">
            <Select value={leadsSort} onValueChange={(value) => setLeadsSort(value as LeadsSort)}>
              <SelectTrigger className="h-8 w-36 gap-2 rounded-md border-border bg-field px-3 text-xs shadow-sm">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent align="end" className="min-w-36">
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
                <SelectItem value="az">A – Z</SelectItem>
                <SelectItem value="za">Z – A</SelectItem>
              </SelectContent>
            </Select>
            </Tip>
            {leadsEntityMode === "individual" && (
              <Tip text="Filter by status, owner, source, batch and date.">
              <Button
                type="button"
                variant={isFiltersEmpty(filters) ? "outline" : "default"}
                size="sm"
                className="relative gap-1.5"
                onClick={() => setShowFilters(true)}
              >
                <SlidersHorizontal className="size-3.5" />
                Filters
                {!isFiltersEmpty(filters) && (
                  <span className="ml-0.5 size-4 rounded-full bg-primary-foreground/20 font-mono text-[9px] leading-none font-bold tabular-nums flex items-center justify-center">
                    <span className="translate-y-px">{activeFilterCount(filters)}</span>
                  </span>
                )}
              </Button>
              </Tip>
            )}
            {leadsEntityMode === "orgs" && (
              <Tip text="Filter companies by stage and batch.">
              <Button
                type="button"
                variant={scoredFilterActive(scoredFilter) ? "default" : "outline"}
                size="sm"
                className="relative gap-1.5"
                onClick={() => setShowScoredFilters(true)}
              >
                <SlidersHorizontal className="size-3.5" />
                Filters
                {scoredFilterActive(scoredFilter) && (
                  <span className="ml-0.5 size-4 rounded-full bg-primary-foreground/20 font-mono text-[9px] leading-none font-bold tabular-nums flex items-center justify-center">
                    <span className="translate-y-px">{scoredFilterCount(scoredFilter)}</span>
                  </span>
                )}
              </Button>
              </Tip>
            )}
            {leadsEntityMode === "orgs" && !scoredView ? (
              <ColumnsDropdown
                defs={ORG_COLUMN_DEFS}
                visible={orgVisibleCols}
                onChange={setOrgVisibleCols}
                defaultVisible={DEFAULT_ORG_VISIBILITY}
              />
            ) : (
              leadsViewMode === "list" && (
                <ColumnsDropdown
                  defs={COLUMN_DEFS}
                  visible={visibleCols}
                  onChange={setVisibleCols}
                  defaultVisible={DEFAULT_VISIBILITY}
                />
              )
            )}
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {leadsEntityMode === "orgs"
                ? scoredView ? `${scored.data?.companies.length ?? 0} companies` : `${orgRows.length} orgs`
                : searchLoading ? "…" : `${displayLeads.length} leads`}
            </span>
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 overflow-auto px-4 py-5">
        {/* Not gated on `q`: a filter with no search text also fetches from the
            server, and skipping the skeleton there rendered the stale 500-row
            window through matchesFilters — i.e. "No leads yet" — until it landed. */}
        {loadingLeads || searchLoading ? (
          <div className="rounded-xl border border-border bg-field dark:bg-card shadow-sm overflow-hidden">
            <div className="divide-y divide-border animate-pulse">
              <div className="flex items-center gap-4 px-4 py-3">
                {[10, 8, 32, 20, 20, 14, 12, 10].map((w, i) => (
                  <div key={i} className="h-3 bg-secondary rounded" style={{ width: `${w}%` }} />
                ))}
              </div>
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                  <div className="size-4 rounded bg-secondary shrink-0" />
                  <div className="size-2 rounded-full bg-secondary shrink-0" />
                  <div className="size-8 rounded-full bg-secondary shrink-0" />
                  <div className="h-3 bg-secondary rounded" style={{ width: `${12 + (i % 3) * 4}%` }} />
                  <div className="h-3 bg-secondary rounded" style={{ width: `${8 + (i % 4) * 3}%` }} />
                  <div className="h-3 bg-secondary rounded ml-auto" style={{ width: "10%" }} />
                  <div className="h-5 w-14 bg-secondary rounded-md" />
                  <div className="h-3 bg-secondary rounded" style={{ width: "8%" }} />
                  <div className="h-3 bg-secondary rounded" style={{ width: "7%" }} />
                </div>
              ))}
            </div>
          </div>
        ) : scoredView && leadsViewMode === "kanban" ? (
          <ScoredOrgsKanban
            data={scored.data}
            error={scored.error}
            loading={scored.loading}
            onDecide={handleScoredDecide}
            groups={scoredFilter.groups}
            showHidden={scoredFilter.hidden}
            onOpenCompany={openScoredCompany}
          />
        ) : scoredView ? (
          <ScoredOrgsTable data={scored.data} error={scored.error} loading={scored.loading} onDecide={handleScoredDecide} onOpenCompany={openScoredCompany} />
        ) : leadsEntityMode === "orgs" ? (
            <div>
              <div className="rounded-xl border border-border bg-field dark:bg-card shadow-sm overflow-hidden w-full">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Organization</TableHead>
                      {orgVisibleCols.fit_status && (
                        <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</TableHead>
                      )}
                      {orgVisibleCols.domain && (
                        <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Domain</TableHead>
                      )}
                      {orgVisibleCols.description && (
                        <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Description</TableHead>
                      )}
                      {orgVisibleCols.sells_to && (
                        <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sells To</TableHead>
                      )}
                      {orgVisibleCols.leads && (
                        <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground text-right">Leads</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orgRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={1 + Object.values(orgVisibleCols).filter(Boolean).length} className="p-0">
                          <EmptyState
                            boxed={false}
                            message={
                              q
                                ? `No organizations match "${q}".`
                                : "No organizations found. Add leads with a domain to populate this view."
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      orgRows.map((org) => (
                        <TableRow
                          key={org.id}
                          onClick={() => setSelectedOrgId(org.id)}
                          className="cursor-pointer border-border border-l-2 border-l-transparent transition-colors hover:border-l-primary hover:bg-secondary"
                        >
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <div className="size-7 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
                                <Building2 className="size-3.5 text-muted-foreground" />
                              </div>
                              <p className="text-sm font-semibold">{org.name || "—"}</p>
                            </div>
                          </TableCell>
                          {orgVisibleCols.fit_status && (
                            <TableCell>
                              {orgFitStatus.has(org.id)
                                ? <GroupPill group={orgFitStatus.get(org.id)!.group} status={orgFitStatus.get(org.id)!.status} />
                                : <span className="text-xs text-muted-foreground">—</span>}
                            </TableCell>
                          )}
                          {orgVisibleCols.domain && (
                            <TableCell><span className="font-mono text-xs text-muted-foreground">{org.domain || "—"}</span></TableCell>
                          )}
                          {orgVisibleCols.description && (
                            <TableCell className="max-w-xs">
                              <span className="text-xs text-muted-foreground line-clamp-2">{org.companyDescription || "—"}</span>
                            </TableCell>
                          )}
                          {orgVisibleCols.sells_to && (
                            <TableCell className="max-w-xs">
                              <span className="text-xs text-muted-foreground line-clamp-2">{org.sellsTo || "—"}</span>
                            </TableCell>
                          )}
                          {orgVisibleCols.leads && (
                            <TableCell className="text-right">
                              <span className="font-mono text-xs font-semibold tabular-nums">{org.leads.length}</span>
                            </TableCell>
                          )}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
        ) : leadsViewMode === "kanban" ? (
          <>
            <KanbanBoard
              leads={displayLeads}
              columnTotals={searchResults ? undefined : kanbanTotals}
              onCardClick={(lead) => setSelectedLead(lead)}
              onRetryAllFailed={role === "manager" ? handleRetryAllFailed : undefined}
              retryingAll={retryingAll}
            />
            {leadsTotal !== null && leads.length < leadsTotal && (
              <div className="flex flex-col items-center gap-1 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => session && loadAllLeads(session.access_token)}
                  disabled={loadingAllLeads}
                  className="text-xs"
                >
                  {loadingAllLeads ? `Loading… (${leads.length} of ${leadsTotal})` : `Load all leads (${leads.length} of ${leadsTotal})`}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-border bg-field dark:bg-card shadow-sm overflow-hidden">
            {/* Compact cells so all columns (incl. Created) fit without clipping */}
            <Table className="[&_th]:px-3 [&_td]:px-3 [&_td]:py-3">
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-10 pl-4">
                    <AppCheckbox
                      checked={allEligibleChecked ? true : someChecked ? "indeterminate" : false}
                      onClick={toggleAll}
                    />
                  </TableHead>
                  <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Lead</TableHead>
                  {visibleCols.organization && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Organization</TableHead>}
                  {visibleCols.email     && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Email</TableHead>}
                  {visibleCols.phone     && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Phone</TableHead>}
                  {visibleCols.job_title && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Job Title</TableHead>}
                  {visibleCols.status    && (
                    <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span className="inline-flex items-center gap-0.5">
                        Status <InfoTip text={CAMPAIGN_ACTION_HELP.statusColumn} />
                      </span>
                    </TableHead>
                  )}
                  {visibleCols.assigned  && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Assigned</TableHead>}
                  {visibleCols.source    && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</TableHead>}
                  {visibleCols.domain    && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Domain</TableHead>}
                  {visibleCols.country   && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Country</TableHead>}
                  {visibleCols.campaign  && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Campaign</TableHead>}
                  {visibleCols.batch     && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Batch</TableHead>}
                  {visibleCols.added     && <TableHead className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Created</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedLeads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={13} className="p-0">
                      <EmptyState
                        boxed={false}
                        message={searchQuery ? `No leads match "${searchQuery}".` : "No leads yet. Click \"Add leads\" to get started."}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedLeads.map((lead) => {
                    const isChecked = checkedIds.has(lead.id);
                    const eligible = isCampaignEligible(lead);
                    const ineligibleReason = campaignIneligibleReason(lead);
                    return (
                      <TableRow
                        key={lead.id}
                        onClick={() => setSelectedLead(lead)}
                        className={cn(
                          "cursor-pointer border-border border-l-2 border-l-transparent transition-colors hover:border-l-primary hover:bg-secondary",
                          isChecked && "bg-secondary border-l-primary",
                        )}
                      >
                        <TableCell
                          className="pl-4"
                          onClick={(e) => {
                            // Ineligible (still-enriching) leads must not be
                            // selectable — the disabled checkbox alone left the
                            // cell click as a loophole to select them.
                            e.stopPropagation();
                            if (eligible) toggleOne(lead.id, e);
                          }}
                        >
                          <AppCheckbox
                            checked={isChecked && eligible}
                            disabled={!eligible}
                            title={ineligibleReason ?? undefined}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <Avatar name={`${lead.firstName} ${lead.lastName}`} size="sm" />
                            <p className="text-sm font-semibold">{lead.firstName} {lead.lastName}</p>
                          </div>
                        </TableCell>
                        {visibleCols.organization && <TableCell><span className="text-sm">{lead.company || "—"}</span></TableCell>}
                        {visibleCols.email     && <TableCell><span className="font-mono text-xs text-muted-foreground block max-w-[190px] truncate" title={lead.email}>{lead.email}</span></TableCell>}
                        {visibleCols.phone     && <TableCell><span className="font-mono text-xs text-muted-foreground">{lead.phone || "—"}</span></TableCell>}
                        {visibleCols.job_title && <TableCell><span className="text-sm">{lead.jobTitle}</span></TableCell>}
                        {visibleCols.status    && <TableCell><StatusBadge status={lead.status} /></TableCell>}
                        {visibleCols.assigned  && (
                          <TableCell>
                            {lead.assignedTo ? (
                              <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                                <User className="size-3 text-muted-foreground shrink-0" />
                                {assigneeDisplayName(lead.assignedTo, session, employees)}
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] leading-none font-mono font-semibold uppercase tracking-wider bg-yellow-500/10 text-yellow-400 border border-yellow-500/25">
                                <span className="translate-y-px">Unassigned</span>
                              </span>
                            )}
                          </TableCell>
                        )}
                        {visibleCols.source    && <TableCell><span className="text-xs text-muted-foreground">{lead.source}</span></TableCell>}
                        {visibleCols.domain    && <TableCell><span className="font-mono text-xs text-muted-foreground">{lead.domain || "—"}</span></TableCell>}
                        {visibleCols.country   && <TableCell><span className="text-xs text-muted-foreground">{lead.country || "—"}</span></TableCell>}
                        {visibleCols.campaign && (
                          <TableCell>
                            {lead.campaigns.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {lead.campaigns.map((c) => (
                                  <span key={c.id} className="font-mono text-[10px] leading-none font-medium bg-secondary border border-border rounded-sm px-1.5 py-0.5 text-muted-foreground whitespace-nowrap">
                                    <span className="translate-y-px inline-block">{c.name}</span>
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
                        {visibleCols.batch && (
                          <TableCell>
                            {lead.batchLabel ? (
                              <Pill color={(lead.batchColor ?? "violet") as BatchColorName}>{lead.batchLabel}</Pill>
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                        )}
                        {visibleCols.added     && <TableCell><span className="font-mono text-xs text-muted-foreground tabular-nums whitespace-nowrap">{new Date(lead.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span></TableCell>}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* ── Pagination bar (list view only) ── */}
      {leadsEntityMode === "individual" && leadsViewMode === "list" && displayLeads.length > 0 && (
        <div className="shrink-0 border-t border-border px-8 py-3 flex items-center justify-between gap-4">
          <Field orientation="horizontal" className="w-fit">
            <FieldLabel htmlFor="leads-per-page">Leads per page</FieldLabel>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}
            >
              <SelectTrigger className="w-20 h-8 text-xs" id="leads-per-page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {/* Kanban had a "Show more" button but list view never did, so the
              paginator could only page within the leads already fetched — its
              "of N" counts loaded rows, not leadsTotal. With 1627 leads and a
              500-lead first page that silently stranded everything older than
              the newest 500 (every unassigned lead among them) unless someone
              thought to switch to Kanban, load more there, and switch back.
              Hidden whenever the server result set is in play (search OR
              filter) — searchLeads already pulled every match, and `leads`/
              `leadsTotal` describe the unfiltered window, so showing
              "500 of 1769" beside a filtered list of 859 was just wrong. */}
          {!searchResults && leadsTotal !== null && leads.length < leadsTotal && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => session && loadMoreLeads(session.access_token)}
              disabled={loadingMoreLeads}
              className="h-8 text-xs"
            >
              {loadingMoreLeads ? "Loading…" : `Show more (${leads.length} of ${leadsTotal})`}
            </Button>
          )}
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              Page {safePage} of {totalPages}
            </span>
            <Pagination className="mx-0 w-auto">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}

      <ScoredCompanyDrawer company={scoredDrawerCompany} onClose={() => setScoredDrawerId(null)} onDecide={handleScoredDecide} onFilterBatch={(id) => { setScoredFilter((f) => ({ ...f, searchIds: [id] })); setScoredDrawerId(null); }} />
      <ScoredFiltersDialog open={showScoredFilters} onOpenChange={setShowScoredFilters} value={scoredFilter} onApply={setScoredFilter} data={scored.data} />
      {showFilters && (
        <FiltersModal
          filters={filters}
          onChange={setFilters}
          onClose={() => setShowFilters(false)}
          imports={importBatches}
          employees={employees}
        />
      )}

      {/* Bulk delete confirmation modal */}
      <ConfirmDialog
        open={showBulkDelete}
        title={`Delete ${checkedIds.size} lead${checkedIds.size !== 1 ? "s" : ""}?`}
        description="This will permanently remove the selected leads. This cannot be undone."
        loading={bulkDeleting}
        confirmDisabled={!session}
        onClose={() => setShowBulkDelete(false)}
        onConfirm={async () => {
          if (!session) return;
          setBulkDeleting(true);
          try {
            await bulkDeleteLeads(session.access_token, [...checkedIds]);
            setCheckedIds(new Set());
            setShowBulkDelete(false);
            void loadLeads(session.access_token);
          } catch (e) {
            console.error("Bulk delete failed:", e);
          } finally {
            setBulkDeleting(false);
          }
        }}
      />

      {/* Bulk assign modal */}
      {showBulkAssign && (() => {
        const alreadyAssignedCount = leadsByIds(checkedIds).filter((l) => l.assignedTo).length;
        // With "skip already assigned" on, nothing gets overwritten, so no
        // reassignment confirmation is needed (spec §4).
        const needsOverwriteConfirm = alreadyAssignedCount > 0 && !assignSkipAssigned && !assignOverwriteConfirmed;
        return (
        <div className="fixed inset-0 z-200 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => { if (!bulkAssigning) setShowBulkAssign(false); }} />
          <div className="swatch-bar-top relative z-10 w-full max-w-sm mx-4 rounded-2xl border border-border bg-card shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex items-start gap-4">
              <div className="shrink-0 size-10 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center">
                <UserPlus className="size-5 text-primary" />
              </div>
              <div>
                <p className="eyebrow">Routing</p>
                <p className="font-display text-base font-semibold mt-0.5">Assign {checkedIds.size} lead{checkedIds.size !== 1 ? "s" : ""}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">Choose how these leads should be routed to employees.</p>
              </div>
            </div>

            <div className="grid gap-2">
              {ASSIGN_STRATEGIES.map((s) => {
                const checked = assignStrategy === s.value;
                return (
                  <label
                    key={s.value}
                    onClick={() => setAssignStrategy(s.value)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer bg-field hover:bg-field",
                      checked && "border-primary bg-primary/5",
                    )}
                  >
                    <AppRadio checked={checked} className="mt-1" />
                    <div>
                      <p className="text-sm font-medium">{s.label}</p>
                      <p className="text-xs text-muted-foreground">{s.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>

            {assignStrategy === "manual" && (
              employeesLoading ? (
                <div className="h-10 rounded-md border border-border bg-secondary animate-pulse" />
              ) : (
                <Select value={assignTarget} onValueChange={setAssignTarget}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="z-300">
                    <SelectItem value="unassigned">Unassigned (pool)</SelectItem>
                    {employees.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.full_name || e.email}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            )}

            {alreadyAssignedCount > 0 && (
              <div className="space-y-2">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setAssignSkipAssigned((v) => !v)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setAssignSkipAssigned((v) => !v); } }}
                  className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-xs cursor-pointer hover:bg-secondary"
                >
                  <AppCheckbox checked={assignSkipAssigned} className="mt-0.5" />
                  <span>
                    <span className="font-medium text-foreground">Skip already assigned leads</span>
                    <br />
                    <span className="text-muted-foreground">Leave the {alreadyAssignedCount} already-owned {alreadyAssignedCount !== 1 ? "leads" : "lead"} untouched and only assign the rest.</span>
                  </span>
                </div>
                {!assignSkipAssigned && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                    {alreadyAssignedCount} of these {alreadyAssignedCount !== 1 ? "leads are" : "lead is"} already assigned to someone else — proceeding will reassign {alreadyAssignedCount !== 1 ? "them" : "it"}.
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowBulkAssign(false)}
                disabled={bulkAssigning}
                className="rounded-lg bg-secondary"
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={bulkAssigning || !session || (assignStrategy === "manual" && employeesLoading)}
                onClick={async () => {
                  if (needsOverwriteConfirm) {
                    setAssignOverwriteConfirmed(true);
                    return;
                  }
                  if (!session) return;
                  setBulkAssigning(true);
                  try {
                    const summary: AssignmentSummary = await bulkAssignLeads(
                      session.access_token,
                      [...checkedIds],
                      assignStrategy,
                      assignStrategy === "manual" ? (assignTarget === "unassigned" ? null : assignTarget) : undefined,
                      assignSkipAssigned,
                    );
                    setCheckedIds(new Set());
                    setShowBulkAssign(false);
                    void loadLeads(session.access_token);

                    // Summarise the result (spec §3): what moved, what was skipped,
                    // and any offline/unmatched caveats.
                    const parts: string[] = [];
                    if (summary.newly_assigned) parts.push(`${summary.newly_assigned} assigned`);
                    if (summary.reassigned) parts.push(`${summary.reassigned} reassigned`);
                    if (summary.skipped_already_assigned) parts.push(`${summary.skipped_already_assigned} skipped (already owned)`);
                    if (summary.skipped_not_ready) parts.push(`${summary.skipped_not_ready} skipped (still enriching)`);
                    if (summary.unmatched) parts.push(`${summary.unmatched} left unassigned (no eligible employee)`);
                    toast.success(parts.length ? parts.join(" · ") : "No changes");
                    if (summary.skipped_not_ready) {
                      toast.warning(`${summary.skipped_not_ready} lead${summary.skipped_not_ready === 1 ? "" : "s"} still being enriched — they'll be assignable once ready.`);
                    }
                    if (summary.manual_target_offline) {
                      toast.warning("Heads up: that employee is currently marked offline (away).");
                    }
                    if (summary.excluded_offline > 0 && assignStrategy !== "manual") {
                      toast.message(`${summary.excluded_offline} offline employee${summary.excluded_offline !== 1 ? "s were" : " was"} excluded from routing.`);
                    }
                  } catch (e) {
                    toast.error((e as Error).message || "Bulk assign failed");
                  } finally {
                    setBulkAssigning(false);
                  }
                }}
                className="gap-2 rounded-lg"
              >
                {bulkAssigning ? <RefreshCw className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
                {needsOverwriteConfirm ? "Reassign anyway" : "Assign"}
              </Button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
