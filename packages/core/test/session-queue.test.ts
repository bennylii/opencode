import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const resumeCalls: SessionV2.ID[] = []

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<SessionV2.ID>()),
    resume: (sessionID) =>
      Effect.sync(() => {
        resumeCalls.push(sessionID)
      }),
    interrupt: () => Effect.void,
    wake: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [[SessionExecution.node, execution]],
  ),
)

const sessionID = SessionV2.ID.make("ses_queue_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admit = (text: string, options?: { delivery?: "steer" | "queue"; intent?: SessionInput.Intent; id?: SessionMessage.ID }) =>
  SessionV2.Service.use((session) =>
    session.prompt({
      sessionID,
      ...(options?.id ? { id: options.id } : {}),
      prompt: Prompt.make({ text }),
      delivery: options?.delivery ?? "queue",
      ...(options?.intent ? { intent: options.intent } : {}),
      resume: false,
    }),
  )

describe("SessionV2.queue", () => {
  it.effect("lists pending inputs in admission order and drops promoted ones", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const first = yield* admit("first")
      yield* admit("second")

      const pending = yield* session.queue.list(sessionID)
      expect(pending.map((item) => item.prompt.text)).toEqual(["first", "second"])

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.promoteNextQueued(db, events, sessionID)

      const remaining = yield* session.queue.list(sessionID)
      expect(remaining.map((item) => item.prompt.text)).toEqual(["second"])
      expect(remaining[0]?.id).not.toBe(first.id)
    }),
  )

  it.effect("edits text only and only for unpromoted inputs", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const item = yield* admit("original", {
        intent: { mode: "plan", model: { providerID: "fake", modelID: "m", variant: "high" } },
      })

      expect(yield* session.queue.edit({ sessionID, id: item.id, text: "edited" })).toBe(true)
      const pending = yield* session.queue.list(sessionID)
      expect(pending[0]?.prompt.text).toBe("edited")
      // 冻结属性不随文本编辑改变
      expect(pending[0]?.intent).toEqual({
        mode: "plan",
        model: { providerID: "fake", modelID: "m", variant: "high" },
      })

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* session.queue.edit({ sessionID, id: item.id, text: "late" })).toBe(false)
    }),
  )

  it.effect("removes pending inputs only", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const item = yield* admit("remove me")
      expect(yield* session.queue.remove({ sessionID, id: item.id })).toBe(true)
      expect(yield* session.queue.list(sessionID)).toEqual([])

      const promoted = yield* admit("already promoted")
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* session.queue.remove({ sessionID, id: promoted.id })).toBe(false)
    }),
  )

  it.effect("reorders pending inputs", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const first = yield* admit("first")
      const second = yield* admit("second")
      const third = yield* admit("third")

      yield* session.queue.reorder({ sessionID, messageIDs: [third.id, first.id, second.id] })
      const pending = yield* session.queue.list(sessionID)
      expect(pending.map((item) => item.prompt.text)).toEqual(["third", "first", "second"])
    }),
  )

  it.effect("promotes queued inputs in the reordered order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* admit("first")
      const second = yield* admit("second")
      yield* admit("third")

      yield* session.queue.reorder({ sessionID, messageIDs: [second.id] })

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const promoted = yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(promoted.map((item) => item.prompt.text)).toEqual(["second"])
      const remaining = yield* session.queue.list(sessionID)
      expect(remaining.map((item) => item.prompt.text)).toEqual(["first", "third"])
    }),
  )

  it.effect("promotes a specific queued input on sendNow and resumes execution", () =>
    Effect.gen(function* () {
      yield* setup
      resumeCalls.length = 0
      const session = yield* SessionV2.Service
      const first = yield* admit("first")
      const second = yield* admit("second")

      expect(yield* session.queue.sendNow({ sessionID, id: second.id })).toBe(true)
      expect(resumeCalls).toEqual([sessionID])

      const pending = yield* session.queue.list(sessionID)
      expect(pending.map((item) => item.prompt.text)).toEqual(["first"])
      const stored = yield* SessionInput.find((yield* Database.Service).db, second.id)
      expect(stored?.promotedSeq).toBeNumber()
      expect((yield* SessionInput.find((yield* Database.Service).db, first.id))?.promotedSeq).toBeUndefined()
    }),
  )

  it.effect("stores queue policy", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      expect(yield* session.queue.policy(sessionID)).toEqual({ autoDrain: true, followupMode: "queue" })

      yield* session.queue.setPolicy({ sessionID, autoDrain: false, followupMode: "guide" })
      expect(yield* session.queue.policy(sessionID)).toEqual({ autoDrain: false, followupMode: "guide" })
      expect((yield* session.get(sessionID)).queue).toEqual({ autoDrain: false, followupMode: "guide" })
    }),
  )
})
