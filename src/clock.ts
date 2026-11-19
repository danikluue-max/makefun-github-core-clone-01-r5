export class DeterministicClock {
  readonly base: number;
  private seq = 0;
  private readonly isoCache = new Map<number, string>();

  constructor(now = process.env.MAKEFUN_TRIAL_NOW) {
    const parsed = now === undefined ? Number.NaN : Date.parse(now);
    this.base = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00Z');
  }

  nextIso(): string {
    const seq = ++this.seq;
    let value = this.isoCache.get(seq);
    if (value === undefined) {
      value = new Date(this.base + seq * 1000).toISOString().replace('.000Z', 'Z');
      this.isoCache.set(seq, value);
    }
    return value;
  }

  nextStampSec(): number {
    return Math.floor(this.base / 1000) + ++this.seq;
  }

  get sequence(): number {
    return this.seq;
  }
}
