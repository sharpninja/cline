# cline-qb handoff

Prepared from the live workspace-bound TODO on **2026-10-09 (UTC)**, which was **2026-10-08 in the local UTC-05:00 timezone**.

## 1. Start here: status and authorization

- Repository: `/home/sharpninja/github/cline`.
- Canonical implementation plan: MCP TODO **`QB-AGENT-001`**, **high priority**, **pending (`done: false`)**.
- Title: **Create cline-qb: mandatory QBrain integration, no Cline Cloud, responsive data sidebars, and compact tool headers**.
- The complete plan is stored in the TODO's `technicalDetails`; this handoff summarizes it and does not replace it.
- The TODO has **seven unchecked tasks**: administrative preparation, five major development phases, and final acceptance.
- Inventory: **20 proposed FRs, 20 TRs, 60 ACs, 60 TEST mappings, and 13 UCs**.
- **Product implementation has not started.** No product source/configuration changes or implementation tests were performed for this work. This handoff is a new documentation artifact, not a product change.
- Separate FR/TR/TEST/UC records have **not** been created. The IDs in the plan are proposed; UC IDs are aliases to reconcile with service-assigned IDs.
- Authorization so far covered saving the plan as a TODO and creating this handoff. **Do not interpret the switch to act mode or these administrative requests as authorization to implement the product.** Obtain explicit development authorization before P0/P1.
- No AC is satisfied, no phase is complete, and no development HV gate has run.

Read `/home/sharpninja/github/cline/AGENTS.md` and applicable package instructions before work. At handoff creation, neither `/home/sharpninja/github/cline/CLAUDE.md` nor `/home/sharpninja/github/cline/.clineignore` existed; recheck rather than assuming future absence.

## 2. Retrieve the canonical plan safely

Use the supported Cline plugin wrapper with an **explicit workspace**. The previously connected native MCP tools targeted another repository; do not rely on inherited workspace routing.

Current administrative wrapper, **not** the planned V2 runtime integration:

- Plugin root: `/home/sharpninja/github/mcpserver-cline-plugin`.
- Invocation script: `/home/sharpninja/github/mcpserver-cline-plugin/lib/Invoke-McpPlugin.ps1`.
- Trust bootstrap helper: `/home/sharpninja/github/mcpserver-cline-plugin/lib/marker-resolver.ps1`.
- Workspace marker: `/home/sharpninja/github/cline/AGENTS-README-FIRST.yaml`.

Verify the marker signature and health nonce using the supported bootstrap before MCP operations. Stop MCP use on trust failure; do not probe additional endpoints or bypass the plugin with raw REST/storage writes. The marker contains credentials: **do not copy it into documentation or logs**.

After successful bootstrap, retrieve the TODO:

```bash
MCP_PLUGIN_HOST=cline pwsh -NoProfile -NonInteractive \
  -File /home/sharpninja/github/mcpserver-cline-plugin/lib/Invoke-McpPlugin.ps1 \
  -Command Invoke \
  -Method workflow.todo.get \
  -WorkspacePath /home/sharpninja/github/cline \
  -PluginRoot /home/sharpninja/github/mcpserver-cline-plugin \
  -Params 'id: QB-AGENT-001'
```

Verified server read-back at handoff creation:

| Field | Value |
| --- | --- |
| TODO | `QB-AGENT-001` |
| Priority / completion | `high` / `false` |
| Full plan length | 53,455 characters |
| Plan SHA-256 | `29B8F0515116B1C5BBCAEE0EDDD40AEEDB855B2A0FBCD7B7F9E39FCE55CD1C5D` |
| Requirement links | 20 FRs, 20 TRs |
| Unchecked implementation tasks | 7 |

The hash is for UTF-8 text formed by joining `technicalDetails` with LF, without an added trailing newline. If the canonical TODO changes, reconcile with the newer server record rather than treating this snapshot/hash as an immutable requirement.

Temporary artifacts under `/tmp/` are **not durable or authoritative**: `/tmp/cline-qb-complete-plan.md`, `/tmp/cline-qb-todo-verification.json`, `/tmp/cline-qb-handoff-source-plan.md`, and `/tmp/cline-qb-handoff-source-todo.json`. A new agent must be able to proceed by retrieving the TODO without them.

Session continuity:

