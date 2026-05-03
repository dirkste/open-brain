import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

export async function addThought(content: string, metadata: object = {}) {
  const { data, error } = await supabase
    .from('thoughts')
    .insert([{ content, metadata }])
    .select();
  if (error) throw error;
  return data;
}