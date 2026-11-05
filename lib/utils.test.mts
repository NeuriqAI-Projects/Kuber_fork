/**
 * everyWhileVisible: browser polls skip hidden tabs and catch up when shown.
 * Run: npx tsx --test lib/utils.test.mts
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { everyWhileVisible } from "./utils";

test("ticks only while visible, catches up once on show, stops cleanly", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  };
  (globalThis as { document?: unknown }).document = doc;
  const show = (state: string) => { doc.visibilityState = state; listeners.forEach((f) => f()); };

  let calls = 0;
  const stop = everyWhileVisible(() => calls++, 1000);
  mock.timers.tick(1000);
  assert.equal(calls, 1);

  show("hidden");
  mock.timers.tick(5000);
  assert.equal(calls, 1, "no polling while hidden");

  show("visible");
  assert.equal(calls, 2, "one catch-up call when the tab comes back");
  show("visible");
  assert.equal(calls, 2, "no second catch-up right away");

  stop();
  mock.timers.tick(5000);
  assert.equal(calls, 2, "stopped");
  assert.equal(listeners.size, 0, "listener removed");
  mock.timers.reset();
});
