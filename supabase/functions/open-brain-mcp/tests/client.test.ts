import { assert, assertEquals } from "jsr:@std/assert";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TEST_MARKER = `__integration_test__${Date.now()}`;

Deno.test("insert thought: round-trips content and cleans up", async () => {
  // Insert
  const { data: inserted, error: insertError } = await supabase
    .from("thoughts")
    .insert([{ content: TEST_MARKER, metadata: { source: "test-suite" } }])
    .select("id, content, metadata");

  assertEquals(insertError, null);
  assert(inserted && inserted.length === 1, "expected exactly one inserted row");
  assertEquals(inserted[0].content, TEST_MARKER);
  assertEquals(inserted[0].metadata.source, "test-suite");

  const id = inserted[0].id;

  // Cleanup
  const { error: deleteError } = await supabase
    .from("thoughts")
    .delete()
    .eq("id", id);

  assertEquals(deleteError, null);
});
