import { test } from "node:test";
import assert from "node:assert/strict";
import { followupDueAt, isDueForWriting } from "./followup-schedule.ts";

// PACKAGING GROUP 2 on 28 Sep 2026: opening sent Thu 24 Sep, gaps 3 then 2
// days, sending Monday to Friday, Mexico City time.
const opening = "2026-09-24T12:44:49Z";
const steps = [
  { step_order: 1, delay: 3, delay_unit: "days" },
  { step_order: 2, delay: 2, delay_unit: "days" },
  { step_order: 3, delay: 0, delay_unit: "days" },
];
const weekdays = { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false };
const schedule = { sendDays: weekdays, timezone: "America/Mexico_City" };
const day = (d: Date | null) => d?.toISOString().slice(0, 10);

test("a follow-up that lands on a day off moves to the next sending day", () => {
  assert.equal(day(followupDueAt(opening, steps, 2, schedule)), "2026-09-28"); // Sun 27 -> Mon 28
});

test("the next gap counts from the day the previous step really went", () => {
  assert.equal(day(followupDueAt(opening, steps, 3, schedule)), "2026-09-30"); // Mon 28 + 2 = Wed 30
});

test("follow-up 2 is not due for writing on the Monday follow-up 1 goes out", () => {
  const due = followupDueAt(opening, steps, 3, schedule);
  assert.equal(isDueForWriting(due, new Date("2026-09-28T09:37:00Z")), false);
});

test("without sending days the old calendar-day answer is unchanged", () => {
  assert.equal(day(followupDueAt(opening, steps, 2)), "2026-09-27");
  assert.equal(day(followupDueAt(opening, steps, 3)), "2026-09-29");
  const everyDay = { sendDays: { ...weekdays, saturday: true, sunday: true }, timezone: "America/Mexico_City" };
  assert.equal(day(followupDueAt(opening, steps, 2, everyDay)), "2026-09-27");
});
