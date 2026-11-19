// Seeded scenario users. The three accounts are derived deterministically
// from a fixed seed, so every trial sees the same viewer, teammate and
// stranger — and therefore the same state.json bytes.

const MASK = 0xffffffffffffffffn;
const SEED = 0x6a09e667f3bcc909n;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function hashText(input: string): bigint {
  let acc = FNV_OFFSET;
  let at = 0;
  while (at < input.length) {
    acc = (acc ^ BigInt(input.charCodeAt(at))) * FNV_PRIME;
    acc = acc & MASK;
    at += 1;
  }
  return acc;
}

function scramble(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

interface Dice {
  nextU64(): bigint;
  nextInt(max: number): number;
  pick<T>(items: readonly T[]): T;
}

function makeDice(seed: bigint): Dice {
  let state = (seed & MASK) || SEED;

  const nextU64 = (): bigint => {
    let x = state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  };

  const nextInt = (max: number): number => {
    const range = 0x1_0000_0000;
    const limit = range - (range % max);
    for (;;) {
      const drawn = Number(nextU64() >> 32n);
      if (drawn < limit) return drawn % max;
    }
  };

  return {
    nextU64,
    nextInt,
    pick<T>(items: readonly T[]): T {
      return items[nextInt(items.length)] as T;
    },
  };
}

const FIRST = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'] as const;
const LAST = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'] as const;

export interface ScenarioUser { id: number; login: string; name: string; email: string }

function slugifyName(first: string, last: string): string {
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

function buildUsers(): ScenarioUser[] {
  const dice = makeDice(scramble(SEED ^ hashText('users')));
  const taken = new Set<string>();
  const made: ScenarioUser[] = [];
  for (let i = 0; i < 3; i += 1) {
    const first = dice.pick(FIRST);
    const last = dice.pick(LAST);
    const stem = slugifyName(first, last);
    let login = stem;
    let attempt = 2;
    while (taken.has(login)) {
      login = `${stem}-${attempt}`;
      attempt += 1;
    }
    taken.add(login);
    made.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return made;
}

const users = buildUsers();

export const VIEWER = users[0] as ScenarioUser;
export const TEAMMATE = users[1] as ScenarioUser;
export const STRANGER = users[2] as ScenarioUser;
/** Lowercased viewer login, computed once: the router compares it per request. */
export const VIEWER_LOGIN_LOWER = VIEWER.login.toLowerCase();
