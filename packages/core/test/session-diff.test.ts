import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_diff_test")
const directory = AbsolutePath.make(process.cwd())
const ranges: Array<{ from: string; to: string }> = []
const snapshotLayer = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    diff: (input) => {
      ranges.push({ from: input.from, to: input.to })
      return Effect.succeed([
        {
          path: RelativePath.make("src/a.ts"),
          status: "modified" as const,
          additions: 1,
          deletions: 1,
          patch: "@@",
        },
      ])
    },
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<SessionV2.ID>()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    await: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)

const project = Layer.succeed(
  Project.Service,
  Project.Service.of({
    directories: () => Effect.succeed([]),
    resolve: () => Effect.succeed({ id: Project.ID.global, directory, vcs: undefined }),
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [SessionExecution.node, execution],
      [AppProcess.node, Layer.mock(AppProcess.Service, {})],
      [Project.node, project],
      [Location.node, Location.boundNode({ directory })],
      [Snapshot.node, snapshotLayer],
    ],
  ),
)

const user = (id: SessionMessage.ID, seq: number) => ({
  id,
  session_id: sessionID,
  type: "user" as const,
  seq,
  time_created: seq,
  data: { text: "go", files: [], agents: [], time: { created: seq } },
})

const assistant = (id: SessionMessage.ID, seq: number, snapshot: { start?: string; end?: string }) => ({
  id,
  session_id: sessionID,
  type: "assistant" as const,
  seq,
  time_created: seq,
  data: {
    agent: "build",
    model: { id: Model.ID.make("gpt"), providerID: Provider.ID.make("opencode") },
    content: [],
    time: { created: seq },
    snapshot,
  },
})

const setup = Effect.gen(function* () {
  ranges.length = 0
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory,
      title: "test",
      version: "test",
      runtime: "v2",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const rows = [
    user(SessionMessage.ID.make("msg_diff_user_1"), 10),
    assistant(SessionMessage.ID.make("msg_diff_assistant_1"), 11, { start: "snap_a", end: "snap_b" }),
    user(SessionMessage.ID.make("msg_diff_user_2"), 20),
    assistant(SessionMessage.ID.make("msg_diff_assistant_2"), 21, { start: "snap_b", end: "snap_c" }),
    user(SessionMessage.ID.make("msg_diff_user_3"), 30),
    assistant(SessionMessage.ID.make("msg_diff_assistant_3"), 31, { start: "snap_d", end: "snap_d" }),
  ]
  yield* db
    .insert(SessionMessageTable)
    .values(rows as Array<typeof SessionMessageTable.$inferInsert>)
    .run()
    .pipe(Effect.orDie)
})

describe("SessionV2.diff", () => {
  it.effect("diffs the full session from the first start to the last end", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const result = yield* session.diff({ sessionID })
      expect(result.map((item) => String(item.path))).toEqual(["src/a.ts"])
      expect(ranges.at(-1)).toEqual({ from: "snap_a", to: "snap_d" })
    }),
  )

  it.effect("scopes a user message to its turn and an assistant message to itself", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.diff({ sessionID, messageID: SessionMessage.ID.make("msg_diff_user_1") })
      expect(ranges.at(-1)).toEqual({ from: "snap_a", to: "snap_b" })
      yield* session.diff({ sessionID, messageID: SessionMessage.ID.make("msg_diff_assistant_2") })
      expect(ranges.at(-1)).toEqual({ from: "snap_b", to: "snap_c" })
    }),
  )

  it.effect("returns nothing for unchanged turns or unknown messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const before = ranges.length
      expect(yield* session.diff({ sessionID, messageID: SessionMessage.ID.make("msg_diff_user_3") })).toEqual([])
      expect(yield* session.diff({ sessionID, messageID: SessionMessage.ID.make("msg_diff_missing") })).toEqual([])
      expect(ranges.length).toBe(before)
    }),
  )
})
