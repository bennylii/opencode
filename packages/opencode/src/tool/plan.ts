import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({
  plan: Schema.optional(Schema.String).annotate({
    description: "Final plan markdown. When provided it is written to the plan file before approval.",
  }),
  allowedPrompts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        permission: Schema.String,
        pattern: Schema.String,
      }),
    ),
  ).annotate({
    description:
      'Concrete permission rules to pre-approve for execution, e.g. { permission: "bash", pattern: "npm test*" }.',
  }),
})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const absolute = Session.plan(info, instance)

          if (params.plan !== undefined) {
            if (!params.plan.trim()) throw new Error("plan_exit requires a non-empty plan")
            yield* fsys
              .writeWithDirs(absolute, params.plan.endsWith("\n") ? params.plan : `${params.plan}\n`)
              .pipe(Effect.orDie)
          }
          const content = yield* fsys.readFileStringSafe(absolute).pipe(Effect.orDie)
          if (!content || !content.trim())
            throw new Error(`Plan file is empty: ${plan}. Write the plan before exiting plan mode.`)

          const allowed = params.allowedPrompts ?? []
          if (allowed.length > 0) {
            yield* permission
              .grant(allowed.map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: "allow" as const })))
              .pipe(Effect.orDie)
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: [
              `The plan at ${plan} has been approved, you can now edit files. Execute the plan.`,
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
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
