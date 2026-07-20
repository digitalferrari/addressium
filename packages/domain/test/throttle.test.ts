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

test("planFanOut splits a total into offset/limit windows", () => {
  assert.deepEqual(planFanOut(5, 2), [
    { offset: 0, limit: 2 },
    { offset: 2, limit: 2 },
    { offset: 4, limit: 1 },
  ]);
  assert.deepEqual(planFanOut(0, 2), []);
  assert.deepEqual(planFanOut(2, 5), [{ offset: 0, limit: 2 }]);
});