- Session: `Cline-20261009T004716Z-plugin-session`.
- Plan-save turn: `req-20261009T021418Z-save-cline-qb-plan` (completed).
- Handoff turn: `req-20261009T022712Z-create-cline-qb-handoff`.
- Session cache paths: `/home/sharpninja/github/cline/.mcpServer/cline/session-state.yaml` and `/home/sharpninja/github/cline/.mcpServer/cline/current-turn.yaml`. Inspect only as needed; mutate session/TODO/requirement state through supported plugin interfaces.

## 3. Non-negotiable product requirements

### Governed agent and branding

- Brand every shipped agent application **`cline-qb`**: CLI/TUI, VS Code, desktop, hub diagnostics, and agent-bearing examples.
- Incorporate **`mcpserver-cline-v2-plugin` directly**, pinned and bundled with tools, skills, required guidance, and supporting assets. No startup download, optional installation, or enablement prompt.
- Use configuration and isolated new modules where possible, but **change existing agent code wherever mandatory enforcement requires it**.
- Required policy is host-owned and protected, not model-voluntary or an ordinary optional plugin. No settings, flags, environment overrides, yolo mode, custom prompts, contribution shadowing, resume/rebuild/compaction, or delegation may remove it.
- Verify workspace trust/readiness before ordinary execution; enforce applicable tool prerequisites and current-state evidence; await completion obligations before final answers/success events. Cover text-only and tool-based completion.
- Preserve isolated workspace/session/delegate contexts and explicit agent-to-MCP session linkage. Confirm remote-host governance or refuse execution; no ungoverned fallback.
- Load all bundled skills; run applicable workflows when triggered, not unrelated actions indiscriminately. Make critical obligations executable checks rather than prose-only instructions.
- Actions and design decisions are separate audit records. Pending/recovery acknowledgments are not server-confirmed persistence.

### No Cline Cloud

- No Cline-hosted inference/cloud agents/account, billing, sign-in, remote configuration, telemetry, hosted feature flags, artifact/transcript uploads, or replacement updates.
- Existing credentials/cached settings cannot reactivate these services. Hide-and-continue behavior is insufficient; test the backend/network boundary.
- Keep local/self-hosted hub execution and directly configured model providers. User-controlled remote execution is permitted only with verified governance.
- No silent replacement with another hosted service. Zero prohibited **product-originated** traffic; this is not a restriction on arbitrary operator-requested public-internet tool use.

### Shared data and settings

- One supported plugin-backed, **read-only** Session Log/TODO service for TUI and desktop. No direct store reads/writes, duplicate raw REST client, browser credentials, model calls, or extra turns for browsing.
- Session Log uses the active conversation's explicit linked MCP session, not the latest unrelated session or chat history. Show IDs, titles, statuses, interpretation/response, actions, decisions, dialog, persistence/refresh status, and bounded detail retrieval.
- TODO view shows workspace records, priority/state/remaining work/subtasks/dependencies and open/completed filters. Browsing never selects the agent's active TODO or mutates records. Keep desktop Agenda tasks distinct.
- Refresh on relevant changes, context switch, reconnect, and manual request; configurable visible-view polling (proposed default five seconds). Prevent overlap/context races; preserve only matching-context last-good data with explicit stale/error state. Hidden panels pause display polling, **not enforcement/auditing**.
- Add a **qbrain.ai** TUI settings tab and equivalent desktop section: effective endpoint/workspace/configuration source, supported masked auth, connection test, trust/health, plugin version/readiness, refresh, and panel preferences.
- Connection changes use supported bootstrap/configuration and revalidate trust; no direct edits to signed marker fields. No disable/skip/continue-ungoverned/re-enable-cloud setting.

### Responsive TUI, dimensions, and keys

