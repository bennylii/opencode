export * as PlanExitTool from "./plan"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { PlanFile } from "../session/plan-file"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_exit"

export const description = [
  "Exit plan mode by presenting the final plan for approval.",
  "",
  "Provide the complete plan markdown when it changed; it is written to the plan file before approval.",
  "Optionally list concrete permission rules the execution will need so they can be pre-approved.",
].join("\n")

export const Input = Schema.Struct({
  plan: Schema.String.pipe(Schema.optional).annotate({
    description: "Final plan markdown. When provided it is written to the plan file before approval.",
  }),
  allowedPrompts: Schema.Array(Schema.Struct({ permission: Schema.String, pattern: Schema.String }))
    .pipe(Schema.optional)
    .annotate({
      description:
        'Concrete permission rules to pre-approve for execution, e.g. { permission: "bash", pattern: "npm test*" }.',
    }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const fsys = yield* FSUtil.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const session = yield* sessions.get(context.sessionID)
                if (!session) return yield* new ToolFailure({ message: `Session not found: ${context.sessionID}` })
                const file = PlanFile.planFile(session, location)
                const relative = path.relative(location.project.directory, file)

                if (input.plan !== undefined) {
                  if (!input.plan.trim())
                    return yield* new ToolFailure({ message: "plan_exit requires a non-empty plan" })
                  yield* fsys
                    .writeWithDirs(file, input.plan.endsWith("\n") ? input.plan : `${input.plan}\n`)
                    .pipe(Effect.orDie)
                }
                const content = yield* fsys.readFileStringSafe(file).pipe(Effect.orDie)
                if (!content || !content.trim())
                  return yield* new ToolFailure({
                    message: `Plan file is empty: ${relative}. Write the plan before exiting plan mode.`,
                  })

                const allowed = input.allowedPrompts ?? []
                if (allowed.length > 0)
                  yield* permission
                    .grant({
                      sessionID: context.sessionID,
                      rules: allowed.map((rule) => ({
                        action: rule.permission,
                        resource: rule.pattern,
                        effect: "allow" as const,
                      })),
                    })
                    .pipe(Effect.orDie)

                const answers = yield* question
                  .ask({
                    sessionID: context.sessionID,
                    questions: [
                      {
                        question: `Plan at ${relative} is complete. Would you like to switch to the build agent and start implementing?`,
                        header: "Build Agent",
                        custom: false,
                        options: [
                          { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                          { label: "No", description: "Stay with plan agent to continue refining the plan" },
                        ],
                      },
                    ],
                    tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(Effect.orDie)

                if (answers[0]?.[0] === "No") yield* Effect.die(new QuestionV2.RejectedError())

                yield* events.publish(SessionEvent.AgentSwitched, {
                  sessionID: context.sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  agent: "build",
                })
                yield* events.publish(SessionEvent.Synthetic, {
                  sessionID: context.sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  text: [
                    `The plan at ${relative} has been approved, you can now edit files. Execute the plan.`,
                    "Work through the plan items in order. After each item, run its verification and mark it done with",
                    "evidence using plan_update; use plan_status to check remaining items.",
                    ...(allowed.length > 0
                      ? [
                          `Pre-approved permissions: ${allowed
                            .map((rule) => `${rule.permission}: ${rule.pattern}`)
                            .join(", ")}`,
                        ]
                      : []),
                  ].join("\n"),
                })

                return { output: "User approved switching to build agent. Wait for further instructions." }
              }),
          }),
          "plan_exit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan",
  layer,
  deps: [
    ToolRegistry.node,
    SessionStore.node,
    Location.node,
    FSUtil.node,
    QuestionV2.node,
    PermissionV2.node,
    EventV2.node,
  ],
})
