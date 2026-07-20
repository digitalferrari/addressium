/**
 * Token-bucket rate limiter for SES send throttling (§4.4, #9).
 *
 * SES enforces a per-account (and effectively per-org via config set) max send
 * rate. The bucket refills `ratePerSec` tokens/second up to `capacity`;
 * `acquire` waits only as long as needed for the next token. Time + sleeping
 * are injected so the limiter is deterministic under test.
 */
import type { Clock, SendThrottle } from "./ports.js";

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export class RealSleeper implements Sleeper {
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class TokenBucket implements SendThrottle {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
    private readonly clock: Clock,
    private readonly sleeper: Sleeper = new RealSleeper(),
  ) {
    if (ratePerSec <= 0) throw new Error("ratePerSec must be > 0");
    this.tokens = capacity;
    this.lastRefillMs = clock.now().getTime();
  }

  private refill(): void {
    const now = this.clock.now().getTime();
    const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillMs = now;
  }

  async acquire(n = 1): Promise<void> {
    if (n > this.capacity) throw new Error("requested tokens exceed bucket capacity");
    this.refill();
    while (this.tokens < n) {
      const deficit = n - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      await this.sleeper.sleep(waitMs);
      this.refill();
    }
    this.tokens -= n;
  }
}
