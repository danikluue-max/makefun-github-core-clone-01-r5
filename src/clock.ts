// Deterministic clock: every timestamp handed out during a trial comes
// from here, so a replay produces byte-identical state. Both accessors
// share one counter — each call to nextIso() or nextStampSec() advances
// it by exactly one second of trial time.

const FALLBACK_EPOCH = Date.parse('2025-01-01T00:00:00Z');

function resolveBase(raw: string | undefined): number {
  if (raw === undefined) return FALLBACK_EPOCH;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : FALLBACK_EPOCH;
}

export class DeterministicClock {
  readonly base: number;
  private tick = 0;
  private readonly rendered: string[] = [];

  constructor(now: string | undefined = process.env.MAKEFUN_TRIAL_NOW) {
    this.base = resolveBase(now);
  }

  nextIso(): string {
    this.tick += 1;
    const cached = this.rendered[this.tick];
    if (cached !== undefined) return cached;
    const text = new Date(this.base + this.tick * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    this.rendered[this.tick] = text;
    return text;
  }

  nextStampSec(): number {
    this.tick += 1;
    return Math.floor(this.base / 1000) + this.tick;
  }

  get sequence(): number {
    return this.tick;
  }
}
