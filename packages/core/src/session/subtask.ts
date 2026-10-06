export * as SessionSubtask from "./subtask"

import { DateTime, Effect } from "effect"
import type { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import type { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { SessionCreate } from "./create"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import type { RunError } from "./runner"

export type Deps = {
  database: Database.Interface
  events: EventV2.Interface
  projects: ProjectV2.Interface
  store: SessionStore.Interface
  /** Drain the child session to completion in the caller's fiber. */
  drain: (sessionID: SessionSchema.ID) => Effect.Effect<void, RunError>
}

export type Input = {
  parentSessionID: SessionSchema.ID
  sessionID?: SessionSchema.ID
  agent: AgentV2.ID
  description: string
  prompt: string
  model?: ModelV2.Ref
  progress?: {
    assistantMessageID: SessionMessage.ID
    callID: string
  }
}

export type Result = {
  status: "completed" | "error"
  sessionId: SessionSchema.ID
  result: string
}

function contentText(content: ReadonlyArray<{ type: string; [key: string]: unknown }>) {
  return content
    .flatMap((item) => (item.type === "text" && typeof item["text"] === "string" ? [item["text"]] : []))
    .join("\n")
    .trim()
}

export function taskOutput(input: { status: "completed" | "error"; sessionId: string; result: string }) {
  const body =
    input.status === "completed"
      ? `<task_result>\n${input.result}\n</task_result>`
      : `<task_error>\n${input.result}\n</task_error>`
  return `<task id="${input.sessionId}" state="${input.status}">\n${body}\n</task>`
}

/**
 * Run one foreground subagent turn: create (or resume) the child session,
 * admit the prompt, wait for the child drain and read its final assistant
 * output. Callers own permission, depth and result-event publication.
 */
export const run = Effect.fn("SessionSubtask.run")(function* (input: Input, deps: Deps) {
  const parent = yield* deps.store.get(input.parentSessionID)
  if (!parent) return yield* Effect.die(`Session not found: ${input.parentSessionID}`)
  const child = input.sessionID
    ? yield* deps.store.get(input.sessionID).pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.die(`Task session not found: ${input.sessionID}`),
        ),
      )
    : yield* SessionCreate.create(
        {
          location: parent.location,
          parentID: parent.id,
          agent: input.agent,
          title: `${input.description} (@${input.agent} subagent)`,
          ...(input.model ? { model: input.model } : {}),
        },
        deps,
      )

  if (input.progress)
    yield* deps.events.publish(SessionEvent.Tool.Progress, {
      sessionID: input.parentSessionID,
      timestamp: yield* DateTime.now,
      assistantMessageID: input.progress.assistantMessageID,
      callID: input.progress.callID,
      structured: {
        parentSessionId: input.parentSessionID,
        sessionId: child.id,
        ...(input.model ? { model: input.model } : {}),
      },
      content: [],
    })

  yield* SessionInput.admit(deps.database.db, deps.events, {
    id: SessionMessage.ID.create(),
    sessionID: child.id,
    prompt: Prompt.make({ text: input.prompt }),
    delivery: "steer",
  }).pipe(Effect.orDie)
  yield* deps.drain(child.id)

  const messages = yield* deps.store.runnerContext(child.id, 0).pipe(Effect.orDie)
  const last = messages.findLast((message) => message.type === "assistant")
  if (last?.type === "assistant" && last.error)
    return { status: "error" as const, sessionId: child.id, result: last.error.message }
  const result = last?.type === "assistant" ? contentText(last.content) : ""
  return {
    status: "completed" as const,
    sessionId: child.id,
    result: result || "Task completed with no output.",
  }
})
