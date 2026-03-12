import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const USER_ID = process.env.WISPRNOTE_USER_ID ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !USER_ID) {
  console.error(
    "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WISPRNOTE_USER_ID"
  );
  process.exit(1);
}

// Service role client bypasses RLS — we manually scope every query to USER_ID.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "wisprnote", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_meetings",
      description:
        "List all recorded meetings for the user, ordered newest first. Returns id, filename, summary, status, duration, and date.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of meetings to return (default 20, max 100).",
          },
        },
      },
    },
    {
      name: "get_meeting_details",
      description:
        "Get the full details of a single meeting including transcription, AI summary, and structured notes.",
      inputSchema: {
        type: "object",
        properties: {
          meeting_id: {
            type: "string",
            description: "The UUID of the meeting (from list_meetings).",
          },
        },
        required: ["meeting_id"],
      },
    },
    {
      name: "search_meetings",
      description:
        "Full-text search across all meeting transcriptions and summaries. Returns matching meetings with a snippet.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The keyword or phrase to search for.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10).",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_knowledge_graph",
      description:
        "Return the full knowledge graph data: all topics, decisions, people, and action items extracted from all meetings.",
      inputSchema: {
        type: "object",
        properties: {
          meeting_id: {
            type: "string",
            description:
              "Optional: filter to a single meeting's KG entry. Omit for all meetings.",
          },
        },
      },
    },
    {
      name: "get_meeting_assets",
      description:
        "Get AI-generated assets (email drafts, wiki pages, reports, presentations) for a specific meeting.",
      inputSchema: {
        type: "object",
        properties: {
          meeting_id: {
            type: "string",
            description: "The UUID of the meeting.",
          },
        },
        required: ["meeting_id"],
      },
    },
    {
      name: "get_action_items",
      description:
        "Get all action items across all meetings, or for a specific meeting. Useful for tracking tasks and owners.",
      inputSchema: {
        type: "object",
        properties: {
          meeting_id: {
            type: "string",
            description: "Optional: filter to a specific meeting. Omit for all meetings.",
          },
        },
      },
    },
    {
      name: "get_people",
      description:
        "Get all people mentioned across meetings and which meetings they appeared in.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// ─── Tool Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── list_meetings ──────────────────────────────────────────────────────
      case "list_meetings": {
        const limit = Math.min(Number(args?.limit ?? 20), 100);
        const { data, error } = await supabase
          .from("task_history")
          .select("id, filename, summary, status, duration, created_at, prompt")
          .eq("user_id", USER_ID)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) throw error;

        const formatted = (data ?? []).map((m: any) => ({
          id: m.id,
          filename: m.filename,
          date: m.created_at,
          duration_seconds: m.duration,
          status: m.status,
          summary: m.summary?.substring(0, 300) + (m.summary?.length > 300 ? "…" : ""),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      }

      // ── get_meeting_details ────────────────────────────────────────────────
      case "get_meeting_details": {
        const meetingId = String(args?.meeting_id ?? "");
        if (!meetingId) throw new Error("meeting_id is required");

        const { data, error } = await supabase
          .from("task_history")
          .select("*")
          .eq("id", meetingId)
          .eq("user_id", USER_ID)
          .single();

        if (error) throw error;
        if (!data) throw new Error("Meeting not found");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: data.id,
                  filename: data.filename,
                  date: data.created_at,
                  duration_seconds: data.duration,
                  prompt: data.prompt,
                  summary: data.summary,
                  notes: data.notes,
                  transcription: data.transcription,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ── search_meetings ────────────────────────────────────────────────────
      case "search_meetings": {
        const query = String(args?.query ?? "").toLowerCase().trim();
        if (!query) throw new Error("query is required");
        const limit = Math.min(Number(args?.limit ?? 10), 50);

        const { data, error } = await supabase
          .from("task_history")
          .select("id, filename, summary, transcription, created_at")
          .eq("user_id", USER_ID)
          .order("created_at", { ascending: false });

        if (error) throw error;

        const results = (data ?? [])
          .filter(
            (m: any) =>
              m.transcription?.toLowerCase().includes(query) ||
              m.summary?.toLowerCase().includes(query) ||
              m.filename?.toLowerCase().includes(query)
          )
          .slice(0, limit)
          .map((m: any) => {
            // Extract a snippet around the first match
            const text = (m.transcription ?? m.summary ?? "").toLowerCase();
            const idx = text.indexOf(query);
            const snippet =
              idx >= 0
                ? "…" +
                  (m.transcription ?? m.summary ?? "").substring(
                    Math.max(0, idx - 80),
                    idx + 200
                  ) +
                  "…"
                : m.summary?.substring(0, 200) ?? "";

            return {
              id: m.id,
              filename: m.filename,
              date: m.created_at,
              snippet,
            };
          });

        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? `No meetings found matching "${args?.query}".`
                  : JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      // ── get_knowledge_graph ────────────────────────────────────────────────
      case "get_knowledge_graph": {
        const meetingId = args?.meeting_id ? String(args.meeting_id) : null;

        let query = supabase
          .from("knowledge_graph")
          .select("*")
          .eq("user_id", USER_ID)
          .order("created_at", { ascending: false });

        if (meetingId) {
          query = query.eq("task_id", meetingId);
        }

        const { data, error } = await query;
        if (error) throw error;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data ?? [], null, 2),
            },
          ],
        };
      }

      // ── get_meeting_assets ─────────────────────────────────────────────────
      case "get_meeting_assets": {
        const meetingId = String(args?.meeting_id ?? "");
        if (!meetingId) throw new Error("meeting_id is required");

        const { data, error } = await supabase
          .from("generated_assets")
          .select("id, type, filename, created_at, content")
          .eq("task_id", meetingId)
          .eq("user_id", USER_ID)
          .order("created_at", { ascending: false });

        if (error) throw error;

        return {
          content: [
            {
              type: "text",
              text:
                (data ?? []).length === 0
                  ? "No assets generated for this meeting yet."
                  : JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      // ── get_action_items ──────────────────────────────────────────────────
      case "get_action_items": {
        const meetingId = args?.meeting_id ? String(args.meeting_id) : null;

        let query = supabase
          .from("knowledge_graph")
          .select("task_id, meeting_title, action_items")
          .eq("user_id", USER_ID);

        if (meetingId) {
          query = query.eq("task_id", meetingId);
        }

        const { data, error } = await query;
        if (error) throw error;

        const allItems = (data ?? []).flatMap((row: any) =>
          (row.action_items ?? []).map((item: any) => ({
            meeting_id: row.task_id,
            meeting_title: row.meeting_title,
            task: item.task,
            owner: item.owner,
            related_topic: item.relatedTopic,
          }))
        );

        return {
          content: [
            {
              type: "text",
              text:
                allItems.length === 0
                  ? "No action items found."
                  : JSON.stringify(allItems, null, 2),
            },
          ],
        };
      }

      // ── get_people ────────────────────────────────────────────────────────
      case "get_people": {
        const { data, error } = await supabase
          .from("knowledge_graph")
          .select("task_id, meeting_title, people")
          .eq("user_id", USER_ID);

        if (error) throw error;

        // Build a map: person → [meetings they appeared in]
        const personMap: Record<string, { meeting_id: string; meeting_title: string }[]> =
          {};

        for (const row of data ?? []) {
          for (const person of row.people ?? []) {
            if (!person) continue;
            if (!personMap[person]) personMap[person] = [];
            personMap[person].push({
              meeting_id: row.task_id,
              meeting_title: row.meeting_title,
            });
          }
        }

        const result = Object.entries(personMap)
          .sort((a, b) => b[1].length - a[1].length)
          .map(([name, meetings]) => ({ name, meetings }));

        return {
          content: [
            {
              type: "text",
              text:
                result.length === 0
                  ? "No people found in knowledge graph."
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.message ?? String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Wisprnote MCP server running on stdio");
