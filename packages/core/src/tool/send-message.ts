export * as SendMessageTool from "./send-message"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionExecution } from "../session/execution"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "send_message"

export const Input = Schema.Struct({
  to: Schema.String.annotate({
    description: "Target session ID (ses_...) of the agent or background session to message.",
  }),
  summary: Schema.String.annotate({ description: "A 5-10 word summary shown as a preview." }),
  message: Schema.String.annotate({ description: "Plain text message content." }),
  delivery: Schema.optional(Schema.Union([Schema.Literal("steer"), Schema.Literal("queue")])).annotate({
    description:
      "Delivery mode for an active target: steer injects at the next safe provider boundary, queue waits until idle. Omitted defaults to steer for active targets.",
  }),
})

export const Output = Schema.Struct({
  status: Schema.Union([Schema.Literal("success"), Schema.Literal("failed")]),
  messageId: Schema.String,
  to: Schema.String,
  delivery: Schema.Union([Schema.Literal("queued"), Schema.Literal("steered"), Schema.Literal("resumed_background")]),
})

export const description = [
  "Send a message to another session, including background subagent sessions.",
  "",
  "Use this to notify, steer, or resume other agents. When the target is active the message is delivered as a",
  "steer or queued input; when it is idle, sending resumes it as a background turn.",
  "",
  "Do not send a message to the current session; use normal output instead.",
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) =>
            output.status === "success"
              ? [{ type: "text", text: `Message ${output.messageId} delivered (${output.delivery})` }]
              : [{ type: "text", text: `Unable to deliver message to ${output.to}` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.to === context.sessionID)
                return yield* new ToolFailure({ message: "send_message cannot target the current session" })
              if (!input.message.trim())
                return yield* new ToolFailure({ message: "send_message requires non-empty message text" })
              const target = SessionSchema.ID.make(input.to)
              yield* permission.assert({
                action: name,
                resources: [input.to],
                save: [input.to],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const active = (yield* execution.active).has(target)
              const delivery = active ? (input.delivery ?? "steer") : "queue"
              const messageID = SessionMessage.ID.create()
              yield* SessionInput.admit(database.db, events, {
                id: messageID,
                sessionID: target,
                prompt: Prompt.make({ text: input.message }),
                delivery,
              }).pipe(Effect.orDie)
              yield* execution.wake(target).pipe(Effect.orDie)
              return {
                status: "success" as const,
                messageId: messageID,
                to: input.to,
                delivery: active
                  ? delivery === "steer"
                    ? ("steered" as const)
                    : ("queued" as const)
                  : ("resumed_background" as const),
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: error instanceof Error ? error.message : String(error),
                      error,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/send-message",
  layer,
  deps: [ToolRegistry.node, Database.node, EventV2.node, SessionExecution.node, PermissionV2.node],
})
