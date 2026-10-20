import type { NextRequest } from "next/server";
import type { AuthedUser } from "@/lib/auth/api-auth";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { createScopedClient } from "@/lib/supabase/scoped";
import type { AssistantCaller } from "@/lib/services/assistant/context";

/** The assistant always acts for one signed-in person in one company — never the service role. */
export function callerFromRequest(req: NextRequest, user: AuthedUser): AssistantCaller | null {
  if (!user.companyId) return null;
  const header = req.headers.get("authorization") ?? "";
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    db: createScopedClient(user.companyId),
    token: header.startsWith("Bearer ") ? header.slice(7) : "",
    baseUrl: internalAppBaseUrl(req),
  };
}

export async function callerDisplayName(caller: AssistantCaller): Promise<string> {
  const { data } = await caller.db.from("profiles").select("full_name, email").eq("id", caller.userId).maybeSingle();
  return (data?.full_name as string | null) || (data?.email as string | null) || caller.email || "a teammate";
}
