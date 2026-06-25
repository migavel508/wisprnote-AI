# Workspaces as the Master Identity — Architecture Plan

> Goal: make **Workspace** the master scope of the entire app — a "second primary id"
> / private vault. Switching workspace reloads the whole app to show ONLY that
> workspace's data (recordings, notes, knowledge graph, history, chat, connectors,
> and the Spaces within it). **Spaces live inside a workspace** — a Space is not a
> Workspace. Default workspace = the user's name + profile photo. Max 5 per user.
>
> No code yet — this is the plan from a full audit of the current model.

---

## 1. Glossary (target model)

```
User (login identity)
 └─ Workspace   ← MASTER scope / "second primary id" / vault   (≤ 5, default = user's name+photo)
     └─ Space   ← grouping inside a workspace (sidebar "Spaces": My notes 🔒, AI ❤️, HQ)
         └─ Folder / Note / Recording        (the leaf content)
     + workspace-wide: history, knowledge graph, chat, connectors — ALL scoped to the workspace
```

- **Workspace** = the shareable vault the user switches between (bottom account pill). Everything in the app is "inside" exactly one active workspace.
  - The **default workspace = the user's own name + profile photo** (auto-created at signup; cannot be deleted).
  - Beyond the default, the user can **create any workspace with any name / icon / color** (free-form), up to **5 total**.
- **Space** = a sub-section within the active workspace (today these are the `folders`). The familiar **"My notes" 🔒** becomes the default *Space* inside each workspace — not a workspace itself.
- Switching workspace = the whole app re-partitions to that workspace.

---

## 2. Audit — what exists today (and the real gap)

**Good news: the master layer already half-exists.** The DB already has a `workspaces`
table that is the right shape for the master vault, and the *newer* features are already
scoped by it:

| Already workspace-scoped (backend) | Where |
|---|---|
| `workspaces` (id, user_id, name, emoji, color) + `workspace_members` (sharing/roles) | `workspace_migration.sql` |
| `folders` (belong to a workspace) | `workspace_migration.sql` |
| `knowledge_item`, `chat_history`, `connector_credentials`, `oauth_state`, `evidence` | `aws/api/src/index.ts` (all `WHERE user_id=$ AND workspace_id=$`) |
| Workspace-scoped chat (`scope='workspace'`) via `task_workspaces` / `task_folders` joins | `aws/api/src/chatAgent.ts` |

**The gaps (why it doesn't behave like a master vault yet):**

1. **The PRIMARY data is NOT workspace-partitioned.** `task_history` (recordings + notes — the core of the app) is scoped by **`user_id` only**. The home/history listing (`getTasksLightweight` → `SELECT … WHERE user_id=$1`) and the all-meetings chat operate **globally across the user**, ignoring the active workspace. A recording is attached to a workspace only *optionally*, via a many-to-many `task_workspaces` join (an explicit "move" action). So switching workspace does **not** repartition the app.

2. **Terminology / placement is inverted in the UI.** The sidebar **"Spaces"** section currently lists **workspaces** (each expandable to its folders), while the bottom **WorkspaceSwitcher** also deals with workspaces + account. So "Spaces" is mislabeled — it shows the master entity, not sub-sections. (This is exactly the "our current spaces is not a workspace" issue.)

3. **Defaults & limits don't match.** Default workspace is **"My notes" 🔒**, not the user's name + photo. There is **no max-5 cap**. Switching does not invalidate caches or reload app data (incl. the new all-meetings full-index cache).

So this is **mostly a scoping + naming + switching fix on an existing layer** — not a brand-new master layer from scratch. That makes it tractable.

---

## 3. Current vs Proposed

| # | Dimension | Current | Proposed (master workspace) |
|---|---|---|---|
| 1 | Master scope of app data | `user_id` only; workspace is an optional tag | **`workspace_id` is a required partition** on all data — the "second primary id". Every read/write filters `user_id AND workspace_id` |
| 2 | `task_history` (recordings/notes) | `user_id`-global; M:N `task_workspaces` (optional) | Each recording **belongs to exactly one workspace** (its creation workspace); listing is workspace-scoped |
| 3 | Home / history / all-meetings chat | shows ALL the user's meetings | shows ONLY the active workspace's meetings |
| 4 | "Spaces" (sidebar) | lists **workspaces** (mislabeled) | lists the active workspace's **Spaces** (today's `folders`, renamed) |
| 5 | Workspace switcher | bottom pill (workspace + account mixed) | bottom **account pill = workspace switcher**; switch → **whole app reloads** to that vault |
| 6 | Default workspace | "My notes" 🔒 | **user's name + profile photo** (auto, undeletable); "My notes" 🔒 becomes the default *Space* inside |
| 7 | Workspace creation | — | user creates **any** workspace (free-form name/icon/color), **max 5** total |
| 8 | KG / chat / connectors | already workspace-scoped ✅ | unchanged (already correct) |
| 9 | Sharing / members | on workspace (`workspace_members`) ✅ | unchanged — the workspace IS the team/share unit ("Invite teammates", "1 member") |
| 10 | Switching side-effects | none (data is global) | invalidate ALL caches (all-meetings index, KG, chat threads), reset selection, refetch |

