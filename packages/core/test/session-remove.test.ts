import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_remove_test")

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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [SessionExecution.node, execution],
      [AppProcess.node, Layer.mock(AppProcess.Service, {})],
    ],
  ),
)

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
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.AgentSwitched, {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    agent: "build",
  })
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.create(),
      session_id: sessionID,
      type: "synthetic",
      seq: 100,
      time_created: 1,
      data: { sessionID, text: "hello", time: { created: 1 } },
    } as typeof SessionMessageTable.$inferInsert)
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: SessionMessage.ID.create(),
      session_id: sessionID,
      prompt: { text: "queued" },
      delivery: "queue",
      admitted_seq: 101,
      time_created: 1,
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionV2.remove", () => {
  it.effect("deletes the session, projections and durable history", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const types: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          types.push(event.type)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const session = yield* SessionV2.Service
      yield* session.remove(sessionID)

      expect(types).toContain("session.deleted")
      const { db } = yield* Database.Service
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all()).toEqual([])
      expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).all()).toEqual([])
      expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all()).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).all()).toEqual([])

      const error = yield* session.remove(sessionID).pipe(Effect.flip)
      expect(error._tag).toBe("Session.NotFoundError")
    }),
  )
})
