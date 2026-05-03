export type ThoughtRow = { metadata: Record<string, unknown> };

export function isValidKey(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function aggregateMetadata(rows: ThoughtRow[]): {
  types: Record<string, number>;
  topics: Record<string, number>;
  people: Record<string, number>;
} {
  const types: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const people: Record<string, number> = {};

  for (const r of rows) {
    const m = r.metadata || {};
    if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
    if (Array.isArray(m.topics))
      for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
    if (Array.isArray(m.people))
      for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
  }

  return { types, topics, people };
}

export function sortTop10(o: Record<string, number>): [string, number][] {
  return Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}
