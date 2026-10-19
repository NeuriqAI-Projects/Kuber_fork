// Same shape as the campaign record page: 48px breadcrumb bar, record header,
// underline tabs, compact stat tiles and the Attio grid below.
export default function CampaignDetailLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Breadcrumb bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="size-5 rounded-[5px] bg-secondary" />
        <div className="h-3.5 w-20 rounded bg-secondary" />
        <div className="h-3.5 w-40 rounded bg-secondary" />
        <div className="ml-auto h-7 w-28 rounded-md bg-secondary" />
      </div>

      {/* Record header */}
      <div className="flex items-start gap-3 px-6 pt-4 pb-2">
        <div className="size-9 rounded-lg bg-secondary" />
        <div className="space-y-2">
          <div className="h-5 w-56 rounded bg-secondary" />
          <div className="flex gap-1.5">
            <div className="h-4 w-12 rounded bg-secondary" />
            <div className="h-4 w-20 rounded bg-secondary" />
          </div>
        </div>
      </div>

      {/* Underline tabs */}
      <div className="mx-6 flex h-10 items-center gap-5 border-b border-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3.5 w-16 rounded bg-secondary" />
        ))}
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-2 px-6 pt-4 sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-4 py-3">
            <div className="h-3 w-14 rounded bg-secondary" />
            <div className="h-5 w-10 rounded bg-secondary" />
          </div>
        ))}
      </div>

      {/* Grid rows */}
      <div className="mt-4 flex-1 px-6">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex h-9 items-center gap-4 border-b border-border px-4 last:border-0">
              <div className="size-4 rounded bg-secondary" />
              <div className="size-6 rounded-full bg-secondary" />
              <div className="h-3 w-32 rounded bg-secondary" />
              <div className="h-3 w-40 rounded bg-secondary" />
              <div className="ml-auto h-4 w-16 rounded bg-secondary" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
