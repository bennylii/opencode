import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SendMessageTool } from "@opencode-ai/core/tool/send-message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { it } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

const sender = SessionV2.ID.make("ses_send_sender")
const activeTarget = SessionV2.ID.make("ses_send_active")
const idleTarget = SessionV2.ID.make("ses_send_idle")

const wakeCalls: SessionV2.ID[] = []
const active = new Set<SessionV2.ID>()

describe("SendMessageTool", () => {
  it.live("steers an active target and resumes an idle target", () =>
    Effect.gen(function* () {
      wakeCalls.length = 0
      active.clear()
      active.add(activeTarget)

      const assertions: PermissionV2.AssertInput[] = []
      const permission = Layer.succeed(
        PermissionV2.Service,
        PermissionV2.Service.of({
          assert: (input) =>
            Effect.sync(() => {
              assertions.push(input)
            }),
          ask: () => Effect.die("unused"),
          reply: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          forSession: () => Effect.die("unused"),

          grant: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
        }),
      )
      const execution = Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.sync(() => new Set(active)),
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          wake: (sessionID) =>
            Effect.sync(() => {
              wakeCalls.push(sessionID)
            }),
        }),
      )

      const layer = AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          SessionProjector.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          SendMessageTool.node,
        ]),
        [
          [PermissionV2.node, permission],
          [SessionExecution.node, execution],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      )

      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        for (const id of [sender, activeTarget, idleTarget]) {
          yield* db
            .insert(SessionTable)
            .values({
              id,
              project_id: Project.ID.global,
              slug: "send-message",
              directory: "/project",
              title: "send-message",
              version: "test",
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
        }

        const registry = yield* ToolRegistry.Service

        const steered = yield* executeTool(registry, {
          sessionID: sender,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-active",
            name: "send_message",
            input: { to: activeTarget, summary: "notify active", message: "hello active" },
          },
        })
        expect(steered).toEqual({ type: "text", value: expect.stringContaining("delivered (steered)") })
        expect(wakeCalls).toEqual([activeTarget])

        const resumed = yield* executeTool(registry, {
          sessionID: sender,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-idle",
            name: "send_message",
            input: { to: idleTarget, summary: "resume idle", message: "hello idle" },
          },
        })
        expect(resumed).toEqual({ type: "text", value: expect.stringContaining("delivered (resumed_background)") })

        const rows = yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, activeTarget))
          .all()
          .pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.delivery).toBe("steer")

        const idleRows = yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, idleTarget))
          .all()
          .pipe(Effect.orDie)
        expect(idleRows[0]?.delivery).toBe("queue")

        expect(assertions).toMatchObject([
          { sessionID: sender, action: "send_message", resources: [activeTarget], save: [activeTarget] },
          { sessionID: sender, action: "send_message", resources: [idleTarget], save: [idleTarget] },
        ])

        const self = yield* executeTool(registry, {
          sessionID: sender,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-self",
            name: "send_message",
            input: { to: sender, summary: "self", message: "loop" },
          },
        })
        expect(self).toEqual({ type: "error", value: "send_message cannot target the current session" })
      }).pipe(Effect.provide(layer))
    }),
  )
})