- Aspect selects horizontal versus vertical; proposed breakpoint `columns / rows >= 2.5`, subject to usable space. Compute from the full terminal, not remaining chat width.
- Flip cycle: **right -> left -> hidden -> right**, or **bottom -> top -> hidden -> bottom**.
- Remember horizontal/vertical edges independently. Hidden persists through aspect changes; reveal uses the first edge for the current orientation. Hide reclaims chat space and returns panel focus to prompt. It never weakens governance.
- Independent left/right width in **columns** and top/bottom height in **lines**, including borders; positive integers or **Auto**.
- Proposed Auto defaults: approximately 30%, normally 32-48 columns / 8-14 lines. Explicit sizes override those ranges, constrained by usable terminal/chat space. Preserve requested sizes through temporary fit clamping and restore when room returns.
- Persist dimensions, edges, visibility, selected data view, and custom bindings across **new invocations**. Report save failures; transient layout changes cannot overwrite requested preferences.
- Default cycle: **Alt+B / Option+B**. Expand: **Ctrl+Plus**, with **Ctrl+Equal** alias. Shrink: **Ctrl+Minus**. One column/line per press, repeat supported; first Auto resize starts at displayed size and changes only that dimension to explicit.
- Resizing cannot hide or implicitly reveal. Preserve draft/cursor/focus/selection/scroll/streaming; suspend panel shortcuts while modal/approval input owns control.
- User-definable cycle/expand/shrink/focus/switch-view/refresh; modifier-aware normalization, duplicate/reserved conflict checks, reset defaults, current-binding help, and command-palette alternatives. Preserve existing Tab, Shift+Tab, and Ctrl+Alt+B controls.
- Size child content against **allocated panes**, not full terminal width. Tiny terminals use compact presentation distinct from Hidden, without obscuring prompt/approvals.

### Desktop and compact tool headers

- Extend the existing desktop sidebar with Session Log/TODO views; keep history/settings and active chat mounted. Preserve draft/stream/scroll, existing collapse/narrow behavior, and environment/workspace/session isolation. Do not automatically apply the TUI four-edge cycle to desktop.
- Compress **tool-invocation headers**, not actual execution or stdout/stderr. Example: `run_commands(pwsh script; 1 command)` instead of the full inline script.
- Agent/runtime generates deterministic summaries; **do not ask the model to summarize or obey a one-line prompt**.
- At most **one visual row**, normalized controls/newlines, display-width-aware ellipsis, no wrapping: live calls, narrow panes, batched/unknown tools, and restored history across CLI/TUI, desktop, and VS Code.
- Preserve exact execution inputs, model results, and audit payloads under existing security policies. Exact invocation remains inspectable/copyable and accessible for approval. Do not render full `rawInput` as the default header after generating a compact summary.

## 4. Requirement and TDD traceability

All rows are **new proposed records**, not satisfied criteria. Detailed AC bodies, named tests, alternatives, and mappings are in the canonical TODO. Each TEST number corresponds to the AC with the same number.

| FR | Scope | TR | AC / TEST range | TDD owner |
| --- | --- | --- | --- | --- |
| FR-QB-001 | Built-in mandatory plugin | TR-QB-PLUGIN-001 | 001-003 | P1 |
| FR-QB-002 | Trusted workspace startup | TR-QB-TRUST-001 | 004-006 | P1 |
| FR-QB-003 | Durable auditing | TR-QB-AUDIT-001 | 007-009 | P1 |
| FR-QB-004 | Completion obligations | TR-QB-COMPLETION-001 | 010-012 | P1 |
| FR-QB-005 | All execution paths | TR-QB-RUNTIME-001 | 013-015 | P1 |
| FR-QB-006 | No Cline Cloud | TR-QB-NETWORK-001 | 016-018 | P1 |
| FR-QB-007 | Session Log inspection | TR-QB-LOGREAD-001 | 019-021 | P2 |
| FR-QB-008 | TODO inspection | TR-QB-TODOREAD-001 | 022-024 | P2 |
| FR-QB-009 | Refresh/context isolation | TR-QB-DATA-001 | 025-027 | P2 |
| FR-QB-010 | qbrain.ai settings | TR-QB-SETTINGS-001 | 028-030 | P2 |
| FR-QB-011 | Aspect-dependent TUI | TR-QB-LAYOUT-001 | 031-033 | P3 |
| FR-QB-012 | Three-state visibility | TR-QB-VISIBILITY-001 | 034-036 | P3 |
| FR-QB-013 | Column/line sizing | TR-QB-SIZE-001 | 037-039 | P3 |
| FR-QB-014 | Expand/shrink keys | TR-QB-RESIZE-001 | 040-042 | P3 |
| FR-QB-015 | Custom bindings | TR-QB-KEYS-001 | 043-045 | P3 |
| FR-QB-016 | Relaunch persistence | TR-QB-PERSIST-001 | 046-048 | P3 |
| FR-QB-017 | Desktop sidebar | TR-QB-DESKTOP-001 | 049-051 | P4 |
| FR-QB-018 | Branding/documentation | TR-QB-BRANDING-001 | 052-054 | P5 |
| FR-QB-019 | Governed distribution | TR-QB-DISTRIBUTION-001 | 055-057 | P5 |
| FR-QB-020 | Compact tool headers | TR-QB-PRESENTATION-001 | 058-059; 060 | P2; 060 closes P5 |