**Recommended mapping (reuse, don't rebuild):** keep `workspaces` AS the master Workspace
(it already has members + KG/chat/connector scoping), and treat today's `folders` as
**Spaces**. The work is to (a) harden the partition down to `task_history`, (b) make the
default experience workspace-scoped, (c) fix UI naming/placement + switching, (d) defaults
+ cap. A brand-new top-level table is **not** needed.

---

## 4. The scoping model — "workspace_id as a second primary key"

The invariant: **no app data is reachable without an active `workspace_id`.** Enforced in
the Lambda (the single trust boundary), exactly like `user_id` is today:

- `task_history` gets a required `workspace_id` column (backfilled — see §6). Primary
  listing, single-meeting fetch, search, and the all-meetings index all add
  `AND workspace_id = :active`.
- Every other table already carries `workspace_id` — keep enforcing it.
- The client sends the active `workspace_id` on every request (header or query param),
  resolved from `workspaceSelection`. The Lambda validates the workspace belongs to the
  user (`workspaces.user_id = caller`) before trusting it — never trust a client id blindly.
- **Least privilege:** a request scoped to workspace A can never read workspace B's rows,
  even for the same user. This is the vault guarantee.

This directly composes with the scale work already shipped: the all-meetings full-index
(`getAllTaskIds`) and its session cache simply gain a workspace filter, and the cache key
becomes `(user, workspace)` — switching invalidates it.

---

## 5. Switching behavior (the "whole app adapts" requirement)

On workspace switch (bottom pill):
1. Set active `workspace_id` in `workspaceSelection` (persisted).
2. **Invalidate every per-session cache** keyed to the old workspace: the all-meetings
   meta cache, KG cache, chat-thread list, brain/graph caches, any in-memory `history`.
3. Reset navigation to Home and **refetch** Home/history/spaces for the new workspace.
4. New recordings, notes, KG extraction, chat, and connector calls all carry the new
   `workspace_id` automatically (it's the active scope).

The user should perceive a clean, instant context swap — like logging into a different
account, but without re-auth.

---

## 6. Schema + migration (non-destructive, backfilled)

1. **`task_history.workspace_id`** (new, NOT NULL after backfill) + index `(user_id, workspace_id, created_at)`.
2. **Per-user default workspace = the user's name + photo.** On migration, for every user:
   create a default workspace named after the user (avatar = profile photo, `is_default=true`,
   undeletable). The old "My notes" becomes the default **Space** inside it (not a workspace).
   Any *other* existing workspaces the user already has (e.g. "poz") are kept as additional
   workspaces. New users get this default at signup. Additional workspaces are fully
   free-form (any name/icon/color), capped at 5.
3. **Backfill assignment:** every existing `task_history` row → the user's default workspace.
   (Rows already in a `task_workspaces` association keep that workspace as their home; the
   rest go to default.) Same backfill for any KG/chat rows missing `workspace_id`.
4. **Spaces = folders:** no schema change; rename in the UI/types `folder → space`
   (keep `folders` table name or add a view, to avoid a risky table rename). Optional later:
   nested folders *within* a space (the "AI" under "My notes" nesting in the mockups).
5. **Cap 5:** enforce in the Lambda on workspace-create (and reflect in the UI).
6. Keep `task_workspaces` only if you still want a meeting to *also* appear in another
   workspace (cross-posting); otherwise it's superseded by the column. Default v1: one home
   workspace per recording (simpler, true partition).

Migrations follow the existing `ensure*Schema()` + `aws/migration.sql` pattern; all
idempotent and safe to re-run.

---

## 7. UI changes (match the mockups)

- **Bottom account pill = Workspace switcher.** Header shows the active workspace
  (name + avatar, member count, "Invite teammates"); menu lists the user's workspaces with
  a checkmark on active, "Add workspace" (disabled at 5), Settings, Sign out. (Most of this
  exists in `WorkspaceSwitcher.tsx` already.)
- **Sidebar "Spaces" section** lists the **active workspace's Spaces** (today's folders),
  not workspaces. "Add space" creates a space in the current workspace.
- **Default workspace avatar** = user's profile photo; default name = user's name.
- Create/switch flows route through `workspaceSelection`; switching triggers §5.

---

## 8. Decisions to confirm before building

1. **One home workspace per recording** (true partition) vs keep optional cross-posting
   (`task_workspaces`)? — recommend true partition for v1.
2. **Existing multi-workspace users** (e.g. "Migavel D", "poz"): keep both as master
   workspaces; pick the default = the one matching their name, else first. OK?
3. **Folder nesting inside a Space** (mockup shows "AI" under "My notes") — v1 flat spaces,
   or build nesting now?
4. **Sharing granularity** stays at workspace level (members on the vault)? (Matches
   "Invite teammates" in the mockup.)
5. **Cross-workspace global search** — explicitly OFF by default (vault isolation), with a
   possible future "search all workspaces" toggle?

---

## 9. Implementation surface — BOTH sides, every phase

This is a full-stack change: the **AWS Lambda (`aws/api`) is the source of truth + the
scoping trust boundary**, and the **desktop client (`src`) carries/sends the active
workspace and renders the switch**. Neither side alone is sufficient — a server filter
with no client selector shows nothing; a client selector with no server filter leaks the
vault. So **every phase below has a server task AND a client task**, shipped together.

| Concern | AWS server (`aws/api`) | Desktop client (`src`) |
|---|---|---|
| Schema / migration | `ensure*Schema()` + `aws/migration.sql`: `task_history.workspace_id`, `is_default`, backfill | — (reads new shape) |
| Scoping enforcement | every query adds `user_id AND workspace_id`; validate workspace ∈ user; one shared scoping helper | send active `workspace_id` (header/query) on every request from `awsService`/`workspaceService` |
| Default workspace | create username+photo default at signup; mark undeletable; enforce **max 5** on create | resolve/show default; `ensureDefaultWorkspace` → name+photo; disable "Add workspace" at 5 |
| Switching | stateless — just honors the `workspace_id` it's given | `workspaceSelection` active id + **invalidate all caches** + refetch + reset nav |
| Vector search | turbopuffer payload carries `workspace_id`; filter on it | pass workspace filter into `turbopufferService` queries |
| UI | — | bottom pill = workspace switcher; sidebar "Spaces" = the workspace's folders(→spaces) |

---

## 10. Phased rollout (non-breaking) — server + client together each phase

- **W0 — Schema + backfill.** *Server:* add `task_history.workspace_id` + `workspaces.is_default`, per-user default workspace (name+photo), backfill all data + KG/chat rows. *Client:* none (still reads globally). *Acceptance: every row has a workspace; nothing visibly changes.*
- **W1 — Read partition.** *Server:* `/tasks`, single-meeting, search, KG read filter by `workspace_id`. *Client:* send active `workspace_id`; all-meetings index + scale caches key on `(user, workspace)`. *Acceptance: home shows only the active workspace's meetings.*
- **W2 — Write partition.** *Server:* persist `workspace_id` on task/note/KG/chat insert; turbopuffer payload includes it. *Client:* attach active `workspace_id` to every create (record, note, chat, connector). *Acceptance: a recording made in workspace A never appears in B.*
- **W3 — Switching = full reload.** *Server:* honor the id (no change beyond W1). *Client:* bottom pill switch → invalidate ALL per-workspace caches + refetch + reset nav. *Acceptance: switching cleanly swaps the entire app context.*
- **W4 — UI naming + defaults + cap.** *Server:* enforce max 5 + undeletable default. *Client:* sidebar "Spaces" = folders(→spaces); default workspace = name+photo; free-form create; "Add space" vs "Add workspace" separated. *Acceptance: matches the mockups.*
- **W5 — Polish.** Optional folder nesting, cross-post, members/invite UX (both sides).

---

## 11. Risks

- **Backfill correctness** — every existing recording must land in exactly one workspace;
  a missed row = "lost" data from the user's view. Backfill must be exhaustive + verified.
- **Cache invalidation on switch** — a stale cache after switch = workspace bleed (showing
  A's data in B). Must invalidate ALL per-workspace caches, including the new all-meetings
  index cache.
- **Lambda enforcement** — every query must add `workspace_id`; a missed filter = a vault
  leak. Centralize the scoping (one helper) so it can't be forgotten per-endpoint.
- **Turbopuffer** — vectors must carry `workspace_id` in their payload so semantic search
  is workspace-filtered, not just the SQL.
