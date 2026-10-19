import { NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { parseIndustryKeywordGroups, resolveApolloKeyword } from "@/lib/constants";
import { countPeopleAtCompanies } from "@/lib/services/apollo";
import { estimateMarket } from "@/lib/services/prospects/estimate";

const Body = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(30),
  locations: z.array(z.string()).max(50).optional(),
  employee_ranges: z.array(z.string()).max(20).optional(),
});

/** Free size check before a scored search: about how many companies and leads
 *  these filters can give. Uses Apollo People Search (0 credits). */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  // Same label → Apollo word mapping the search itself uses (search.ts).
  const { data: kw } = await dbForUser(user).from("settings").select("value").eq("key", "industry_keyword_groups").maybeSingle();
  const groups = parseIndustryKeywordGroups(kw?.value);
  const keywordTags = [...new Set(parsed.data.keywords.map((k) => resolveApolloKeyword(groups, k)))];
  try {
    const people = await countPeopleAtCompanies({ keywordTags, locations: parsed.data.locations, employeeRanges: parsed.data.employee_ranges });
    return ok({ free: true, ...estimateMarket(people) });
  } catch (e) {
    return fail(502, "UPSTREAM_APOLLO", `Couldn't check the size right now: ${(e as Error).message}`);
  }
}
