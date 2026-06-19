# Folder-Scoped Connectors & Brain (Project-Level Structure)

> **Goal:** a workspace holds several **projects**; each project has its own Jira project
> and GitHub repo(s). The **workspace** gives the company-wide big picture (the aggregate);
> a **folder = a project** gives a clean, scoped view of just that project's work.
>
> **The correctness win (the real reason):** scoping the brain to the folder makes
> **wrong-project links structurally impossible**. Today the brain links across the whole
> workspace, so a Project-A meeting can wire up to Project-B's commits/tickets. With folder
> scoping, a Project-A meeting can *only* link to Project-A's mapped Jira + GitHub — the
> model never even sees other projects' items as candidates. Right meeting → right tools,
> by construction, not by a better prompt.

## Decisions (locked)
1. **Auth = shared company account, mapped per folder.** One Jira + one GitHub connection
   per workspace (the org). Folders don't re-authenticate; they just *map* to a project/repos.
2. **One folder = exactly 1 Jira project + 1‑to‑many GitHub repos.** Clean 1:1 project boundary.
3. **Non-destructive migration.** The existing workspace-level mapping stays as the
   "unfiled / workspace default" bucket; per-folder mappings are added on top and take
   precedence. Nothing breaks; existing brain data keeps working.
4. **Workspace = aggregate view; folder = scoped view.**

---

## Model

```
Workspace (company)  ── one Jira auth + one GitHub auth (broker, workspace-scoped)
   │
   ├─ Folder = Project A  → Jira: PROJA   · GitHub: org/repo-a1, org/repo-a2
   ├─ Folder = Project B  → Jira: PROJB   · GitHub: org/repo-b
   └─ (unfiled)           → workspace-default mapping (legacy / catch-all)
```

- **Brain map · workspace** = union of all folders (the big picture).
- **Brain map · folder** = just that project's meetings + Jira + GitHub + reasoning.

## Data-model changes

| Table | Change | Why |
|---|---|---|
| `connector_routing` | add `folder_id UUID NULL`; re-key PK to `(user_id, workspace_id, COALESCE(folder_id, sentinel), source)` | per-folder Jira project + repos; `folder_id IS NULL` = workspace default |
| `knowledge_item` | add `folder_id UUID NULL` (+ index `(user_id, workspace_id, folder_id)`) | every item belongs to a project (or unfiled) |
| `brain_edge`, `brain_event`, `brain_reasoning` | filter by `folder_id` (carry it, or join via `knowledge_item.folder_id`) | scoped graph / pulse / alerts per project |

**Resolution / precedence** (one helper, used everywhere): for `(workspace, folder, source)`
→ prefer the folder mapping; fall back to the workspace-default (`folder_id IS NULL`) mapping.

## How each layer changes

1. **Routing** (`connectors/routing.ts`): `getMapping`/`setMapping`/`getGithubRepos` take an
   optional `folderId`; reads resolve folder → workspace fallback. A new "list all folder
   mappings for a workspace" for the aggregate view.
2. **Sync** (`connectors/sync.ts`, `jira/index.ts`, `github/index.ts`): iterate **per
   (workspace, folder) mapping**; pull that folder's Jira project + repos; **tag each
   `knowledge_item.folder_id`**. Meetings get their `folder_id` from `task_folders`
   (`meetingIngest.ts`). Unmapped/`involves:@me` items → `folder_id NULL` (unfiled).
3. **Linking** (`connectors/brainLink.ts`) — *the correctness core*: candidate generation
   for an intent is restricted to items with the **same `folder_id`** (and the right
   sources). A Project-A meeting only sees Project-A candidates → no cross-project links.
   Unfiled (NULL) meetings link only within the unfiled bucket. `queryNearestItems` gains a
   `folderId` filter (Turbopuffer attribute, like the existing `source` filter).
4. **Endpoints** (`handleBrain` in `index.ts`): `/brain/graph`, `/brain/alerts`,
   `/brain/pulse`, `/brain/node`, and workspace chat accept an **optional `folder`** —
   set → `WHERE folder_id = folder`; omitted → whole workspace (aggregate).
5. **UI:**
   - **Connections** (`settings/ConnectionsTab.tsx`): a **folder picker** → set that
     folder's Jira project + GitHub repos; the workspace-level mapping remains as default.
   - **Workspace page** (`WorkspacePage.tsx`): the **aggregate** — all projects' Jira tasks
     + the full brain map (no `folder` param).
   - **Folder selected** (sidebar): the **scoped** view — pass `folder` to the brain map +
     tasks, so you see only that project.

## Migration (non-destructive)
- Existing `connector_routing` rows (no `folder_id`) → become the **workspace default**.
- Existing `knowledge_item` rows have `folder_id NULL` → show in the aggregate.
- Optional **backfill**: assign existing items to folders by matching `source_id` to a
  folder's mapped project/repo (e.g. a commit in `repo-a1` → Project A's folder; a `PROJA-…`
  issue → Project A). Bounded, idempotent; safe to re-run. Until backfilled, old items stay
  in the aggregate and re-tag as they re-sync.

