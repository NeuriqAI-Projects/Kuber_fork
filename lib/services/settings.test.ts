/**
 * Self-check for the follow-up fallback template — the text seeded into every
 * lead's customBodyN at fan-out time so a follow-up never sends blank when no
 * personalized draft exists yet (AI/credit outage, or simply not written
 * before it's due). Run with:
 *   npx tsx lib/services/settings.test.ts
 */
import { strict as assert } from "assert";
import { getFollowupFallbackTemplate, renderFollowupFallback } from "./settings";
import { hasVisibleText } from "../utils/email-html";

// ── renderFollowupFallback: placeholder substitution ──────────────────────────

// Basic fill.
assert.equal(
  renderFollowupFallback("Hi {{first_name}}, checking in.", "Ben"),
  "Hi Ben, checking in.",
);

// Case- and whitespace-insensitive, since a manager typing the placeholder by
// hand is more likely to get spacing/casing wrong than the exact token.
assert.equal(
  renderFollowupFallback("Hi {{ First_Name }}!", "Ben"),
  "Hi Ben!",
);

// Every occurrence, not just the first.
assert.equal(
  renderFollowupFallback("{{first_name}}, hi {{first_name}}", "Ben"),
  "Ben, hi Ben",
);

// No placeholder at all — template passes through untouched. A manager who
// writes a fixed, non-personalized fallback must not have text injected into it.
assert.equal(
  renderFollowupFallback("Just checking in — any thoughts?", "Ben"),
  "Just checking in — any thoughts?",
);

// Empty/missing first name still reads as a sentence, not "Hi ,".
assert.equal(renderFollowupFallback("Hi {{first_name}},", ""), "Hi there,");

// Company and last name are filled too - an AI-off campaign sends this text to everyone.
assert.equal(
  renderFollowupFallback("Hi {{name}}, any update from {{ Company }}, {{first_name}} {{last_name}}?", "Ben", "Acme Films", "Ray"),
  "Hi Ben, any update from Acme Films, Ben Ray?",
);
assert.equal(renderFollowupFallback("Is {{company}} still sourcing?", "Ben", null), "Is your company still sourcing?");
// A stored name with a trailing space must not produce "Hi Devyansh ,".
assert.equal(renderFollowupFallback("Hi {{first_name}},", "Devyansh "), "Hi Devyansh,");
// The AI path tidies the name before the prompt sees it; the template path has
// to do the same, or a switched-off campaign sends "Hi heena," (Dev, 18 Sep).
assert.equal(renderFollowupFallback("Hi {{first_name}},", "heena"), "Hi Heena,");
assert.equal(
  renderFollowupFallback("Hi {{first_name}} {{last_name}},", "RAJESH", null, "KUMAR"),
  "Hi Rajesh Kumar,",
);
// Deliberate mixed-case spellings stay untouched.
assert.equal(renderFollowupFallback("Hi {{first_name}},", "McDonald"), "Hi McDonald,");

// ── getFollowupFallbackTemplate: company default when unset ──────────────────

// A minimal fake matching only the .from().select().eq().maybeSingle() chain
// this function actually calls — not a full Supabase client.
function fakeDb(row: { value: string } | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof getFollowupFallbackTemplate>[0];
}

void (async function testDefaults() {
  // No row at all (never customized) → falls back to the built-in default,
  // never an empty string (which would seed Instantly's merge tag blank).
  const unset = await getFollowupFallbackTemplate(fakeDb(null));
  assert.ok(unset.length > 0, "must never resolve to an empty template");
  assert.match(unset, /\{\{\s*first_name\s*\}\}/i, "built-in default must carry the placeholder");

  // A row with only whitespace is treated the same as unset — an admin who
  // saved a blank field by mistake must not zero out every future follow-up.
  const blank = await getFollowupFallbackTemplate(fakeDb({ value: "   " }));
  assert.equal(blank, unset);

  // A real customization is used verbatim.
  const custom = await getFollowupFallbackTemplate(fakeDb({ value: "Bumping this up, {{first_name}}." }));
  assert.equal(custom, "Bumping this up, {{first_name}}.");

  console.log("settings: all follow-up fallback checks passed");
})();

// ── hasVisibleText: an emptied editor box must read as "not set" ──────────────
// "<p></p>" is truthy, so .trim() checks treated an empty box as real text; in
// the follow-up ladder that beat the company default and produced a blank email.
assert.equal(hasVisibleText("<p></p>"), false);
assert.equal(hasVisibleText("<p><br></p>"), false);
assert.equal(hasVisibleText("<p>&nbsp;</p>"), false);
assert.equal(hasVisibleText("   "), false);
assert.equal(hasVisibleText(null), false);
assert.equal(hasVisibleText(undefined), false);
assert.equal(hasVisibleText("<p>Hi {{first_name}}</p>"), true);
assert.equal(hasVisibleText("<p><strong>Masterbatches</strong></p>"), true);

console.log("settings: hasVisibleText checks passed");
