/**
 * Client review workbook: every lead imported since 2 Sep 2026, one sheet per
 * batch, with the company, its domain, the keywords that found it, and empty
 * columns for the client to rate each row.
 *
 * Read-only. Writes one .xlsx and touches nothing in the database.
 */
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const KUBER = "00000000-0000-0000-0000-00000000000b";
const SINCE = "2026-09-02";
const OUT = process.argv[2] ?? "Kuber-Lead-Review.xlsx";

type Imp = { id: string; label: string; created_at: string; search_criteria: Record<string, unknown> | null };

/** Excel sheet names: <=31 chars, no []:*?/\ , and unique. */
function sheetName(label: string, used: Set<string>): string {
  // Excel forbids [ ] : * ? / \ in sheet names. Replaced by hand rather than
  // with a regex so no escaping can go wrong in transit.
  let base = label || "Batch";
  for (const bad of ["[", "]", ":", "*", "?", "/", String.fromCharCode(92)]) {
    base = base.split(bad).join(" ");
  }
  base = base.split(/\s+/).filter(Boolean).join(" ").slice(0, 28) || "Batch";
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) { name = `${base.slice(0, 25)} ${n++}`; }
  used.add(name.toLowerCase());
  return name;
}

/** search_criteria only exists from 2026-09-05 (the migration that started
 *  keeping what was asked for). Earlier batches genuinely have no record of
 *  their keywords, and a blank cell would read as "no keywords used" rather
 *  than "not captured" - so say which it is. */
const NOT_RECORDED = "Not recorded — imported before keyword tracking was added";

function keywordsOf(i: Imp): string {
  const kw = i.search_criteria?.["keywords"];
  if (Array.isArray(kw) && kw.length > 0) return kw.join(", ");
  return i.search_criteria ? "" : NOT_RECORDED;
}
function locationsOf(i: Imp): string {
  const l = i.search_criteria?.["locations"];
  if (Array.isArray(l) && l.length > 0) return l.join(", ");
  return i.search_criteria ? "" : NOT_RECORDED;
}

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: imports, error: impErr } = await db
    .from("imports").select("id, label, created_at, search_criteria")
    .eq("company_id", KUBER).gte("created_at", SINCE).order("created_at");
  if (impErr) throw impErr;
  const batches = (imports ?? []) as Imp[];

  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const summary: Record<string, string | number>[] = [];
  let grandLeads = 0;

  for (const imp of batches) {
    // Paged: a 500-lead batch is fine in one go, but PostgREST caps at 1,000
    // and several batches sit near that once organizations are joined.
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("leads")
        .select("first_name, last_name, title, email, email_status, seniority, linkedin_url, city, state, country, phone, status, organizations(name, domain, website, industry, employees, city, country)")
        .eq("import_id", imp.id).eq("is_deleted", false)
        .order("organization_id").range(from, from + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (rows.length === 0) continue;

    const kw = keywordsOf(imp), loc = locationsOf(imp);
    const sheetRows = rows.map((r) => {
      const o = (r.organizations ?? {}) as Record<string, unknown>;
      const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
      return {
        "Company": o.name ?? "",
        "Domain": o.domain ?? (o.website ? String(o.website).replace(/^https?:\/\//, "").replace(/\/.*$/, "") : ""),
        "Website": o.website ?? "",
        "Industry (Apollo)": o.industry ?? "",
        "Employees": o.employees ?? "",
        "Company Location": [o.city, o.country].filter(Boolean).join(", "),
        "Contact Name": name,
        "Job Title": r.title ?? "",
        "Seniority": r.seniority ?? "",
        "Email": r.email ?? "",
        "Email Status": r.email_status ?? "",
        "Phone": r.phone ?? "",
        "LinkedIn": r.linkedin_url ?? "",
        "Contact Location": [r.city, r.state, r.country].filter(Boolean).join(", "),
        "Keywords Used": kw,
        "Regions Searched": loc,
        // --- for the client to fill in ---
        "Useful? (Yes / No)": "",
        "Rating (1-5)": "",
        "Comments": "",
      };
    });

    const ws = XLSX.utils.json_to_sheet(sheetRows);
    ws["!cols"] = [
      { wch: 34 }, { wch: 26 }, { wch: 30 }, { wch: 22 }, { wch: 10 }, { wch: 22 },
      { wch: 22 }, { wch: 30 }, { wch: 14 }, { wch: 30 }, { wch: 13 }, { wch: 16 },
      { wch: 34 }, { wch: 24 }, { wch: 46 }, { wch: 28 },
      { wch: 18 }, { wch: 12 }, { wch: 40 },
    ];
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: 18, r: sheetRows.length } }) };
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    const sn = sheetName(imp.label, used);
    XLSX.utils.book_append_sheet(wb, ws, sn);

    grandLeads += sheetRows.length;
    summary.push({
      "Batch": imp.label?.trim() || "(untitled)",
      "Sheet": sn,
      "Date": new Date(imp.created_at).toISOString().slice(0, 10),
      "Leads": sheetRows.length,
      "Companies": new Set(sheetRows.map((r) => r["Company"])).size,
      "Keywords Used": kw,
      "Regions Searched": loc,
    });
  }

  const sws = XLSX.utils.json_to_sheet(summary);
  sws["!cols"] = [{ wch: 40 }, { wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 11 }, { wch: 70 }, { wch: 40 }];
  sws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: 6, r: summary.length } }) };
  // Summary first, then the batches in the order they were imported.
  XLSX.utils.book_append_sheet(wb, sws, "Summary");
  wb.SheetNames = ["Summary", ...wb.SheetNames.filter((n) => n !== "Summary")];

  XLSX.writeFile(wb, OUT);
  console.log(`${OUT}\n  ${summary.length} batch sheets + Summary\n  ${grandLeads.toLocaleString()} leads total`);
}
main();
