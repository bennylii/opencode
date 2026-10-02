export * as SessionInput from "./input"

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Admitted, Delivery, type Intent } from "@opencode-ai/schema/session-input"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export { Admitted, Delivery, type Intent }

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    ...(row.intent === null ? {} : { intent: row.intent }),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly intent?: Intent
  },
) {
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptAdmitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
      intent: input.intent,
    })
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              Admitted.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                intent: input.intent,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly intent?: Intent
    readonly timeCreated: DateTime.Utc
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      intent: input.intent ?? null,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly intent?: Intent
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      intent: input.intent ?? null,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly intent?: Intent
  },
) =>
  input.delivery === expected.delivery &&
  sameIntent(input.intent, expected.intent) &&
  matchesPrompt(input, expected)

function sameIntent(left: Intent | undefined, right: Intent | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly intent?: Intent
    readonly timeCreated: DateTime.Utc
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    const id = SessionMessage.ID.make(row.id)
    yield* events
      .publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(row.time_created),
        messageID: id,
        prompt: decodePrompt(row.prompt),
        delivery: row.delivery,
        intent: row.intent ?? undefined,
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, id).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(...queueOrder)
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? [] : yield* publish(db, events, sessionID, [row])
})

/** 待提升输入按显式 queue_position 优先、其余按 admission 顺序。 */
const queueOrder = [
  sql`${SessionInputTable.queue_position} IS NULL`,
  asc(SessionInputTable.queue_position),
  asc(SessionInputTable.admitted_seq),
] as const

export const listPending = Effect.fn("SessionInput.listPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, sessionID), isNull(SessionInputTable.promoted_seq)))
    .orderBy(...queueOrder)
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/** 仅允许修改未提升输入的文本；模型/计划/思考强度等属性在 admission 冻结。 */
export const editPrompt = Effect.fn("SessionInput.editPrompt")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly id: SessionMessage.ID; readonly prompt: Prompt },
) {
  const existing = yield* find(db, input.id)
  if (!existing || existing.sessionID !== input.sessionID || existing.promotedSeq !== undefined) return false
  yield* events.publish(SessionEvent.PromptEdited, {
    sessionID: input.sessionID,
    messageID: input.id,
    timestamp: yield* DateTime.now,
    prompt: input.prompt,
    delivery: existing.delivery,
    intent: existing.intent,
  })
  return true
})

export const removePrompt = Effect.fn("SessionInput.removePrompt")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly id: SessionMessage.ID },
) {
  const existing = yield* find(db, input.id)
  if (!existing || existing.sessionID !== input.sessionID || existing.promotedSeq !== undefined) return false
  yield* events.publish(SessionEvent.PromptRemoved, {
    sessionID: input.sessionID,
    messageID: input.id,
    timestamp: yield* DateTime.now,
  })
  return true
})

/** 以完整顺序重写待提升队列；未列出的输入保持原有相对顺序不变。 */
export const reorderQueue = Effect.fn("SessionInput.reorderQueue")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly messageIDs: ReadonlyArray<SessionMessage.ID> },
) {
  yield* events.publish(SessionEvent.PromptQueueReordered, {
    sessionID: input.sessionID,
    timestamp: yield* DateTime.now,
    messageIDs: input.messageIDs,
  })
})

/** 立即提升指定的排队输入（send queued now）。 */
export const promoteQueued = Effect.fn("SessionInput.promoteQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly id: SessionMessage.ID },
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return false
  yield* publish(db, events, input.sessionID, [row])
  return true
})

export const setQueuePolicy = Effect.fn("SessionInput.setQueuePolicy")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly autoDrain: boolean
    readonly followupMode: "queue" | "guide"
  },
) {
  yield* events.publish(SessionEvent.QueuePolicyChanged, {
    sessionID: input.sessionID,
    timestamp: yield* DateTime.now,
    autoDrain: input.autoDrain,
    followupMode: input.followupMode,
  })
})

export interface QueuePolicy {
  readonly autoDrain: boolean
  readonly followupMode: "queue" | "guide"
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = { autoDrain: true, followupMode: "queue" }

export const queuePolicy = Effect.fn("SessionInput.queuePolicy")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ auto: SessionTable.queue_auto_drain, mode: SessionTable.queue_followup_mode })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return DEFAULT_QUEUE_POLICY
  return {
    autoDrain: row.auto !== 0,
    followupMode: row.mode ?? "queue",
  } satisfies QueuePolicy
})
