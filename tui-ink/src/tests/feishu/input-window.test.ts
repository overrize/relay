import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeishuInputWindowManager } from "../../feishu/input-window.js";



// All tests use a tiny windowMs so the suite completes in < 1s.
const WIN = 60; // ms

describe("FeishuInputWindowManager", () => {
  it("3 fragments within window → 1 flush, merged text, anchor = first messageId", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: Array<{ openId: string; text: string; anchor: string }> = [];
    const mgr = new FeishuInputWindowManager(WIN, (oid, t, a) => calls.push({ openId: oid, text: t, anchor: a }));

    mgr.feed("user1", "first", "msg-1", "chat1", "p2p");
    t.mock.timers.tick(20);
    mgr.feed("user1", "second", "msg-2", "chat1", "p2p");
    t.mock.timers.tick(20);
    mgr.feed("user1", "third", "msg-3", "chat1", "p2p");
    // silence starts now — wait past window
    t.mock.timers.tick(WIN + 20);

    assert.equal(calls.length, 1, "should produce exactly 1 flush");
    assert.equal(calls[0]!.text, "first\nsecond\nthird");
    assert.equal(calls[0]!.anchor, "msg-1", "anchor must be first fragment messageId");
    assert.equal(calls[0]!.openId, "user1");
  });

  it("single message → 1 normal flush after window, no side effects", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: string[] = [];
    const mgr = new FeishuInputWindowManager(WIN, (_, t) => calls.push(t));

    mgr.feed("user1", "hello", "msg-1", "chat1", "p2p");
    assert.equal(mgr.openCount(), 1, "window should be open");
    t.mock.timers.tick(WIN + 20);

    assert.equal(calls.length, 1);
    assert.equal(calls[0], "hello");
    assert.equal(mgr.openCount(), 0, "window should be closed after flush");
  });

  it("clear during window → timer cancelled, no dispatch", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: string[] = [];
    const mgr = new FeishuInputWindowManager(WIN, (_, t) => calls.push(t));

    mgr.feed("user1", "hello", "msg-1", "chat1", "p2p");
    assert.equal(mgr.openCount(), 1);
    mgr.clear("user1");
    assert.equal(mgr.openCount(), 0, "window removed after clear");
    t.mock.timers.tick(WIN + 20);

    assert.equal(calls.length, 0, "no flush after clear");
  });

  it("timer resets on each new fragment — early-arriving observer sees no flush mid-stream", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: string[] = [];
    const mgr = new FeishuInputWindowManager(WIN, (_, t) => calls.push(t));

    mgr.feed("user1", "A", "msg-1", "chat1", "p2p");
    t.mock.timers.tick(WIN - 20); // partial wait, no flush yet
    mgr.feed("user1", "B", "msg-2", "chat1", "p2p"); // resets timer
    t.mock.timers.tick(WIN - 20); // still within reset window
    assert.equal(calls.length, 0, "no flush before window expires after last fragment");
    t.mock.timers.tick(40); // now past reset window
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "A\nB");
  });

  it("independent users have independent windows", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: Array<{ openId: string; text: string }> = [];
    const mgr = new FeishuInputWindowManager(WIN, (oid, t) => calls.push({ openId: oid, text: t }));

    mgr.feed("user1", "from 1", "msg-1", "chat1", "p2p");
    mgr.feed("user2", "from 2", "msg-2", "chat2", "p2p");
    assert.equal(mgr.openCount(), 2);
    t.mock.timers.tick(WIN + 20);

    assert.equal(calls.length, 2);
    const u1 = calls.find(c => c.openId === "user1")!;
    const u2 = calls.find(c => c.openId === "user2")!;
    assert.equal(u1.text, "from 1");
    assert.equal(u2.text, "from 2");
  });

  it("explicit flush() dispatches immediately without waiting for timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: string[] = [];
    const mgr = new FeishuInputWindowManager(WIN, (_, t) => calls.push(t));

    mgr.feed("user1", "urgent", "msg-1", "chat1", "p2p");
    mgr.flush("user1"); // force-flush before timer fires
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "urgent");
    assert.equal(mgr.openCount(), 0);
    // timer should be a no-op now (window already deleted)
    t.mock.timers.tick(WIN + 20);
    assert.equal(calls.length, 1, "no double-flush after explicit flush");
  });
});
