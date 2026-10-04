import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_shell_test")
const commands: string[] = []

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<SessionV2.ID>()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)

const processLayer = Layer.mock(AppProcess.Service, {
  run: (command) =>
    Effect.sync(() => {
      commands.push(command._tag === "StandardCommand" ? command.command : "piped")
      return {
        command: "echo hi",
        exitCode: 0,
        stdout: Buffer.from("hi\n"),
        stderr: Buffer.alloc(0),
        output: Buffer.from("hi\n"),
        stdoutTruncated: false,
        stderrTruncated: false,
      }
    }),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [SessionExecution.node, execution],
      [AppProcess.node, processLayer],
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
})

describe("SessionV2.shell", () => {
  it.effect("executes a command and records a completed shell message", () =>
    Effect.gen(function* () {
      yield* setup
      commands.length = 0
      const session = yield* SessionV2.Service
      yield* session.shell({ sessionID, command: "echo hi" })

      expect(commands).toEqual(["echo hi"])
      const context = yield* SessionStore.Service.use((store) => store.context(sessionID))
      const message = context.at(-1)
      expect(message?.type).toBe("shell")
      if (message?.type === "shell") {
        expect(message.command).toBe("echo hi")
        expect(message.output).toBe("hi\n")
        expect(message.time.completed).toBeDefined()
      }
    }),
  )

  it.effect("rejects an unknown session", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const error = yield* session.shell({ sessionID: SessionV2.ID.make("ses_missing"), command: "echo hi" }).pipe(
        Effect.flip,
      )
      expect(error._tag).toBe("Session.NotFoundError")
    }),
  )
})
