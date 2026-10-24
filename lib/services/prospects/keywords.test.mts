// npx tsx --test lib/services/prospects/keywords.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./fake-db.mts";
import { addKeyword, KEYWORDS_CHANGED, saveGroupsChecked } from "./keywords.ts";

const GROUPS = [
  { id: "g1", label: "Film", emoji: "", keywords: [{ id: "k1", label: "Blown film", query: "blown film" }] },
  { id: "g2", label: "Pipes", emoji: "", keywords: [{ id: "k2", label: "HDPE pipe", query: "pipe" }] },
];
function setup() {
  const f = fakeDb({ touch: ["settings"], unique: { settings: "key" } });
  f.tables.settings.push({ key: "industry_keyword_groups", value: JSON.stringify(GROUPS), updated_at: "t0" });
  const saved = () => JSON.parse(f.tables.settings[0].value as string) as typeof GROUPS;
  return { ...f, saved };
}

test("two adds at the same moment: both keywords are kept (the loser re-reads and retries)", async () => {
  const { db: raw, saved } = setup();
  // Counts the reads, to prove the two really overlapped (both read the old list, one had to retry).
  let reads = 0;
  const db = { from: (t: string) => { const q = (raw as { from: (t: string) => Record<string, unknown> }).from(t); const sel = q.select as (...a: unknown[]) => unknown; q.select = (...a: unknown[]) => { if (a[0] === "value, updated_at") reads++; return sel(...a); }; return q; } } as never;
  const [a, b] = await Promise.all([
    addKeyword(db, { groupId: "g1", label: "Cast film", query: "cast film" }),
    addKeyword(db, { groupId: "g1", label: "Stretch film", query: "stretch film" }),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal(reads, 3);
  assert.deepEqual(saved()[0].keywords.map((k) => k.label), ["Blown film", "Cast film", "Stretch film"]);
});

test("five adds into two groups at once: none lost", async () => {
  const { db, saved } = setup();
  const rs = await Promise.all(["a", "b", "c", "d", "e"].map((x, i) => addKeyword(db, { groupId: i % 2 ? "g2" : "g1", label: x, query: x }, 10)));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(saved().flatMap((g) => g.keywords).length, 7);
});

test("the same keyword added twice at once: one wins, the other is refused with the group's name", async () => {
  const { db, saved } = setup();
  const rs = await Promise.all([1, 2].map(() => addKeyword(db, { groupId: "g1", label: "Cast film", query: "cast film" })));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  const lost = rs.find((r) => !r.ok);
  assert.ok(lost && !lost.ok && lost.code === "DUPLICATE" && lost.message.includes("Film"));
  assert.equal(saved()[0].keywords.length, 2);
});

test("a duplicate in another group is refused and names that group; a removed group is refused", async () => {
  const { db } = setup();
  const r = await addKeyword(db, { groupId: "g1", label: "hdpe PIPE", query: "pipe" });
  assert.ok(!r.ok && r.code === "DUPLICATE" && r.message.includes("Pipes"));
  const g = await addKeyword(db, { groupId: "gone", label: "x", query: "x" });
  assert.ok(!g.ok && g.code === "NO_GROUP");
});

test("no settings row yet (built-in groups): the first add inserts it", async () => {
  const { db, tables } = fakeDb({ touch: ["settings"], unique: { settings: "key" } });
  const r = await addKeyword(db, { groupId: "specialty", label: "Colour concentrate", query: "colour concentrate" });
  assert.ok(r.ok);
  assert.equal(tables.settings.length, 1);
  assert.ok((tables.settings[0].value as string).includes("Colour concentrate"));
});

test("Settings save: refused when someone changed the list since it was loaded, saved when not", async () => {
  const { db, saved } = setup();
  const base = JSON.stringify(GROUPS);
  await addKeyword(db, { groupId: "g1", label: "Cast film", query: "cast film" }); // a teammate, meanwhile
  const stale = JSON.stringify([GROUPS[0]]);
  assert.deepEqual(await saveGroupsChecked(db, stale, base), { ok: false, message: KEYWORDS_CHANGED });
  assert.equal(saved()[0].keywords.length, 2); // the teammate's keyword survived
  const fresh = JSON.stringify(saved());
  assert.deepEqual(await saveGroupsChecked(db, stale, fresh), { ok: true });
  assert.equal(saved().length, 1);
});

test("Settings save: two saves from the same base at once, only one lands", async () => {
  const { db } = setup();
  const base = JSON.stringify(GROUPS);
  const rs = await Promise.all([saveGroupsChecked(db, JSON.stringify([GROUPS[0]]), base), saveGroupsChecked(db, JSON.stringify([GROUPS[1]]), base)]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
});
