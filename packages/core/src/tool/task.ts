export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { ProjectV2 } from "../project"
import { SessionCreate } from "../session/create"
import { SessionEvent } from "../session/event"
import { SessionExecution } from "../session/execution"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task"

const MAX_SUBAGENT_DEPTH = 1

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Resume a previous task by passing its session ID instead of creating a new child session.",
  }),
})

export const Output = Schema.Struct({
  status: Schema.Union([Schema.Literal("completed"), Schema.Literal("error")]),
  sessionId: Schema.String,
  parentSessionId: Schema.String,
  result: Schema.String,
})

export const description = [
  "Launch a new agent to handle complex, multi-step tasks autonomously.",
  "",
  "The task tool launches specialized agents (subprocesses) that autonomously handle complex tasks.",
  "Each agent type has specific capabilities and tools available to it.",
  "",
  "When a task is described, it should be executed using this tool rather than doing the work inline.",
  "The result of the task is returned when the subagent finishes.",
].join("\n")

function contentText(content: ReadonlyArray<{ type: string; [key: string]: unknown }>) {
  return content
    .flatMap((item) => (item.type === "text" && typeof item["text"] === "string" ? [item["text"]] : []))
    .join("\n")
    .trim()
}

function taskOutput(input: { status: "completed" | "error"; sessionId: string; result: string }) {
  const body =
    input.status === "completed"
      ? `<task_result>\n${input.result}\n</task_result>`
      : `<task_error>\n${input.result}\n</task_error>`
  return `<task id="${input.sessionId}" state="${input.status}">\n${body}\n</task>`
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const permission = yield* PermissionV2.Service
    const agents = yield* AgentV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) =>
            [{ type: "text", text: `${input.description}\n${taskOutput(output)}` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* store.get(context.sessionID)
              if (!parent) return yield* new ToolFailure({ message: `Session not found: ${context.sessionID}` })
              let depth = 0
              let ancestor = parent
              while (ancestor.parentID && depth < MAX_SUBAGENT_DEPTH + 1) {
                depth += 1
                const next = yield* store.get(ancestor.parentID)
                if (!next) break
                ancestor = next
              }
              if (depth >= MAX_SUBAGENT_DEPTH)
                return yield* new ToolFailure({ message: "Subagents cannot spawn further subagents" })

              const agent = yield* agents.get(AgentV2.ID.make(input.subagent_type))
              if (!agent) return yield* new ToolFailure({ message: `Unknown agent: ${input.subagent_type}` })

              yield* permission.assert({
                action: name,
                resources: [input.subagent_type],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const assistant = yield* store.message(context.assistantMessageID)
              const model =
                agent.model ??
                (assistant?.message.type === "assistant" ? assistant.message.model : undefined) ??
                parent.model

              const existing = input.task_id ? yield* store.get(SessionSchema.ID.make(input.task_id)) : undefined
              if (input.task_id && !existing)
                return yield* new ToolFailure({ message: `Task session not found: ${input.task_id}` })
              if (existing && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Task session does not belong to this session: ${input.task_id}`,
                })

              const child =
                existing ??
                (yield* SessionCreate.create(
                  {
                    location: parent.location,
                    parentID: context.sessionID,
                    agent: agent.id,
                    title: `${input.description} (@${agent.id} subagent)`,
                    ...(model ? { model } : {}),
                  },
                  { database, events, projects, store },
                ))

              yield* events.publish(SessionEvent.Tool.Progress, {
                sessionID: context.sessionID,
                timestamp: yield* DateTime.now,
                assistantMessageID: context.assistantMessageID,
                callID: context.toolCallID,
                structured: {
                  parentSessionId: context.sessionID,
                  sessionId: child.id,
                  ...(model ? { model } : {}),
                },
                content: [],
              })

              yield* SessionInput.admit(database.db, events, {
                id: SessionMessage.ID.create(),
                sessionID: child.id,
                prompt: Prompt.make({ text: input.prompt }),
                delivery: "steer",
              }).pipe(Effect.orDie)
              yield* execution.wake(child.id)
              yield* execution.await(child.id).pipe(
                Effect.onInterrupt(() => execution.interrupt(child.id).pipe(Effect.ignore)),
              )

              const messages = yield* store.runnerContext(child.id, 0).pipe(Effect.orDie)
              const last = messages.findLast((message) => message.type === "assistant")
              if (last?.type === "assistant" && last.error)
                return {
                  status: "error" as const,
                  sessionId: child.id,
                  parentSessionId: context.sessionID,
                  result: last.error.message,
                }
              const result = last?.type === "assistant" ? contentText(last.content) : ""
              return {
                status: "completed" as const,
                sessionId: child.id,
                parentSessionId: context.sessionID,
                result: result || "Task completed with no output.",
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
  name: "tool/task",
  layer,
  deps: [
    ToolRegistry.node,
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionStore.node,
    SessionExecution.node,
    PermissionV2.node,
    AgentV2.node,
  ],
})