**AC-QB-060 / TEST-QB-060 is staged**: TUI/CLI red-first rendering tests in P3, desktop in P4, VS Code/packaged tests in P5. Do not mark it satisfied until every host passes in P5. AC-QB-059 payload/approval preservation remains a host regression obligation throughout.

Phase-owned counts: **P1 18, P2 14, P3 18, P4 3, P5 7 = 60/60**. Staged/regression coverage does not double-count ownership.

UC aliases:

| UC | Scenario | Owner |
| --- | --- | --- |
| UC-QB-001 | Start trusted governed agent | P1 |
| UC-QB-002 | Recover enforcement infrastructure failure | P1 |
| UC-QB-003 | Execute/complete audited work | P1 |
| UC-QB-004 | Resume, delegate, execute remotely | P1 |
| UC-QB-005 | Work without Cline Cloud | P1 |
| UC-QB-006 | Inspect linked Session Log | P2; views P3/P4 |
| UC-QB-007 | Browse workspace TODOs | P2; views P3/P4 |
| UC-QB-008 | Configure qbrain.ai | P2; desktop P4 |
| UC-QB-009 | Reposition/hide TUI panel | P3 |
| UC-QB-010 | Customize size/keys and relaunch | P3 |
| UC-QB-011 | Inspect desktop data | P4 |
| UC-QB-012 | Install/launch governed artifacts | P5 |
| UC-QB-013 | Inspect compact tool invocation | P2-P5; final P5 |

## 5. Execution order and HV boundaries

**P0 — after explicit development approval:** recheck the live requirement namespace; create or reconcile FR/TR/structured AC/TEST/UC records and mappings through MCP; preserve assigned IDs; freeze compatibility, recovery, migration, and settings contracts. Do not mutate generated storage documents directly. Administrative P0 has no HV.

1. **P1:** required plugin/trust/audit/completion, all runtime factories/delegates, no Cline Cloud. Green suites -> **HV-P1**.
2. **P2:** shared read service/refresh/secrets/settings, deterministic summaries and immutable payload contracts. Green cumulative suites -> **HV-P2**.
3. **P3:** responsive TUI, hidden cycle, sizing/custom keys/persistence, staged TUI headers. Green cumulative/real-terminal suites -> **HV-P3**.
4. **P4:** desktop sidebar/client/sidecar/settings/chat preservation and staged desktop headers. Green cumulative/UI suites -> **HV-P4**.
5. **P5:** branding/artifacts/updates/docs, VS Code headers, full 60-AC packaged acceptance. Green full suites -> **HV-P5**.

For each AC: write its executable test **before implementation**, retain genuine missing-behavior red evidence, implement, run green and regressions, and retain command/test/source revision or changed-state fingerprint/result/AC linkage. Setup failures do not count as red TDD. Cover linked UC basic/alternative flows. No skipped required tests, invented results, or unrun checks claimed complete.

**HV runs only at major development-phase completion for code/documentation changes.** Not after each edit, red/green step, AC, subtask, administrative action, or merely to update a record after an accepted gate. This handoff creation does not close a development phase and does not trigger HV.

Each phase-closing HV requires request/response JSONL receipts, full verdict in the MCP session log, all FAIL/UNKNOWN findings, accuracy and completeness >=98%, and **AGREE** before phase closure. Remediate findings and rerun that same closing gate as needed. Report aborted/unrun reviews honestly.

## 6. Implementation anchors and verified tooling

Reinspect the current source before editing; the plan records earlier observations, not a guarantee that line numbers or APIs are unchanged.

