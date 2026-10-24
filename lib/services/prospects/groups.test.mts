// npx tsx --test lib/services/prospects/groups.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./fake-db.mts";
import { scoredForOrg, statusLine } from "./groups.ts";

test("scoredForOrg: an org from a scored search gets its fit, reason, group, batch and contact", async () => {
  const { db, tables } = fakeDb();
  tables.prospect_searches.push({ id: "s1", filters: { batch_name: "Films", color: "blue" } });
  tables.prospect_companies.push({ id: "p1", search_id: "s1", organization_id: "o1", status: "review", score: 7, reason: "Makes films", decided_by: null, contact_apollo_id: "ap1" });
  const leads = [{ apollo_id: "ap1", first_name: "Ana", title: "Owner", email: "a@x.com" }];
  const s = await scoredForOrg(db, "o1", leads);
  assert.equal(s?.score, 7);
  assert.equal(s?.reason, "Makes films");
  assert.equal(s?.group, "review");
  assert.equal(s?.batch_name, "Films");
  assert.equal(s?.batch_color, "blue");
  assert.deepEqual(s?.contact, { first_name: "Ana", title: "Owner", email: "a@x.com" });
});

test("scoredForOrg: an org that did not come from a scored search gets null", async () => {
  const { db } = fakeDb();
  assert.equal(await scoredForOrg(db, "o2", []), null);
});

test("no-title-match review says nothing was spent and what Approve does", () => {
  const l = statusLine({ status: "review", last_error: "No one with your job titles has an email here (3 other people)" });
  assert.equal(l.tone, "amber");
  assert.equal(l.text, "Nobody here has the job titles you picked. Nothing spent. Approve to reveal the best buyer (1 credit).");
});

test("reveal-cap review says the leads asked for were reached and what Approve costs", () => {
  const l = statusLine({ status: "review", last_error: "Good fit, but this search already used all its automatic reveals" });
  assert.equal(l.text, "Good fit. Not revealed because you already got the leads you asked for. Approve to reveal (1 credit).");
});

test("companiesFilter: groups as exact PostgREST filters, joined with a name search", async () => {
  const { companiesFilter } = await import("./groups.ts");
  assert.equal(companiesFilter([], false, ""), null);
  assert.equal(companiesFilter(["review"], false, ""), "status.in.(review,flagged,site_down)");
  assert.equal(companiesFilter(["good"], true, ""), "and(status.in.(good,waiting_credits,no_contact,promoted),decided_by.is.null),status.eq.waiting_credits");
  assert.equal(companiesFilter(["approved"], false, "Acme"), "and(or(status.eq.approved,and(status.in.(good,waiting_credits,no_contact,promoted),decided_by.not.is.null)),or(name.ilike.*acme*,domain.ilike.*acme*))");
  // Commas/brackets would break the filter text: they become wildcards (the exact match runs in code).
  assert.equal(companiesFilter([], false, "a,b(c)"), "name.ilike.*a*b*c**,domain.ilike.*a*b*c**");
});

test("no-title-match review names the titles, a long list shortened", async () => {
  const { titledAs } = await import("./groups.ts");
  const l = statusLine({ status: "review", last_error: "No one with your job titles has an email here", job_titles: ["quality inspector"] });
  assert.equal(l.text, "Nobody here is titled 'quality inspector'. Nothing spent. Approve to reveal the best buyer (1 credit).");
  assert.equal(titledAs(["a", "b"]), "is titled 'a' or 'b'");
  assert.equal(titledAs(["a", "b", "c"]), "is titled 'a', 'b' or 1 more title");
  assert.equal(titledAs(["a", "b", "c", "d"]), "is titled 'a', 'b' or 2 more titles");
  assert.equal(titledAs([]), "has the job titles you picked");
});
