const MASK = 0xffffffffffffffffn;
const SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

class Rng {
  private state: bigint;
  constructor(seed: bigint) { this.state = (seed & MASK) || SEED; }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  nextInt(max: number): number {
    const range = 0x1_0000_0000;
    const limit = range - range % max;
    for (;;) {
      const value = Number(this.nextU64() >> 32n);
      if (value < limit) return value % max;
    }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)] as T; }
}

const FIRST = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'] as const;
const LAST = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'] as const;

export interface ScenarioUser { id: number; login: string; name: string; email: string }

const rng = new Rng(mix64(SEED ^ fnv1a64('users')));
const used = new Set<string>();
const users: ScenarioUser[] = [];
for (let i = 0; i < 3; i += 1) {
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  let login = base;
  let suffix = 2;
  while (used.has(login)) login = `${base}-${suffix++}`;
  used.add(login);
  users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
}

export const VIEWER = users[0] as ScenarioUser;
export const TEAMMATE = users[1] as ScenarioUser;
export const STRANGER = users[2] as ScenarioUser;
/** Lowercased viewer login, computed once: the router compares it per request. */
export const VIEWER_LOGIN_LOWER = VIEWER.login.toLowerCase();