## Meetings span projects (refinement, 2026-06-18)
A meeting is NOT confined to one project — its **content** decides which projects it links to.
This handles two real cases the single-folder model broke: (a) a meeting **left unfiled** at the
workspace level, and (b) a meeting that **covers several projects**. So:
- **Meeting intents:** candidates come from ALL projects (no folder gate); each resulting link
  is attributed to the **candidate's** project. A cross-project meeting links into every project
  it discusses; an unfiled meeting links to whichever projects its content matches. The
  similarity floor + strict alignment verdict keep out projects it doesn't discuss.
- **Jira tasks:** stay folder-gated (single-project → its commits are in its own folder).
- **Commits (semantic):** stay folder-gated (a commit belongs to one project).
The meeting's own `folder_id` is organizational (for showing the meeting node in a scoped view),
NOT a link boundary.

## Edge cases
- **Meeting in multiple folders** (`task_folders` is many-to-many): the meeting NODE is tagged to
  one primary folder for the scoped view, but its LINKS span every project its content matches
  (see "Meetings span projects" above), so multi-project meetings are handled.
- **Repo/project shared by two folders**: discouraged by the 1:1 model; if mapped twice,
  last-write-wins on `folder_id` (or we warn in the mapping UI).
- **Folder with no mapping**: falls back to the workspace default (so it still shows the
  company-wide brain until it's given its own project/repos).

## Phased build (each shippable + verifiable, non-breaking)
- **P1 — Schema + routing resolution. ✅ DONE + verified (2026-06-18).** `connector_routing`
  re-keyed to `(user_id, workspace_id, folder_id, source)` with `folder_id` defaulting to
  `WS_DEFAULT` sentinel (`000…000`); routing reads resolve folder→workspace fallback
  (`readRoute`); all routing fns take an optional `folderId`; added `listFolderMappings`;
  `knowledge_item.folder_id` (nullable) + index added. Verified: PK re-key applied, folder
  mapping reads + workspace fallback round-trip, existing flow unchanged.
- **P2 — Folder-tagged ingestion + backfill. ✅ DONE + verified (2026-06-18).** `routing.folderResolverFor`
  (project-key→folder, repo→folder) + `getAllMappedRepos` (sync pulls every folder's repos);
  `sync.upsertItem` tags `knowledge_item.folder_id` (COALESCE so a re-sync can't wipe a tag);
  GitHub connector pulls the union of all folders' repos; `meetingIngest` tags meetings from
  `task_folders`; `sync.backfillItemFolders()` tags existing items (jira/github by source_id
  match + meetings from task_folders, idempotent + converging). Verified: commit/issue resolve
  to the mapped folder, unmapped stays null, a real meeting backfilled from its folder. NOTE:
  `backfillItemFolders` is on-demand (not cron yet) — wire the trigger in P5 after mapping UI.
- **P3 — Folder-scoped linking. ✅ DONE + deployed (2026-06-18).** `brainLink` items query carries
  `folder_id`; intent candidate generation queries a wider ANN pool (`CAND_K*4`) then keeps only
  `itemById[cand].folder_id === intentFolder` (same project), slices to `CAND_K`; the semantic
  branch likewise filters hits to the self item's folder (queries `SEM_K*3`, caps at `SEM_K`).
  Non-breaking now (all items NULL folder → behaves as today); auto-scopes once folders map.
  Verified: brain-link runs clean on real data; cross-folder exclusion becomes observable in P5.
- **P4 — Endpoints take `folder`. ✅ DONE + deployed (2026-06-18).** `/brain/graph`, `/brain/alerts`
  (all 4 alert queries), `/brain/pulse` (`getEvents` LEFT JOINs knowledge_item for the folder)
  accept an optional `folder` query param via the `($n::uuid IS NULL OR col=folder_id)` pattern —
  set → that project; omitted → whole workspace (aggregate, non-breaking). `/brain/node` unchanged
  (a specific node). Verified: scope filter returns 1 (folder) vs 2 (aggregate). UI passes the
  param in P5.
- **P5 — UI. ✅ DONE (2026-06-18; server deployed, client needs app rebuild).** Server: routing
  `GET/POST /connectors/routing?workspace=[&folder=]` takes a folder + triggers `backfillItemFolders`
  on save (legacy workspace-wide prune kept only for the non-folder default). Client:
  `connectorService.get/setProjectMapping(ws, folderId?)`, `brainService.getBrainGraph/Alerts/Pulse(ws, folderId?)`;
  `ConnectionsTab` has a **Project (folder)** selector — map each folder → its Jira project + repos
  (or "Workspace default"); `BrainMapModal` takes `folderId`/`folderName` (header shows scope +
  "project"/"all projects" chip, re-fetches on folder change); `WorkspacePage` passes the
  sidebar-selected folder → **folder selected = scoped project view, workspace = aggregate**.
  *Accept:* map folders in Connections → each project's brain is isolated; workspace = big picture.
