// npx tsx --test lib/services/prospects/promote.test.mts
// The step that creates the company + its one lead (the reveal job then pays
// for the email). It must be safe to repeat after a crash and must never add a
// second contact at a company.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promote } from "./deps.ts";
import { fakeDb } from "./fake-db.mts";
import type { ProspectRow } from "./pipeline.ts";

const row: ProspectRow = {
  id: "p", search_id: "s", apollo_org_id: "ap1", name: "Acme Film", domain: "acme.com", website_url: "https://acme.com",
  linkedin_url: null, twitter_url: null, facebook_url: null, status: "good", page_text: "x", page_markdown: "# Acme makes film", text_source: "website", attempts: 0,
};
const person = { id: "per1", title: "Purchase Manager", has_email: true, first_name: "Ana" };
const UNIQUE = { organizations: "apollo_org_id", leads: "apollo_id" };
const B = { importId: null, createdBy: "u1" };

test("P1. creates the company + one lead waiting for its email, and reuses the page we already paid for", async () => {
  const { db, tables } = fakeDb({ unique: UNIQUE });
  const orgId = await promote(db, row, person, false, { importId: "imp1", createdBy: "u1" });
  assert.equal(tables.organizations.length, 1);
  assert.equal(tables.organizations[0].scraped_markdown, "# Acme makes film", "no second Firecrawl credit later");
  assert.equal(tables.leads.length, 1);
  assert.deepEqual([tables.leads[0].has_email, tables.leads[0].email, tables.leads[0].organization_id, tables.leads[0].import_id], [true, null, orgId, "imp1"]);
  assert.equal(tables.leads[0].created_by, "u1", "leads.created_by is required (bug found by the 9 Oct mock test)");
});

test("P2. re-run after a crash: same company, still one lead", async () => {
  const { db, tables } = fakeDb({ unique: UNIQUE });
  const a = await promote(db, row, person, false, B);
  const b = await promote(db, row, person, false, B);
  assert.equal(a, b);
  assert.equal(tables.organizations.length, 1);
  assert.equal(tables.leads.length, 1);
});

test("P3. company reached the system another way and already has a contact: nobody added", async () => {
  const { db, tables } = fakeDb({ unique: UNIQUE });
  tables.organizations.push({ id: "org-x", domain: "acme.com" });
  tables.leads.push({ id: "l0", apollo_id: "someone-else", organization_id: "org-x", is_deleted: false });
  const orgId = await promote(db, row, person, false, B);
  assert.equal(orgId, "org-x");
  assert.equal(tables.leads.length, 1, "one lead per company holds");
});

test("P4. mock: the email is written now, so the reveal job can never pay for it", async () => {
  const { db, tables } = fakeDb({ unique: UNIQUE });
  await promote(db, row, person, true, B);
  assert.equal(tables.leads[0].email, "ana@acme.com");
  assert.equal(tables.organizations[0].enrichment_stage, "done");
});

test("P5. lead insert fails: the error surfaces (the pipeline retries; the org is reused next time)", async () => {
  const { db, tables } = fakeDb({ unique: UNIQUE, fail: { leads: "upsert" } });
  await assert.rejects(promote(db, row, person, false, B), /Could not create lead/);
  assert.equal(tables.organizations.length, 1);
});

test("P6. a search with no creator is refused before anything is written", async () => {
  const { db, tables } = fakeDb({ unique: UNIQUE });
  await assert.rejects(promote(db, row, person, false, { importId: null, createdBy: null }), /no creator/);
  assert.equal(tables.organizations.length, 0);
});
