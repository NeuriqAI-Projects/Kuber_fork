/**
 * everyWhileVisible: browser polls skip hidden tabs and idle users, and catch up
 * once when the tab is shown or the user comes back.
 * Run: npx tsx --test lib/utils.test.mts
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";

mock.timers.enable({ apis: ["setInterval", "Date"] });
const listeners = new Map<string, Set<() => void>>();
const doc = {
  visibilityState: "visible",
  addEventListener: (type: string, f: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(f);
  },
  removeEventListener: (type: string, f: () => void) => listeners.get(type)?.delete(f),
};
(globalThis as { document?: unknown }).document = doc;
const fire = (type: string) => listeners.get(type)?.forEach((f) => f());
const show = (state: string) => { doc.visibilityState = state; fire("visibilitychange"); };

// Imported after the timers are mocked: the idle clock starts at the mocked "now".
const { everyWhileVisible, userIdle, IDLE_MS } = await import("./utils");

test("ticks only while visible, catches up once on show, stops cleanly", () => {
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
  assert.equal(listeners.get("visibilitychange")!.size, 1, "only the shared idle tracker stays");
});

test("an idle user stops the ticks; the first input runs one catch-up tick", () => {
  fire("pointermove");
  let calls = 0;
  const stop = everyWhileVisible(() => calls++, 60_000);
  mock.timers.tick(5 * 60_000);
  assert.equal(calls, 5, "one tick a minute while someone is around");
  assert.equal(userIdle(), false);

  mock.timers.tick(60 * 60_000);
  assert.equal(userIdle(), true);
  assert.equal(calls, 5, "an hour with no input: no ticks at all");

  fire("keydown");
  assert.equal(calls, 6, "input after the idle spell: one catch-up tick at once");
  fire("pointermove");
  assert.equal(calls, 6, "more input does not tick again");
  mock.timers.tick(60_000);
  assert.equal(calls, 7, "normal ticks again");

  // Input inside the idle window keeps it ticking (no catch-up storm).
  for (let i = 0; i < 10; i++) { mock.timers.tick(60_000); fire("wheel"); }
  assert.equal(calls, 17);
  stop();
});

test("a poll whose interval is longer than the idle window still catches up on return", () => {
  fire("pointerdown");
  let calls = 0;
  const stop = everyWhileVisible(() => calls++, 10 * 60_000);
  mock.timers.tick(30 * 60_000);
  assert.equal(calls, 0, "idle since 5 min in: the 10 and 20 min ticks are skipped");
  fire("touchstart");
  assert.equal(calls, 1, "caught up on return");
  stop();
});

test("showing the tab after an idle spell counts as activity", () => {
  fire("pointermove");
  let calls = 0;
  const stop = everyWhileVisible(() => calls++, 60_000);
  show("hidden");
  mock.timers.tick(IDLE_MS + 60_000);
  assert.equal(calls, 0);
  show("visible");
  assert.equal(calls, 1, "one tick when the tab is shown, though nobody moved the mouse yet");
  assert.equal(userIdle(), false);
  stop();
  mock.timers.reset();
});
