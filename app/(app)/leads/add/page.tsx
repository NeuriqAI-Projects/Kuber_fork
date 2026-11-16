"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useApp } from "@/lib/app-context";
import { useAccess } from "@/lib/access-context";

// The Add Leads flow now lives in one place — the shared `AddLeadsDrawer`
// modal rendered by the app shell — instead of being duplicated here as a
// second full-page copy of the same Apollo/Excel/Manual forms. This route is
// kept only so existing bookmarks/links still work: it opens that shared
// modal and redirects back to the leads list.
export default function AddLeadsPage() {
  const router = useRouter();
  const { loadingSession, setShowAddLeads } = useApp();
  const canImport = useAccess().can("leads:import");

  useEffect(() => {
    if (loadingSession) return;
    if (canImport) setShowAddLeads(true);
    router.replace("/leads");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingSession, canImport]);

  return null;
}
