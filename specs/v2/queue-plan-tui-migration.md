# Queue + Plan Workflow: V2 Core Port and TUI Migration

Status: in progress (started 2026-10-03)

Goal: make the durable V2 prompt queue and the ZCode-style plan workflow usable from the
main TUI, without breaking existing V1 sessions.

## Progress

- [x] Phase 0 - session-scoped permission grants
- [x] Phase 1 - plan workflow in v2 core (slug, plan tools, auto-continuation)
- [x] Phase 2 - runtime marker and TUI projection (transcript rendering)
- [x] Phase 3 - v2 prompt submission with intent, queue delivery and `/budget`
- [x] Phase 4 - automated end-to-end verification (HTTP queue smoke flow) and
      polish: paged v2 history, prompt budget indicator, v2 permission and
      question docks, retry status surfacing
- [x] Post-phase - v2 `session.shell` endpoint (core execution, protocol, TUI `!`
      shell mode)
- [x] Post-phase - v2 manual compaction (`/compact`)
- [x] Post-phase - v2 `session.wait`

The manual `bun dev` smoke is replaced by
`packages/opencode/test/server/httpapi-session.test.ts` "runs an end-to-end v2
queue flow over HTTP", which covers create (runtime v2), a held provider turn, a
queued prompt, edit, sendNow promotion and the follow-up turn.

## Decisions

1. Session drive-mode uses an explicit persisted `runtime: "v1" | "v2"` field
   (`SessionTable` + `Session.Info`). No heuristics.
2. Existing sessions stay on V1 (`runtime: "v1"`); new V2 submissions get
   `runtime: "v2"`. No historical V1 -> V2 message migration.
3. While a V2 session is busy, Enter submits `delivery: "queue"` (visible in the
   queue dialog). A modifier shortcut sends `delivery: "steer"`.
4. The context budget UI ships in this project: an intent value
   (`intent.context.maxInputTokens`) chosen at submit time via a slash command and
   a prompt-area indicator. It is frozen on admission, like other intent fields.
5. Core work lands first (Phase 0 -> Phase 1), then the TUI (Phase 2 -> Phase 3).
6. V2 capability gaps (shell, slash-command invoke, fork, share, manual compact,
   todo/diff reads, retry status, task tool parity) are deferred: hidden for V2
   sessions and tracked in the Deferred section below.

## Phase 0 - Session-scoped permission grants (V2 core)

Add `PermissionV2.grant({ sessionID, rules })` with process-local, per-session
in-memory storage. Grants are merged after agent rules and saved rules during
evaluation, so they can upgrade `ask` to `allow`, but an explicit agent `deny`
still wins (matches V1 `Permission.grant` semantics).

Files:
- `packages/core/src/permission.ts` (interface, storage, evaluation merge)
- `packages/core/test/permission.test.ts`

Tests: grant then assert/ask without prompting; grant does not override agent deny;
grants are scoped per session; unknown sessions are unaffected.

Commit: `feat(core): add session-scoped permission grants`

## Phase 1 - Plan workflow in V2 core

Port the pure plan logic and tools from `packages/opencode` to `packages/core`,
including the session slug needed to derive the plan file path.

Files:
- `packages/schema/src/session.ts` + `packages/core/src/session/info.ts`: expose
  `slug` on `Session.Info`; regenerate client types.
- `packages/core/src/session/plan-items.ts`: parser/progress/update logic
  (evidence required to mark done), errors mapped to `ToolFailure`.
- `packages/core/src/session/plan.ts`: plan file path
  (`<worktree>/.opencode/plans/<time.created>-<slug>.md`, or
  `Global.Path.data/plans` without VCS), read/write helpers.
- `packages/core/src/session/plan-continuation.ts`: process-local stall guard
  (`MAX_PLAN_STALLS = 2`) keyed by session ID.
- `packages/core/src/tool/plan.ts` (`plan_exit`) and
  `packages/core/src/tool/plan-items.ts` (`plan_status`, `plan_update`).
  `plan_exit` writes/validates the plan file, grants `allowedPrompts` via the
  Phase 0 API, asks a blocking confirmation question, then publishes
  `AgentSwitched(build)` plus an approval `Synthetic` message on "Yes".
