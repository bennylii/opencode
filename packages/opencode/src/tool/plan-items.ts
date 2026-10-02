import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { PlanItems } from "@/session/plan-items"

const PlanStatus = Schema.Literals(["pending", "done", "blocked"])

export const PlanStatusTool = Tool.define(
  "plan_status",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const fsys = yield* FSUtil.Service

    return {
      description:
        "Read the current plan file and report checkbox item progress (pending/done/blocked) with the next item.",
      parameters: Schema.Struct({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const file = Session.plan(info, instance)
          const content = yield* fsys.readFileStringSafe(file).pipe(Effect.orDie)
          if (!content || !content.trim())
            throw new Error(`No plan file at ${path.relative(instance.worktree, file)}`)
          const progress = PlanItems.planProgress(content)
          return {
            title: "Plan status",
            output: PlanItems.renderPlanProgress(progress),
            metadata: {
              total: progress.total,
              pending: progress.pending.length,
              done: progress.done.length,
              blocked: progress.blocked.length,
              next: progress.next?.text,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const PlanUpdateParameters = Schema.Struct({
  item: Schema.String.annotate({ description: "Exact text of the plan checkbox item to update" }),
  status: PlanStatus.annotate({ description: "New status for the item" }),
  evidence: Schema.optional(Schema.String).annotate({
    description: "Verification evidence required for status=done, e.g. the test command and its result",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Optional reason, e.g. why the item is blocked",
  }),
})

export const PlanUpdateTool = Tool.define(
  "plan_update",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const fsys = yield* FSUtil.Service

    return {
      description: [
        "Update one plan checkbox item in the plan file.",
        "",
        "Marking an item done requires verification evidence (the exact command and its result).",
        "Use plan_status first to read the exact item text.",
      ].join("\n"),
      parameters: PlanUpdateParameters,
      execute: (params: Schema.Schema.Type<typeof PlanUpdateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const file = Session.plan(info, instance)
          const content = yield* fsys.readFileStringSafe(file).pipe(Effect.orDie)
          if (!content || !content.trim())
            throw new Error(`No plan file at ${path.relative(instance.worktree, file)}`)
          const updated = PlanItems.updatePlanItem({
            content,
            item: params.item,
            status: params.status,
            evidence: params.evidence,
            note: params.note,
          })
          yield* fsys.writeWithDirs(file, updated.content).pipe(Effect.orDie)
          const progress = PlanItems.planProgress(updated.content)
          return {
            title: "Plan item updated",
            output: [
              `Marked "${updated.item.text}" as ${updated.item.status}.`,
              ...(params.evidence?.trim() ? [`Evidence: ${params.evidence.trim()}`] : []),
              "",
              PlanItems.renderPlanProgress(progress),
            ].join("\n"),
            metadata: {
              item: updated.item.text,
              status: updated.item.status,
              pending: progress.pending.length,
              blocked: progress.blocked.length,
              done: progress.done.length,
              total: progress.total,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
