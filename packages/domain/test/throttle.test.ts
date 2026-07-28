/**
 * Token-bucket throttle: bursts up to capacity immediately, then paces to the
 * refill rate; and fan-out slicing splits a large list into offset/limit windows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, planFanOut, type Sleeper } from "@addressium/domain";

/** A fake clock the test advances manually. */
class FakeClock {
  constructor(public ms = 0) {}
  now() {
    return new Date(this.ms);
  }
}

/** A sleeper that advances the fake clock instead of waiting on real time. */
class FakeSleeper implements Sleeper {
  public slept: number[] = [];
  constructor(private clock: FakeClock) {}
  async sleep(ms: number) {
    this.slept.push(ms);
    this.clock.ms += ms;
  }
}

test("bucket lets a burst through up to capacity without sleeping", async () => {
  const clock = new FakeClock();
  const sleeper = new FakeSleeper(clock);
  const bucket = new TokenBucket(10, 5, clock, sleeper);
  for (let i = 0; i < 5; i++) await bucket.acquire();
  assert.equal(sleeper.slept.length, 0); // 5 tokens available immediately
});

test("bucket paces the 6th token to the refill rate", async () => {
  const clock = new FakeClock();
  const sleeper = new FakeSleeper(clock);
  const bucket = new TokenBucket(10, 5, clock, sleeper); // 10/sec → 100ms/token
  for (let i = 0; i < 5; i++) await bucket.acquire();
  await bucket.acquire(); // must wait ~100ms for one token
  assert.equal(sleeper.slept.length, 1);
  assert.ok(sleeper.slept[0]! >= 100);
});

test("planFanOut splits ordered ids into key-range windows (#171)", () => {
  // Boundaries are IDS, not counts. The last window is open-ended so a
  // confirmation that lands after the plan is made is still picked up.
  assert.deepEqual(planFanOut(["a", "b", "c", "d", "e"], 2), [
    { until: "b" },
    { after: "b", until: "d" },
    { after: "d" },
  ]);
  assert.deepEqual(planFanOut([], 2), []);
  assert.deepEqual(planFanOut(["a", "b"], 5), [{}], "one open-ended window covers everything");
});
