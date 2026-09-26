import { test } from "node:test";
import assert from "node:assert/strict";
import { isMockCampaign } from "./llm-mock.ts";

const DEV = "00000000-0000-0000-0000-00000000000a";
const CLIENT = "00000000-0000-0000-0000-00000000000b";

test("fake AI only ever runs on [TEST] campaigns in the Dev workspace", () => {
  assert.equal(isMockCampaign(DEV, "[TEST] 1 · Ready to send"), true);
  assert.equal(isMockCampaign(DEV, "  [test] lowercase still counts"), true);
  // The client is never mocked, whatever the campaign is called.
  assert.equal(isMockCampaign(CLIENT, "[TEST] anything"), false);
  // A Dev campaign without the prefix uses the real AI.
  assert.equal(isMockCampaign(DEV, "PACKAGING GROUP 2"), false);
  assert.equal(isMockCampaign(DEV, "My [TEST] campaign"), false);
  assert.equal(isMockCampaign(null, "[TEST] x"), false);
});