- Runtime: `/home/sharpninja/github/cline/sdk/packages/core/src/services/local-runtime-bootstrap.ts`, `/home/sharpninja/github/cline/sdk/packages/core/src/services/global-settings.ts`, `/home/sharpninja/github/cline/sdk/packages/core/src/runtime/orchestration/runtime-builder.ts`, `/home/sharpninja/github/cline/sdk/packages/agents/src/agent-runtime.ts`.
- Proposed isolated integration directory: `/home/sharpninja/github/cline/sdk/packages/core/src/extensions/qbrain/` (not implemented).
- CLI cloud/control: `/home/sharpninja/github/cline/apps/cli/src/utils/enterprise.ts`, `/home/sharpninja/github/cline/apps/cli/src/utils/feature-flags.ts`, `/home/sharpninja/github/cline/apps/cli/src/utils/telemetry.ts`.
- TUI: `/home/sharpninja/github/cline/apps/cli/src/tui/root.tsx`, `/home/sharpninja/github/cline/apps/cli/src/tui/components/chat-entry.tsx`, `/home/sharpninja/github/cline/apps/cli/src/tui/hooks/use-root-keyboard.ts`, `/home/sharpninja/github/cline/apps/cli/src/tui/components/dialogs/command-palette-items.ts`.
- Tool display: `/home/sharpninja/github/cline/apps/cli/src/utils/helpers.ts` and `/home/sharpninja/github/cline/apps/cli/src/utils/events.ts`. Earlier inspection found the TUI reconstructing full commands from `rawInput`, bypassing shortened summaries.
- Desktop: `/home/sharpninja/github/cline/apps/examples/desktop-app/webview/components/agent-sidebar.tsx`, `/home/sharpninja/github/cline/apps/examples/desktop-app/webview/app/page.tsx`, `/home/sharpninja/github/cline/apps/examples/desktop-app/webview/lib/desktop-client.ts`, `/home/sharpninja/github/cline/apps/examples/desktop-app/sidecar/commands.ts`.
- Desktop settings/cloud/header renderers: inspect `/home/sharpninja/github/cline/apps/examples/desktop-app/webview/components/views/settings/`, `/home/sharpninja/github/cline/apps/examples/desktop-app/sidecar/cloud-sessions.ts`, and `/home/sharpninja/github/cline/apps/examples/desktop-app/webview/components/views/chat/messages/`.
- VS Code adapter and webview: `/home/sharpninja/github/cline/apps/vscode/src/sdk/` and `/home/sharpninja/github/cline/apps/vscode/webview-ui/`.

Tooling: **Bun for package management/task running; Node for the application runtime/ABI**. No npm/yarn/pnpm/npx. Build SDK dependencies with `bun run build:sdk` before downstream execution/tests after SDK changes; compiled exports and running processes do not hot-reload source. Follow actual imports and package runners, not a blanket assumption that all suites use `bun:test`.

Verified at handoff creation, but **not executed as implementation validation**:

```text
bun run build:sdk
bun -F @cline/agents test
bun -F @cline/core test:unit
bun -F @cline/cli typecheck
bun -F @cline/cli test:unit
bun -F @cline/cli test:e2e:tuistory
```

Current core/agents/CLI test scripts invoke **Vitest**. Desktop also uses Vitest, with scripts `typecheck`, `test:sidecar`, `test:settings-ui`, `test:desktop-client`, and `test:chat-ui`; run them from `/home/sharpninja/github/cline/apps/examples/desktop-app`. Reinspect VS Code scripts/host test requirements and every runner's discovery filters before adding tests. Tests outside discovery do not count.

Use existing typed file-backed state/secret services and proxy-aware backend networking. Avoid ad hoc provider-string branches, guessed SDK APIs, generated-file edits, per-PR changelog entries, or direct session/requirement/TODO store mutations. Preserve necessary data/protocol IDs. Respect package instructions and ignore rules.

## 7. Working tree, limitations, and next action

Before creating this handoff, tracked/staged diffs were empty. These **pre-existing untracked artifacts** were present; do not delete, stage, or overwrite them blindly:

```text
/home/sharpninja/github/cline/.mcpServer/
/home/sharpninja/github/cline/AGENTS-README-FIRST.yaml
/home/sharpninja/github/cline/docs/receipts/
/home/sharpninja/github/cline/docs/todo.yaml
/home/sharpninja/github/cline/docs/wiki.yaml
```

This task adds only `/home/sharpninja/github/cline/HANDOFF.md` to product documentation. No commit, push, product build, product tests, separate requirement creation, or implementation-phase review is implied.

The guarantee is **application-level governance** in shipped cline-qb paths. It cannot prevent a machine administrator replacing binaries/running another product or mathematically guarantee arbitrary LLM prose compliance. Missing required infrastructure intentionally blocks work and requires supported recovery.

**Next action:** retrieve and read all of `QB-AGENT-001`, confirm its current state and operator development authorization, then execute P0 and tests-first P1. Do not start with sidebar implementation before the required policy/service foundations. Do not mark the planning TODO complete merely because it was saved or handed off.