- `packages/core/src/tool/builtins.ts`: register the tools (drop the `plan_exit`
  TODO).
- `packages/core/src/session/runner/llm.ts`: inside the drain continuation loop,
  when no steer/queue input is pending and the agent is not `plan`, read the plan
  file and publish a `Synthetic` continuation message (marked with
  `plan_continue` metadata); add `FSUtil` to the runner node deps.

Tests:
- `packages/core/test/session-plan-items.test.ts` (pure logic)
- `packages/core/test/tool-plan.test.ts` (tmpdir location fixture, mocked
  question/permission, path formula for git and non-git)
- runner continuation + stall behavior in the `session-runner` harness

Commit: `feat(plan): port plan workflow to v2 core`

## Phase 2 - Runtime marker and TUI V2 rendering

Persist `runtime` on sessions and teach the TUI to render V2 sessions through a
client-side projection into the existing V1 store so the transcript, tool
renderers, and export code stay unchanged.

Files:
- Schema/migration/projector/protocol: add `runtime: "v1" | "v2"` to sessions;
  V2 create writes `"v2"`, legacy rows default to `"v1"`; regenerate client.
- `packages/tui/src/util/session-v2.ts`: `SessionMessage.Message` ->
  `{ Message, Part[] }` projection (adapted from
  `packages/app/src/utils/session-message.ts`), including tool
  `structured`/`content` -> V1 `metadata` mapping, shell/synthetic/compaction
  synthesis, and agent/model-switched context tracking.
- `packages/tui/src/context/data.tsx`: fill reducer gaps (`retried`, `revert.*`,
  `moved`, `prompt.*`, `queue.policy`) and add paged history hydration.
- `packages/tui/src/context/sync.tsx`: dual-track by `runtime`; V2 sessions load
  `v2.session.messages` and reduce `session.next.*`; busy/idle from
  `v2.session.active` plus assistant completion.

Tests: projection unit tests using current schema fixtures; reducer tests.

Commits: `feat(session): add runtime marker` then
`feat(tui): render v2 sessions via adapter`

## Phase 3 - TUI submits V2 prompts with intent

Switch prompt submission for `runtime: "v2"` sessions to `v2.session.prompt` and
wire queue/intent producers.

Files:
- `packages/tui/src/component/prompt/index.tsx`: new-session create via
  `v2.session.create`; submit via `v2.session.prompt({ prompt, delivery, intent,
  resume })`. Default `delivery: "queue"`; modifier shortcut sends `"steer"`.
- Intent: capture agent/mode, model, and variant automatically; context budget
  via `/budget` plus a prompt-area indicator.
- Permission/question docks: bridge `permission.v2.*` / `question.v2.*` into the
  existing stores and reply through V2 endpoints.
- Hide shell/slash-command/fork/share/compact for V2 sessions until the Deferred
  work lands.
- `packages/core/src/tool/send-message.ts`: optional intent fields.
- `packages/tui/src/component/dialog-plan.tsx`: read the real plan file for VCS
  sessions (`client.file.read`), falling back to tool metadata.

Commit: `feat(tui): submit v2 prompts with intent and queue delivery`

## Phase 4 - Verification

- `bun typecheck` in core, opencode, tui, protocol, server, client.
- Targeted tests: core plan/queue/permission/runner, `httpapi-session`, TUI
  adapter/dialog tests.
- Manual smoke via `bun dev`: new V2 session -> busy queue -> queue dialog
  edit/reorder/send-now -> plan mode -> plan_exit -> auto-continuation.

## Deferred (not in this project)

These V2 protocol/core gaps must be filled before removing the TUI V2-session
restrictions:

- Slash-command invocation endpoint (V2 only lists commands).
- Session fork, share/unshare, rename/update, delete at the V2 layer.
- Todo and diff HTTP reads for V2 sessions.
- Retry/status events equivalent to V1 `session.status`.
- Tool parity: `task`, diagnostics, and complete `structured` -> TUI metadata
  coverage for every built-in tool.
