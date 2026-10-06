import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { it } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const parent = SessionV2.ID.make("ses_task_parent")
const childModel = { id: ModelV2.ID.make("child-model"), providerID: ProviderV2.ID.make("fake") }
const subagent = {
  id: AgentV2.ID.make("general"),
  model: childModel,
  request: { headers: {}, body: {} },
  mode: "subagent" as const,
  hidden: false,
  permissions: [],
}

describe("TaskTool", () => {
  it.live("creates a child session, waits for it and returns the result", () =>
    Effect.gen(function* () {
      const wakes: SessionV2.ID[] = []
      const assertions: PermissionV2.AssertInput[] = []
      const permission = Layer.mock(PermissionV2.Service, {
        assert: (input) =>
          Effect.sync(() => {
            assertions.push(input)
          }),
      })
      const agents = Layer.mock(AgentV2.Service, {
        get: (id) => Effect.succeed(id === subagent.id ? subagent : undefined),
      })
      const execution = Layer.unwrap(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return Layer.succeed(
            SessionExecution.Service,
            SessionExecution.Service.of({
              active: Effect.succeed(new Set<SessionV2.ID>()),
              resume: () => Effect.void,
              wake: (sessionID) =>
                Effect.sync(() => {
                  wakes.push(sessionID)
                }),
              await: (sessionID) =>
                db
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.create(),
                    session_id: sessionID,
                    type: "assistant",
                    seq: 100 + wakes.length,
                    time_created: 1,
                    data: {
                      agent: "general",
                      model: { id: "child-model", providerID: "fake" },
                      content: [{ type: "text", id: "content-1", text: "child result" }],
                      time: { created: 1 },
                    },
                  } as typeof SessionMessageTable.$inferInsert)
                  .run()
                  .pipe(Effect.orDie, Effect.asVoid),
              interrupt: () => Effect.void,
            }),
          )
        }),
      )
      const projects = Layer.succeed(
        Project.Service,
        Project.Service.of({
          directories: () => Effect.succeed([]),
          resolve: () => Effect.succeed({ id: Project.ID.global, directory: AbsolutePath.make("/project"), vcs: undefined }),
          commit: () => Effect.void,
        }),
      )

      const layer = AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          SessionProjector.node,
          SessionStore.node,
          Project.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          TaskTool.node,
        ]),
        [
          [PermissionV2.node, permission],
          [AgentV2.node, agents],
          [SessionExecution.node, execution],
          [Project.node, projects],
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
        yield* db
          .insert(SessionTable)
          .values({
            id: parent,
            project_id: Project.ID.global,
            slug: "task",
            directory: "/project",
            title: "task",
            version: "test",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID: parent,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-task",
            name: "task",
            input: { description: "do work", prompt: "work", subagent_type: "general" },
          },
        })
        expect(result).toEqual({ type: "text", value: expect.stringContaining("child result") })
        expect(assertions).toMatchObject([
          { sessionID: parent, action: "task", resources: ["general"], save: ["*"] },
        ])

        const children = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, parent))
          .all()
          .pipe(Effect.orDie)
        expect(children).toHaveLength(1)
        const child = children[0]!
        expect(child.agent).toBe("general")
        expect(child.model).toMatchObject({ id: "child-model", providerID: "fake" })
        expect(wakes).toEqual([child.id])

        const inputs = yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, child.id))
          .all()
          .pipe(Effect.orDie)
        expect(inputs).toHaveLength(1)
        expect(inputs[0]?.prompt).toMatchObject({ text: "work" })

        const nested = yield* executeTool(registry, {
          sessionID: child.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-nested",
            name: "task",
            input: { description: "nested", prompt: "nested work", subagent_type: "general" },
          },
        })
        expect(nested).toEqual({ type: "error", value: "Subagents cannot spawn further subagents" })

        const resumed = yield* executeTool(registry, {
          sessionID: parent,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-resume",
            name: "task",
            input: { description: "resume", prompt: "more work", subagent_type: "general", task_id: child.id },
          },
        })
        expect(resumed).toEqual({ type: "text", value: expect.stringContaining("child result") })
        const after = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, parent))
          .all()
          .pipe(Effect.orDie)
        expect(after).toHaveLength(1)

        const unknown = yield* executeTool(registry, {
          sessionID: parent,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-unknown",
            name: "task",
            input: { description: "unknown", prompt: "work", subagent_type: "missing" },
          },
        })
        expect(unknown).toEqual({ type: "error", value: "Unknown agent: missing" })
      }).pipe(Effect.provide(layer))
    }),
  )
})
