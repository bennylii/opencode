import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { PlanExitTool } from "@opencode-ai/core/tool/plan"
import { PlanItemsTool } from "@opencode-ai/core/tool/plan-items"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_plan_tool_test")
const grants: PermissionV2.GrantInput[] = []
let answer = "Yes"

const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: () => Effect.succeed([[answer]]),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    grant: (input) =>
      Effect.sync(() => {
        grants.push(input)
      }),
  }),
)

const sessionInfo = (directory: string) =>
  SessionV2.Info.make({
    id: sessionID,
    projectID: Project.ID.global,
    title: "plan",
    slug: "plan-tool-test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
  })

const sessions = (directory: string) =>
  Layer.succeed(
    SessionStore.Service,
    SessionStore.Service.of({
      get: () => Effect.succeed(sessionInfo(directory)),
      context: () => Effect.die("unused"),
      runnerContext: () => Effect.die("unused"),
      message: () => Effect.die("unused"),
    }),
  )

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(directory), vcs: { type: "git", store: AbsolutePath.make(directory) } },
      ),
    ),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          EventV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          PlanExitTool.node,
          PlanItemsTool.node,
        ]),
        [
          [Location.node, activeLocation],
          [SessionStore.node, sessions(directory)],
          [QuestionV2.node, question],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (name: string, input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const withTmp = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("plan tools", () => {
  it.effect("registers plan_exit, plan_status and plan_update", () =>
    withTmp((directory) =>
      withTool(directory, (registry) =>
        Effect.gen(function* () {
          const names = (yield* toolDefinitions(registry)).map((definition) => definition.name)
          expect(names.toSorted()).toEqual(["plan_exit", "plan_status", "plan_update"].toSorted())
        }),
      ),
    ),
  )

  it.effect("plan_exit writes the plan, pre-approves prompts and switches to build", () =>
    withTmp((directory) => {
      grants.length = 0
      answer = "Yes"
      return withTool(directory, (registry) =>
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          const types: string[] = []
          const unsubscribe = yield* events.listen((event) =>
            Effect.sync(() => {
              types.push(event.type)
            }),
          )
          yield* Effect.addFinalizer(() => unsubscribe)

          const result = yield* executeTool(
            registry,
            call("plan_exit", {
              plan: "- [ ] first task\n- [x] second task",
              allowedPrompts: [{ permission: "bash", pattern: "npm test*" }],
            }),
          )
          expect(result).toEqual({
            type: "text",
            value: "User approved switching to build agent. Wait for further instructions.",
          })

          expect(grants).toEqual([
            {
              sessionID,
              rules: [{ action: "bash", resource: "npm test*", effect: "allow" }],
            },
          ])
          expect(types).toContain("session.next.agent.switched")
          expect(types).toContain("session.next.synthetic")

          const file = path.join(directory, ".opencode", "plans", "0-plan-tool-test.md")
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("- [ ] first task\n- [x] second task\n")
        }),
      )
    }),
  )

  it.effect("plan_exit rejects when the user declines and skips grants", () =>
    withTmp((directory) => {
      grants.length = 0
      answer = "No"
      return withTool(directory, (registry) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            executeTool(registry, call("plan_exit", { plan: "- [ ] first task", allowedPrompts: [] })),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit))
            expect(
              exit.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError,
              ),
            ).toBe(true)
          expect(grants).toEqual([])
        }),
      )
    }),
  )

  it.effect("plan_update requires evidence and plan_status reports progress", () =>
    withTmp((directory) =>
      withTool(directory, (registry) =>
        Effect.gen(function* () {
          const dir = path.join(directory, ".opencode", "plans")
          const file = path.join(dir, "0-plan-tool-test.md")
          yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(file, "- [ ] first task\n- [ ] second task\n"))

          const rejected = yield* executeTool(registry, call("plan_update", { item: "first task", status: "done" }))
          expect(rejected).toEqual({
            type: "error",
            value: "Marking a plan item done requires verification evidence",
          })

          const updated = yield* executeTool(
            registry,
            call("plan_update", { item: "first task", status: "done", evidence: "npm test passed" }),
          )
          expect(updated.type).toBe("text")
          if (updated.type === "text") expect(updated.value).toContain('Marked "first task" as done.')
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("- [x] first task\n  - Evidence: npm test passed")

          const status = yield* executeTool(registry, call("plan_status", {}))
          expect(status.type).toBe("text")
          if (status.type === "text") {
            expect(status.value).toContain("Plan progress: 1/2 done, 1 pending, 0 blocked")
            expect(status.value).toContain("Next item: second task")
          }
        }),
      ),
    ),
  )
})
