import { assertEquals } from "jsr:@std/assert";
import { createClient } from "@supabase/supabase-js";

const BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1/open-brain-mcp`;
const VALID_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
const WRONG_KEY = "wrong-key";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TEST_CONTENT = "__endpoint_test__ ignore this thought";

// --- GET /health ---

Deno.test("health: valid key returns 200", async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { "x-brain-key": VALID_KEY },
  });
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.ok, true);
});

Deno.test("health: wrong key returns 401", async () => {
  const res = await fetch(`${BASE}/health`, {
    headers: { "x-brain-key": WRONG_KEY },
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("health: missing key returns 401", async () => {
  const res = await fetch(`${BASE}/health`);
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

// --- POST /capture ---

Deno.test("capture: wrong key returns 401", async () => {
  const res = await fetch(`${BASE}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": WRONG_KEY },
    body: JSON.stringify({ content: "test" }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("capture: valid key with real content returns 200", async () => {
  const res = await fetch(`${BASE}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": VALID_KEY },
    body: JSON.stringify({ content: TEST_CONTENT }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 200);

  // Cleanup
  await supabase.from("thoughts").delete().eq("content", TEST_CONTENT);
});

Deno.test("capture: valid key with empty content returns 400", async () => {
  const res = await fetch(`${BASE}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": VALID_KEY },
    body: JSON.stringify({ content: "" }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 400);
});
