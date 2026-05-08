import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

// ─── Config ──────────────────────────────────────────────────────────────────

const DB_HOST = process.env.DB_HOST ?? "";
const DB_PORT = parseInt(process.env.DB_PORT ?? "5432", 10);
const DB_NAME = process.env.DB_NAME ?? "wisprnote";
const DB_USER = process.env.DB_USER ?? "";
const DB_PASSWORD = process.env.DB_PASSWORD ?? "";
const USER_ID = process.env.WISPRNOTE_USER_ID ?? "";

if (!DB_HOST || !DB_USER || !DB_PASSWORD || !USER_ID) {
  console.error(
    "Missing required env vars: DB_HOST, DB_USER, DB_PASSWORD, WISPRNOTE_USER_ID"
  );
  process.exit(1);
}

const pool = new pg.Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

async function dbQuery(text: string, values?: any[]): Promise<any[]> {
  const result = await pool.query(text, values);
  return result.rows;
}

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
        type: "object" as const,
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
        type: "object" as const,
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
        type: "object" as const,
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
        type: "object" as const,
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
        type: "object" as const,
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
        type: "object" as const,
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
        type: "object" as const,
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
      case "list_meetings": {
        const limit = Math.min(Number(args?.limit ?? 20), 100);
        const data = await dbQuery(
          "SELECT id, filename, summary, status, duration, created_at, prompt FROM task_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
          [USER_ID, limit]
        );

        const formatted = data.map((m: any) => ({
          id: m.id,
          filename: m.filename,
          date: m.created_at,
          duration_seconds: m.duration,
          status: m.status,
          summary: m.summary?.substring(0, 300) + (m.summary?.length > 300 ? "…" : ""),
        }));

        return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
      }

      case "get_meeting_details": {
        const meetingId = String(args?.meeting_id ?? "");
        if (!meetingId) throw new Error("meeting_id is required");

        const rows = await dbQuery(
          "SELECT * FROM task_history WHERE id=$1 AND user_id=$2",
          [meetingId, USER_ID]
        );
        if (!rows.length) throw new Error("Meeting not found");
        const data = rows[0];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: data.id, filename: data.filename, date: data.created_at,
              duration_seconds: data.duration, prompt: data.prompt,
              summary: data.summary, notes: data.notes, transcription: data.transcription,
            }, null, 2),
          }],
        };
      }

      case "search_meetings": {
        const q = String(args?.query ?? "").toLowerCase().trim();
        if (!q) throw new Error("query is required");
        const limit = Math.min(Number(args?.limit ?? 10), 50);

        const data = await dbQuery(
          "SELECT id, filename, summary, transcription, created_at FROM task_history WHERE user_id=$1 ORDER BY created_at DESC",
          [USER_ID]
        );

        const results = data
          .filter((m: any) =>
            m.transcription?.toLowerCase().includes(q) ||
            m.summary?.toLowerCase().includes(q) ||
            m.filename?.toLowerCase().includes(q)
          )
          .slice(0, limit)
          .map((m: any) => {
            const text = (m.transcription ?? m.summary ?? "").toLowerCase();
            const idx = text.indexOf(q);
            const snippet = idx >= 0
              ? "…" + (m.transcription ?? m.summary ?? "").substring(Math.max(0, idx - 80), idx + 200) + "…"
              : m.summary?.substring(0, 200) ?? "";
            return { id: m.id, filename: m.filename, date: m.created_at, snippet };
          });

        return {
          content: [{
            type: "text",
            text: results.length === 0
              ? `No meetings found matching "${args?.query}".`
              : JSON.stringify(results, null, 2),
          }],
        };
      }

      case "get_knowledge_graph": {
        const meetingId = args?.meeting_id ? String(args.meeting_id) : null;
        let sql = "SELECT * FROM knowledge_graph WHERE user_id=$1";
        const vals: any[] = [USER_ID];
        if (meetingId) { sql += " AND task_id=$2"; vals.push(meetingId); }
        sql += " ORDER BY created_at DESC";

        const data = await dbQuery(sql, vals);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "get_meeting_assets": {
        const meetingId = String(args?.meeting_id ?? "");
        if (!meetingId) throw new Error("meeting_id is required");

        const data = await dbQuery(
          "SELECT id, type, filename, created_at, content FROM generated_assets WHERE task_id=$1 AND user_id=$2 ORDER BY created_at DESC",
          [meetingId, USER_ID]
        );

        return {
          content: [{
            type: "text",
            text: data.length === 0 ? "No assets generated for this meeting yet." : JSON.stringify(data, null, 2),
          }],
        };
      }

      case "get_action_items": {
        const meetingId = args?.meeting_id ? String(args.meeting_id) : null;
        let sql = "SELECT task_id, meeting_title, action_items FROM knowledge_graph WHERE user_id=$1";
        const vals: any[] = [USER_ID];
        if (meetingId) { sql += " AND task_id=$2"; vals.push(meetingId); }

        const data = await dbQuery(sql, vals);
        const allItems = data.flatMap((row: any) =>
          (row.action_items ?? []).map((item: any) => ({
            meeting_id: row.task_id, meeting_title: row.meeting_title,
            task: item.task, owner: item.owner, related_topic: item.relatedTopic,
          }))
        );

        return {
          content: [{
            type: "text",
            text: allItems.length === 0 ? "No action items found." : JSON.stringify(allItems, null, 2),
          }],
        };
      }

      case "get_people": {
        const data = await dbQuery(
          "SELECT task_id, meeting_title, people FROM knowledge_graph WHERE user_id=$1",
          [USER_ID]
        );

        const personMap: Record<string, { meeting_id: string; meeting_title: string }[]> = {};
        for (const row of data) {
          for (const person of row.people ?? []) {
            if (!person) continue;
            if (!personMap[person]) personMap[person] = [];
            personMap[person].push({ meeting_id: row.task_id, meeting_title: row.meeting_title });
          }
        }

        const result = Object.entries(personMap)
          .sort((a, b) => b[1].length - a[1].length)
          .map(([name, meetings]) => ({ name, meetings }));

        return {
          content: [{
            type: "text",
            text: result.length === 0 ? "No people found in knowledge graph." : JSON.stringify(result, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Wisprnote MCP server running on stdio");
