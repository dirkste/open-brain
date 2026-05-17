import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { aggregateMetadata, isValidKey, sortTop10 } from "./_lib.ts";

const VERSION = "1.0.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note", "coding_project"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          t: {
            content: string;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toISOString().slice(0, 10)}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Ask Brain (conversational synthesis)
server.registerTool(
  "ask_brain",
  {
    title: "Ask Your Brain",
    description:
      "Answer a question conversationally using the user's captured thoughts. Unlike search_thoughts which returns raw entries, this tool synthesizes a natural language answer. Use it when the user asks a question expecting a response, not a list of records.",
    inputSchema: {
      question: z.string().min(1).max(2000).describe("The question to answer"),
      limit: z.number().int().min(1).max(15).optional().default(8),
    },
  },
  async ({ question, limit }) => {
    try {
      const qEmb = await getEmbedding(question);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: 0.3,
        match_count: limit,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      let thoughts = data ?? [];

      if (!thoughts.length) {
        const { data: recent, error: recentErr } = await supabase
          .from("thoughts")
          .select("content, metadata, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (recentErr) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${recentErr.message}` }],
            isError: true,
          };
        }
        thoughts = recent ?? [];
      }

      if (!thoughts.length) {
        return {
          content: [{ type: "text" as const, text: "You haven't captured any thoughts yet." }],
        };
      }

      const context = thoughts
        .map((t: { content: string; metadata: Record<string, unknown>; created_at: string }) => {
          const m = t.metadata || {};
          const tags = [
            m.type ? `Type: ${m.type}` : null,
            Array.isArray(m.topics) && m.topics.length
              ? `Topics: ${(m.topics as string[]).join(", ")}`
              : null,
            `Captured: ${new Date(t.created_at).toISOString().slice(0, 10)}`,
          ]
            .filter(Boolean)
            .join(" | ");
          const body = t.content.length > 1000 ? t.content.slice(0, 1000) + "…" : t.content;
          return `[${tags}]\n${body}`;
        })
        .join("\n\n");

      const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a personal knowledge assistant with access to the user's captured thoughts, notes, and ideas.
Answer the user's question conversationally using only the provided thoughts.
Synthesize naturally — don't just list entries. Note dates or patterns where relevant.
If the thoughts don't fully answer the question, say so honestly.`,
            },
            {
              role: "user",
              content: `Question: ${question}\n\nRelevant thoughts:\n\n${context}`,
            },
          ],
        }),
      });

      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`OpenRouter chat failed: ${r.status} ${msg}`);
      }

      const d = await r.json();
      const answer = d.choices?.[0]?.message?.content ?? "Could not generate an answer.";
      return { content: [{ type: "text" as const, text: answer }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note, coding_project"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

      const { types, topics, people } = aggregateMetadata(data || []);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sortTop10(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sortTop10(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sortTop10(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: { ...metadata, source: "mcp" },
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-brain-key"],
}));

app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const provided = c.req.header("x-brain-key");

  if (!isValidKey(provided, MCP_ACCESS_KEY)) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  // REST endpoint: POST …/capture
  if (c.req.method === "POST" && url.pathname.endsWith("/capture")) {
    let content: string;
    try {
      ({ content } = await c.req.json());
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    if (content.length > 10000) {
      return c.json({ error: "content too long (max 10000 characters)" }, 413);
    }

    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: { ...metadata, source: "web" },
      });

      if (error) return c.json({ error: error.message }, 500);

      return c.json({ ok: true, metadata });
    } catch (err: unknown) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  // REST endpoint: POST …/search
  if (c.req.method === "POST" && url.pathname.endsWith("/search")) {
    let query: string;
    let limit = 10;
    try {
      ({ query, limit = 10 } = await c.req.json());
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!query?.trim()) {
      return c.json({ error: "query is required" }, 400);
    }

    if (query.length > 500) {
      return c.json({ error: "query too long (max 500 characters)" }, 413);
    }

    const safeLimit = Math.min(Math.max(1, Math.trunc(Number(limit)) || 10), 20);

    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: 0.3,
        match_count: safeLimit,
        filter: {},
      });

      if (error) return c.json({ error: error.message }, 500);
      return c.json({ ok: true, results: data || [] });
    } catch (err: unknown) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  // REST endpoint: POST …/ask
  if (c.req.method === "POST" && url.pathname.endsWith("/ask")) {
    let question: string;
    let limit = 8;
    try {
      ({ question, limit = 8 } = await c.req.json());
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!question?.trim()) {
      return c.json({ error: "question is required" }, 400);
    }

    if (question.length > 2000) {
      return c.json({ error: "question too long (max 2000 characters)" }, 413);
    }

    const safeLimit = Math.min(Math.max(1, Math.trunc(Number(limit)) || 8), 15);

    try {
      const qEmb = await getEmbedding(question);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: 0.3,
        match_count: safeLimit,
        filter: {},
      });

      if (error) return c.json({ error: error.message }, 500);

      let thoughts = data ?? [];

      if (!thoughts.length) {
        const { data: recent, error: recentErr } = await supabase
          .from("thoughts")
          .select("content, metadata, created_at")
          .order("created_at", { ascending: false })
          .limit(safeLimit);
        if (recentErr) return c.json({ error: recentErr.message }, 500);
        thoughts = recent ?? [];
      }

      if (!thoughts.length) {
        return c.json({ ok: true, answer: "You haven't captured any thoughts yet." });
      }

      const context = thoughts
        .map((t: { content: string; metadata: Record<string, unknown>; created_at: string }) => {
          const m = t.metadata || {};
          const tags = [
            m.type ? `Type: ${m.type}` : null,
            Array.isArray(m.topics) && m.topics.length
              ? `Topics: ${(m.topics as string[]).join(", ")}`
              : null,
            `Captured: ${new Date(t.created_at).toISOString().slice(0, 10)}`,
          ]
            .filter(Boolean)
            .join(" | ");
          const body = t.content.length > 1000 ? t.content.slice(0, 1000) + "…" : t.content;
          return `[${tags}]\n${body}`;
        })
        .join("\n\n");

      const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a personal knowledge assistant with access to the user's captured thoughts, notes, and ideas.
Answer the user's question conversationally using only the provided thoughts.
Synthesize naturally — don't just list entries. Note dates or patterns where relevant.
If the thoughts don't fully answer the question, say so honestly.`,
            },
            {
              role: "user",
              content: `Question: ${question}\n\nRelevant thoughts:\n\n${context}`,
            },
          ],
        }),
      });

      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`OpenRouter chat failed: ${r.status} ${msg}`);
      }

      const d = await r.json();
      const answer = d.choices?.[0]?.message?.content ?? "Could not generate an answer.";
      return c.json({ ok: true, answer });
    } catch (err: unknown) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  // Health check — used by web client to validate key
  if (c.req.method === "GET" && url.pathname.endsWith("/health")) {
    return c.json({ ok: true, version: VERSION });
  }

  // MCP transport
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
