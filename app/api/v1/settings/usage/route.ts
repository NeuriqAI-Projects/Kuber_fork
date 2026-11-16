import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import {
  checkApolloCredits, checkFirecrawlCredits, checkOpenRouterCredits, checkInstantlyCredits, checkJevCredits, checkTavilyCredits,
  type CreditCheck,
} from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

type UsageStatus = "ok" | "low" | "out" | "unknown";

function statusFor(check: CreditCheck): UsageStatus {
  if (check.remaining == null) return check.ok ? "ok" : "low";
  if (check.remaining <= 0) return "out";
  return check.ok ? "ok" : "low";
}

// `scope` is per provider, not per caller: Apollo and Instantly are one shared
// account across companies, while Firecrawl and the LLM keys are per company.
const PROVIDERS: Array<{
  id: string;
  label: string;
  shared: boolean;
  check: (db: ReturnType<typeof dbForUser>, scope: string) => Promise<CreditCheck>;
}> = [
  { id: "apollo", label: "Apollo", shared: true, check: checkApolloCredits },
  { id: "firecrawl", label: "Firecrawl", shared: false, check: checkFirecrawlCredits },
  { id: "openrouter", label: "OpenRouter", shared: false, check: checkOpenRouterCredits },
  { id: "instantly", label: "Instantly", shared: true, check: checkInstantlyCredits },
  { id: "jev", label: "Jev", shared: false, check: checkJevCredits },
  { id: "tavily", label: "Tavily", shared: false, check: checkTavilyCredits },
];

// Anyone with credits:read sees each provider's status and the exact remaining
// number. (A super-admin-only trim used to null `remaining`, but `message` and
// the keys/usage/* routes already gave every manager the number — plan §7 C.)
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "credits:read"); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const checks = await Promise.all(
    PROVIDERS.map((p) => p.check(db, p.shared ? "any" : (user.companyId ?? "any"))),
  );

  const providers = PROVIDERS.map((p, i) => {
    const check = checks[i];
    return {
      id: p.id,
      label: p.label,
      status: statusFor(check),
      remaining: check.remaining,
      message: check.message,
    };
  });

  return ok({ providers });
}
