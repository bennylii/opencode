export * as PlanItemsTool from "./plan-items"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PlanFile } from "../session/plan-file"
import { PlanItems } from "../session/plan-items"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const statusName = "plan_status"
export const updateName = "plan_update"

const PlanStatus = Schema.Literals(["pending", "done", "blocked"])

export const StatusInput = Schema.Struct({})
export type StatusInput = typeof StatusInput.Type

export const StatusOutput = Schema.Struct({
  total: Schema.Finite,
  pending: Schema.Finite,
  done: Schema.Finite,
  blocked: Schema.Finite,
  next: Schema.String.pipe(Schema.optional),
  output: Schema.String,
})
export type StatusOutput = typeof StatusOutput.Type

export const UpdateInput = Schema.Struct({
  item: Schema.String.annotate({ description: "Exact text of the plan checkbox item to update" }),
  status: PlanStatus.annotate({ description: "New status for the item" }),
  evidence: Schema.String.pipe(Schema.optional).annotate({
    description: "Verification evidence required for status=done, e.g. the test command and its result",
  }),
  note: Schema.String.pipe(Schema.optional).annotate({ description: "Optional reason, e.g. why the item is blocked" }),
})
export type UpdateInput = typeof UpdateInput.Type

export const UpdateOutput = Schema.Struct({
  item: Schema.String,
  status: PlanStatus,
  total: Schema.Finite,
  pending: Schema.Finite,
  done: Schema.Finite,
  blocked: Schema.Finite,
  output: Schema.String,
})
export type UpdateOutput = typeof UpdateOutput.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const fsys = yield* FSUtil.Service

    const readPlan = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new ToolFailure({ message: `Session not found: ${sessionID}` })
      const file = PlanFile.planFile(session, location)
      const content = yield* fsys.readFileStringSafe(file).pipe(Effect.orDie)
      if (!content || !content.trim()) return yield* new ToolFailure({ message: `No plan file at ${file}` })
      return { file, content }
    })

    yield* tools
      .register({
        [statusName]: Tool.make({
          description:
            "Read the current plan file and report checkbox item progress (pending/done/blocked) with the next item.",
          input: StatusInput,
          output: StatusOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (_input, context) =>
            Effect.gen(function* () {
              const { content } = yield* readPlan(context.sessionID)
              const progress = PlanItems.planProgress(content)
              return {
                total: progress.total,
                pending: progress.pending.length,
                done: progress.done.length,
                blocked: progress.blocked.length,
                next: progress.next?.text,
                output: PlanItems.renderPlanProgress(progress),
              }
            }),
        }),
        [updateName]: Tool.make({
          description: [
            "Update one plan checkbox item in the plan file.",
            "",
            "Marking an item done requires verification evidence (the exact command and its result).",
            "Use plan_status first to read the exact item text.",
          ].join("\n"),
          input: UpdateInput,
          output: UpdateOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const { file, content } = yield* readPlan(context.sessionID)
              const updated = yield* Effect.try({
                try: () =>
                  PlanItems.updatePlanItem({
                    content,
                    item: input.item,
                    status: input.status,
                    evidence: input.evidence,
                    note: input.note,
                  }),
                catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
              })
              yield* fsys.writeWithDirs(file, updated.content).pipe(Effect.orDie)
              const progress = PlanItems.planProgress(updated.content)
              return {
                item: updated.item.text,
                status: updated.item.status,
                total: progress.total,
                pending: progress.pending.length,
                done: progress.done.length,
                blocked: progress.blocked.length,
                output: [
                  `Marked "${updated.item.text}" as ${updated.item.status}.`,
                  ...(input.evidence?.trim() ? [`Evidence: ${input.evidence.trim()}`] : []),
                  "",
                  PlanItems.renderPlanProgress(progress),
                ].join("\n"),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan-items",
  layer,
  deps: [ToolRegistry.node, SessionStore.node, Location.node, FSUtil.node],
})
