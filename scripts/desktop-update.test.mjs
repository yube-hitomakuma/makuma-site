import test from "node:test";
import assert from "node:assert/strict";
import { reviewAndPublish } from "./desktop-update.mjs";

for (const choice of ["公開", "修正", "公開\n", "修正\n"]) {
  test(`preview precedes choice: ${choice}`, async () => {
    const events = [];
    await reviewAndPublish({
      preview: async () => events.push("preview"),
      choose: async () => { events.push("choose"); return choice; },
      publish: async () => events.push("publish"),
      revise: async () => events.push("revise"),
    });
    assert.deepEqual(events, ["preview", "choose", ...(choice.trim() === "公開" ? ["publish"] : ["revise"])]);
  });
}
test("unknown choice is an error rather than silent success", async () => {
  await assert.rejects(reviewAndPublish({preview:async()=>{}, choose:async()=>undefined}));
});
test("failed preview never requests or performs publication", async () => {
  await assert.rejects(reviewAndPublish({
    preview: async () => { throw Error("preview unavailable"); },
    choose: async () => assert.fail("must not ask"),
    publish: async () => assert.fail("must not publish"),
  }));
});
