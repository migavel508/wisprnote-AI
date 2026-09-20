# Wisprnote MCP Server

> **⚠️ Outdated — Supabase era.** This copy of the MCP server talks to Supabase, which
> Wisprnote no longer uses; the backend moved to AWS (Cognito + API Gateway + DynamoDB).
> The setup instructions below will not work against a current deployment. It is kept for
> reference until the AWS-based server is merged in. If you want MCP access to a running
> Wisprnote instance, use the AWS-based server instead.

Connect your Wisprnote meeting data to Claude Desktop, Cursor, Windsurf, and any other MCP-compatible AI tool.

## What it exposes

| Tool | Description |
|---|---|
| `list_meetings` | List all your recorded meetings |
| `get_meeting_details` | Full transcription, summary, and notes for a meeting |
| `search_meetings` | Full-text search across all transcriptions |
| `get_knowledge_graph` | Topics, decisions, people, and action items from all meetings |
| `get_meeting_assets` | Generated emails, wikis, reports, and presentations |
| `get_action_items` | All action items and owners across meetings |
| `get_people` | All people mentioned across meetings |

---

## Setup

### Step 1 — Get your credentials from Supabase

1. **SUPABASE_URL** → Supabase Dashboard → Settings → API → Project URL
2. **SUPABASE_SERVICE_ROLE_KEY** → Supabase Dashboard → Settings → API → `service_role` secret key
3. **WISPRNOTE_USER_ID** → Supabase Dashboard → Authentication → Users → your UUID

### Step 2 — Build the server

```bash
cd mcp-server
npm install
npm run build
```

Note the absolute path to the built file — you'll need it below:
```
/absolute/path/to/Lumina-AI-/mcp-server/dist/index.js
```

---

## Connect to Claude Desktop

1. Open Claude Desktop → Settings → Developer → Edit Config (`claude_desktop_config.json`)
2. Add the following (replace paths and values):

```json
{
  "mcpServers": {
    "wisprnote": {
      "command": "node",
      "args": ["/absolute/path/to/Lumina-AI-/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "WISPRNOTE_USER_ID": "your-user-uuid"
      }
    }
  }
}
```

3. Restart Claude Desktop.
4. You should see a 🔌 icon in the chat — click it to confirm Wisprnote tools are listed.

**Example prompts to try in Claude:**
- *"List my recent meetings"*
- *"Search my meetings for anything about product roadmap"*
- *"What action items are assigned to me across all meetings?"*
- *"Show me the knowledge graph topics from my last 3 meetings"*

---

## Connect to Cursor

1. Open Cursor → Settings → MCP
2. Click **Add Server** and fill in:
   - **Name**: `wisprnote`
   - **Command**: `node`
   - **Args**: `/absolute/path/to/Lumina-AI-/mcp-server/dist/index.js`
   - **Env vars**: same three variables as above

---

## Connect to Windsurf

1. Open Windsurf → Settings → MCP Servers → Add
2. Use the same config as Cursor above.

---

## Connect to any MCP-compatible tool

Any tool that supports the Model Context Protocol (stdio transport) can connect using:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/Lumina-AI-/mcp-server/dist/index.js"],
  "env": {
    "SUPABASE_URL": "...",
    "SUPABASE_SERVICE_ROLE_KEY": "...",
    "WISPRNOTE_USER_ID": "..."
  }
}
```

---

## Security notes

- The `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. **Never commit it to git or expose it in the frontend.**
- All queries are scoped to your `WISPRNOTE_USER_ID` — no other user's data is accessible.
- Add `mcp-server/.env` to your `.gitignore`.
