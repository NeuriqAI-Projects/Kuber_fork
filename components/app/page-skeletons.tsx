// Route skeletons, drawn in the same shape as the real screens (48px page
// header, toolbar, grid/record body) so a page switch looks like the next
// screen arriving, not a blank flash. Used by each route's loading.tsx.

const bar = "rounded bg-secondary";

function HeaderBar({ crumbs = 1, actions = 2 }: { crumbs?: number; actions?: number }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="size-5 rounded-[5px] bg-secondary" />
      {Array.from({ length: crumbs }).map((_, i) => (
        <div key={i} className={`h-3.5 ${i === 0 ? "w-24" : "w-32"} ${bar}`} />
      ))}
      <div className="ml-auto flex gap-2">
        {Array.from({ length: actions }).map((_, i) => (
          <div key={i} className="h-8 w-24 rounded-md border border-border bg-field" />
        ))}
      </div>
    </div>
  );
}

function ToolbarBar() {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <div className="h-7 w-32 rounded-md bg-secondary" />
      <div className="h-7 w-16 rounded-md bg-hover" />
      <div className="h-7 w-16 rounded-md bg-hover" />
      <div className="ml-auto h-7 w-56 rounded-md border border-border bg-field" />
    </div>
  );
}

function GridRows({ rows = 14, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="flex h-8 items-center border-b border-border">
        <div className="w-10 shrink-0" />
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="flex h-full flex-1 items-center border-l border-border px-3">
            <div className={`h-2.5 w-16 ${bar}`} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-9 items-center border-b border-border">
          <div className="flex w-10 shrink-0 justify-center"><div className="size-3.5 rounded-[4px] border border-border" /></div>
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="flex h-full flex-1 items-center gap-2 border-l border-border px-3">
              {c === 0 && <div className="size-5 shrink-0 rounded-full bg-secondary" />}
              <div className={`h-2.5 ${c === 0 ? "w-28" : c % 2 ? "w-16" : "w-20"} ${bar}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      <HeaderBar actions={1} />
      <div className="mx-auto w-full max-w-7xl space-y-5 px-6 py-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border bg-card p-4">
              <div className="size-7 rounded-md bg-secondary" />
              <div className={`h-2.5 w-20 ${bar}`} />
              <div className={`h-5 w-14 ${bar}`} />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-72 rounded-lg border border-border bg-card" />
          <div className="h-72 rounded-lg border border-border bg-card" />
        </div>
      </div>
    </div>
  );
}

export function LeadsSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      <HeaderBar />
      <ToolbarBar />
      <GridRows />
    </div>
  );
}

export function CampaignsSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      <HeaderBar actions={1} />
      <ToolbarBar />
      <GridRows rows={10} cols={6} />
    </div>
  );
}

/** A lead / organisation / campaign record view: header, tabs, body, details rail. */
export function RecordSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      <HeaderBar crumbs={2} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 px-6 pb-3 pt-5">
            <div className="size-10 rounded-full bg-secondary" />
            <div className="space-y-2">
              <div className={`h-4 w-40 ${bar}`} />
              <div className={`h-3 w-24 ${bar}`} />
            </div>
          </div>
          <div className="flex gap-5 border-b border-border px-6 pb-3 pt-1">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className={`h-3 w-14 ${bar}`} />)}
          </div>
          <div className="space-y-3 px-6 py-5">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 rounded-lg border border-border bg-card" />)}
          </div>
        </div>
        <div className="hidden w-[340px] shrink-0 space-y-3 border-l border-border px-4 py-4 lg:block">
          <div className={`h-3 w-24 ${bar}`} />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className={`h-2.5 w-20 ${bar}`} />
              <div className={`h-2.5 flex-1 ${bar}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Unibox: thread list on the left, open thread on the right. */
export function UniboxSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      <HeaderBar actions={1} />
      <div className="flex min-h-0 flex-1">
        <div className="w-[360px] shrink-0 border-r border-border">
          <div className="border-b border-border p-3"><div className="h-8 rounded-md border border-border bg-field" /></div>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="space-y-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-full bg-secondary" />
                <div className={`h-3 w-28 ${bar}`} />
                <div className={`ml-auto h-2.5 w-10 ${bar}`} />
              </div>
              <div className={`h-2.5 w-4/5 ${bar}`} />
            </div>
          ))}
        </div>
        <div className="flex-1 space-y-4 p-6">
          <div className={`h-5 w-64 ${bar}`} />
          <div className="h-40 rounded-lg border border-border bg-card" />
          <div className="h-28 rounded-lg border border-border bg-card" />
        </div>
      </div>
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      <HeaderBar actions={0} />
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-1 border-r border-border p-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 w-full rounded-md bg-hover" />
          ))}
        </aside>
        <div className="max-w-3xl flex-1 space-y-6 px-8 py-6">
          <div className="space-y-2 border-b border-border pb-5">
            <div className={`h-4 w-32 ${bar}`} />
            <div className={`h-3 w-64 ${bar}`} />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start justify-between gap-8 border-b border-border pb-5 last:border-0">
              <div className="w-48 space-y-1.5">
                <div className={`h-3.5 w-28 ${bar}`} />
                <div className={`h-2.5 w-full ${bar}`} />
              </div>
              <div className="h-8 max-w-sm flex-1 rounded-md border border-border bg-field" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RouteSkeleton({ href }: { href: string }) {
  if (href.startsWith("/settings") || href.startsWith("/credits")) return <SettingsSkeleton />;
  if (/^\/(leads|campaigns)\/[^/]+/.test(href) && !href.startsWith("/leads/add")) return <RecordSkeleton />;
  if (href.startsWith("/campaigns")) return <CampaignsSkeleton />;
  if (href.startsWith("/unibox")) return <UniboxSkeleton />;
  if (href.startsWith("/leads")) return <LeadsSkeleton />;
  if (href.startsWith("/model-lab")) return <SettingsSkeleton />;
  return <DashboardSkeleton />;
}
