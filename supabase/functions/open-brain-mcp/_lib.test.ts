import { assertEquals } from "jsr:@std/assert";
import { aggregateMetadata, isValidKey, sortTop10 } from "./_lib.ts";

// --- isValidKey ---

Deno.test("isValidKey: null key is rejected", () => {
  assertEquals(isValidKey(null, "secret"), false);
});

Deno.test("isValidKey: undefined key is rejected", () => {
  assertEquals(isValidKey(undefined, "secret"), false);
});

Deno.test("isValidKey: empty string is rejected", () => {
  assertEquals(isValidKey("", "secret"), false);
});

Deno.test("isValidKey: wrong key is rejected", () => {
  assertEquals(isValidKey("wrong", "secret"), false);
});

Deno.test("isValidKey: correct key is accepted", () => {
  assertEquals(isValidKey("secret", "secret"), true);
});

// --- aggregateMetadata ---

Deno.test("aggregateMetadata: empty rows yields empty tallies", () => {
  assertEquals(aggregateMetadata([]), { types: {}, topics: {}, people: {} });
});

Deno.test("aggregateMetadata: counts thought types", () => {
  const rows = [
    { metadata: { type: "idea" } },
    { metadata: { type: "task" } },
    { metadata: { type: "idea" } },
  ];
  const { types } = aggregateMetadata(rows);
  assertEquals(types, { idea: 2, task: 1 });
});

Deno.test("aggregateMetadata: accumulates topics across rows", () => {
  const rows = [
    { metadata: { topics: ["ai", "work"] } },
    { metadata: { topics: ["ai"] } },
  ];
  const { topics } = aggregateMetadata(rows);
  assertEquals(topics, { ai: 2, work: 1 });
});

Deno.test("aggregateMetadata: accumulates people across rows", () => {
  const rows = [
    { metadata: { people: ["Alice", "Bob"] } },
    { metadata: { people: ["Alice"] } },
  ];
  const { people } = aggregateMetadata(rows);
  assertEquals(people, { Alice: 2, Bob: 1 });
});

Deno.test("aggregateMetadata: non-array topics field is ignored", () => {
  // deno-lint-ignore no-explicit-any
  const rows = [{ metadata: { topics: "not-an-array" as any } }];
  const { topics } = aggregateMetadata(rows);
  assertEquals(topics, {});
});

Deno.test("aggregateMetadata: missing metadata fields are skipped", () => {
  assertEquals(aggregateMetadata([{ metadata: {} }]), { types: {}, topics: {}, people: {} });
});

// --- sortTop10 ---

Deno.test("sortTop10: sorts descending by count", () => {
  assertEquals(sortTop10({ a: 1, b: 3, c: 2 }), [["b", 3], ["c", 2], ["a", 1]]);
});

Deno.test("sortTop10: caps at 10 entries", () => {
  const input: Record<string, number> = {};
  for (let i = 0; i < 15; i++) input[`k${i}`] = i;
  assertEquals(sortTop10(input).length, 10);
});

Deno.test("sortTop10: top entry is the highest-count item when capped", () => {
  const input: Record<string, number> = {};
  for (let i = 0; i < 15; i++) input[`k${i}`] = i;
  assertEquals(sortTop10(input)[0], ["k14", 14]);
});

Deno.test("sortTop10: empty object returns empty array", () => {
  assertEquals(sortTop10({}), []);
});
