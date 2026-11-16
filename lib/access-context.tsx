"use client";

/**
 * What the signed-in member may do, for the UI. Fed by the (app) layout from the
 * profile row (requireAppSessionContext) — never from the JWT. The UI only HIDES;
 * every API route checks the same scope again (lib/auth/api-auth.ts requireScope).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { canSeeAll, hasScope, isLeadOwner, type Member, type Scope } from "@/lib/auth/scopes";

type Access = {
  member: Member;
  can: (...scopes: Scope[]) => boolean;
  seesAll: (area: "leads" | "campaigns" | "unibox" | "dashboard") => boolean;
  /** Receives leads (territory, availability, workload) — the old "employee". */
  ownsLeads: boolean;
  /** Holds at least one Add-leads source (imports:apollo / company / excel / manual). */
  canImportAny: boolean;
};

const IMPORT_SCOPES: Scope[] = ["imports:apollo", "imports:company", "imports:excel", "imports:manual"];

const AccessContext = createContext<Access | null>(null);

export function AccessProvider({ member, children }: { member: Member; children: ReactNode }) {
  const value = useMemo<Access>(() => ({
    member,
    can: (...scopes) => scopes.every((s) => hasScope(member, s)),
    seesAll: (area) => canSeeAll(member, area),
    ownsLeads: isLeadOwner(member),
    canImportAny: IMPORT_SCOPES.some((s) => hasScope(member, s)),
  }), [member]);
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): Access {
  const v = useContext(AccessContext);
  if (!v) throw new Error("useAccess must be used inside AccessProvider");
  return v;
}
