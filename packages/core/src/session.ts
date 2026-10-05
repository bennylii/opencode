export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Duration, Effect, Layer, Schema, Context, Stream } from "effect"
import { pathToFileURL } from "url"
import { ChildProcess } from "effect/unstable/process"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, lte, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { EventSequenceTable } from "./event/sql"
import { Global } from "./global"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow, toV1Info } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { CommandTemplate } from "./session/command-template"
import { CommandV2 } from "./command"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { File } from "./file"
import { AppProcess } from "./process"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  title?: string
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class CommandNotFoundError extends Schema.TaggedErrorClass<CommandNotFoundError>()(
  "Session.CommandNotFoundError",
  {
    command: Schema.String,
  },
) {
  override get message() {
    return `Command not found: ${this.command}`
  }
}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly fork: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly update: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly diff: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
  }) => Effect.Effect<File.Diff[], NotFoundError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    intent?: SessionInput.Intent
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    arguments?: string
    agent?: AgentV2.ID
    model?: ModelV2.Ref
    files?: NonNullable<typeof PromptInput.Prompt.Type["files"]>
  }) => Effect.Effect<void, NotFoundError | CommandNotFoundError>
  readonly queue: {
    readonly list: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<ReadonlyArray<SessionInput.Admitted>, NotFoundError>
    readonly edit: (input: {
      sessionID: SessionSchema.ID
      id: SessionMessage.ID
      text: string
    }) => Effect.Effect<boolean, NotFoundError>
    readonly remove: (input: {
      sessionID: SessionSchema.ID
      id: SessionMessage.ID
    }) => Effect.Effect<boolean, NotFoundError>
    readonly reorder: (input: {
      sessionID: SessionSchema.ID
      messageIDs: ReadonlyArray<SessionMessage.ID>
    }) => Effect.Effect<void, NotFoundError>
    readonly sendNow: (input: {
      sessionID: SessionSchema.ID
      id: SessionMessage.ID
    }) => Effect.Effect<boolean, NotFoundError>
    readonly policy: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInput.QueuePolicy, NotFoundError>
    readonly setPolicy: (input: {
      sessionID: SessionSchema.ID
      autoDrain: boolean
      followupMode: "queue" | "guide"
    }) => Effect.Effect<void, NotFoundError>
  }
  readonly shell: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")
const MAX_SHELL_CAPTURE_BYTES = 1024 * 1024

function getForkedTitle(title: string) {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return `${match[1]} (fork #${parseInt(match[2]!, 10) + 1})`
  return `${title} (fork #1)`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const appProcess = yield* AppProcess.Service
    const fsys = yield* FSUtil.Service
    const locations = yield* LocationServiceMap.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: input.title ?? `New session - ${new Date(now).toISOString()}`,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // V2 创建标记 durable runtime，legacy 行保持默认 v1。
        yield* db
          .update(SessionTable)
          .set({ runtime: "v2" })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const source = yield* result.get(input.sessionID)
        const cutoff = input.messageID
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.id, input.messageID),
                  eq(SessionMessageTable.session_id, source.id),
                ),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.messageID && !cutoff)
          return yield* new MessageNotFoundError({ sessionID: source.id, messageID: input.messageID })
        const created = yield* result.create({
          location: source.location,
          agent: source.agent,
          model: source.model,
          title: getForkedTitle(source.title),
        })
        // 消息表主键是全局的，fork 必须为复制出的消息分配新 ID。
        const messages = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, source.id), cutoff ? lte(SessionMessageTable.seq, cutoff.seq) : undefined),
          )
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        for (const row of messages) {
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.create(),
              session_id: created.id,
              type: row.type,
              seq: row.seq,
              time_created: row.time_created,
              data: row.type === "synthetic" ? { ...row.data, sessionID: created.id } : row.data,
            } as typeof SessionMessageTable.$inferInsert)
            .run()
            .pipe(Effect.orDie)
        }
        // TODO: Fork the durable event history once replay can remap message IDs.
        // Advance the aggregate sequence so post-fork events append after copied messages.
        const latest = messages.at(-1)?.seq ?? -1
        if (latest > (yield* EventV2.latestSequence(db, created.id))) {
          yield* db
            .update(EventSequenceTable)
            .set({ seq: latest })
            .where(eq(EventSequenceTable.aggregate_id, created.id))
            .run()
            .pipe(Effect.orDie)
        }
        return created
      }),
      remove: Effect.fn("V2Session.remove")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* execution.interrupt(sessionID)
            yield* execution.await(sessionID)
          }),
        )
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID })
        yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: toV1Info(row) }, { location: session.location })
        yield* events.remove(sessionID)
      }),
      update: Effect.fn("V2Session.update")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID: input.sessionID })
        yield* events.publish(
          SessionV1.Event.Updated,
          { sessionID: input.sessionID, info: { ...toV1Info(row), title: input.title } },
          { location: session.location },
        )
        return yield* result.get(input.sessionID)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const prompt = resolvePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const intent = input.intent
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery, intent }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
              intent,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const command = yield* CommandV2.Service.use((commands) => commands.get(input.command)).pipe(
          Effect.provide(locations.get(session.location)),
        )
        if (!command) return yield* new CommandNotFoundError({ command: input.command })

        const expanded = CommandTemplate.expandTemplate(command.template, input.arguments ?? "")
        const matches = CommandTemplate.shellMatches(expanded)
        const text =
          matches.length === 0
            ? expanded.trim()
            : yield* Effect.gen(function* () {
                const outputs: string[] = []
                for (const shellCommand of matches) {
                  const settled = yield* appProcess
                    .run(
                      ChildProcess.make(shellCommand, [], {
                        cwd: session.location.directory,
                        shell: defaultShell(),
                        stdin: "ignore",
                        detached: process.platform !== "win32",
                        forceKillAfter: Duration.seconds(3),
                      }),
                      { combineOutput: true, maxOutputBytes: MAX_SHELL_CAPTURE_BYTES },
                    )
                    .pipe(Effect.catchTag("AppProcessError", (error) => Effect.succeed(error)))
                  outputs.push(
                    settled instanceof AppProcess.AppProcessError
                      ? settled.message
                      : (settled.output?.toString("utf8") ?? ""),
                  )
                }
                return CommandTemplate.replaceShellMatches(expanded, outputs).trim()
              })

        const agent = command.agent ?? input.agent
        const model = command.model ?? input.model
        const intent: SessionInput.Intent = {
          ...(agent && ["build", "edit", "plan", "yolo"].includes(agent)
            ? { mode: agent as NonNullable<SessionInput.Intent["mode"]> }
            : {}),
          ...(model ? { model: { providerID: model.providerID, modelID: model.id, variant: model.variant } } : {}),
        }
        const files = [...(input.files ?? [])]
        const seen = new Set(files.map((file) => file.uri))
        const project = yield* projects.resolve(session.location.directory)
        for (const mention of new Set(CommandTemplate.fileMentions(text))) {
          const filepath = mention.startsWith("~/")
            ? path.join(Global.Path.home, mention.slice(2))
            : path.resolve(project.directory, mention)
          if (!(yield* fsys.existsSafe(filepath))) continue
          const uri = pathToFileURL(filepath).href
          if (seen.has(uri)) continue
          seen.add(uri)
          files.push({ uri, name: mention })
        }
        const admitted = yield* SessionInput.admit(db, events, {
          id: input.id ?? SessionMessage.ID.create(),
          sessionID: input.sessionID,
          prompt: resolvePrompt({ text, ...(files.length > 0 ? { files } : {}) }),
          delivery: "steer",
          ...(Object.keys(intent).length > 0 ? { intent } : {}),
        })
        yield* execution.wake(admitted.sessionID)
      }),
      queue: {
        list: Effect.fn("V2Session.queue.list")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* SessionInput.listPending(db, sessionID)
        }),
        edit: Effect.fn("V2Session.queue.edit")(function* (input) {
          yield* result.get(input.sessionID)
          return yield* SessionInput.editPrompt(db, events, {
            sessionID: input.sessionID,
            id: input.id,
            prompt: resolvePrompt({ text: input.text }),
          })
        }),
        remove: Effect.fn("V2Session.queue.remove")(function* (input) {
          yield* result.get(input.sessionID)
          return yield* SessionInput.removePrompt(db, events, input)
        }),
        reorder: Effect.fn("V2Session.queue.reorder")(function* (input) {
          yield* result.get(input.sessionID)
          yield* SessionInput.reorderQueue(db, events, input)
        }),
        sendNow: Effect.fn("V2Session.queue.sendNow")(function* (input) {
          yield* result.get(input.sessionID)
          const promoted = yield* SessionInput.promoteQueued(db, events, input)
          // wake 会在当前 drain 结束后安排一次后继执行（空闲时直接启动），确保新提升的输入得到作答。
          if (promoted) yield* execution.wake(input.sessionID).pipe(Effect.ignore)
          return promoted
        }),
        policy: Effect.fn("V2Session.queue.policy")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* SessionInput.queuePolicy(db, sessionID)
        }),
        setPolicy: Effect.fn("V2Session.queue.setPolicy")(function* (input) {
          yield* result.get(input.sessionID)
          yield* SessionInput.setQueuePolicy(db, events, input)
        }),
      },
      shell: Effect.fn("V2Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const messageID = input.id ? SessionMessage.ID.make(input.id) : SessionMessage.ID.create()
        const callID = crypto.randomUUID()
        yield* events.publish(SessionEvent.Shell.Started, {
          sessionID: input.sessionID,
          messageID,
          callID,
          command: input.command,
          timestamp: yield* DateTime.now,
        })
        const command = ChildProcess.make(input.command, [], {
          cwd: session.location.directory,
          shell: defaultShell(),
          stdin: "ignore",
          detached: process.platform !== "win32",
          forceKillAfter: Duration.seconds(3),
        })
        const settled = yield* appProcess
          .run(command, { combineOutput: true, maxOutputBytes: MAX_SHELL_CAPTURE_BYTES })
          .pipe(Effect.catchTag("AppProcessError", (error) => Effect.succeed(error)))
        const output =
          settled instanceof AppProcess.AppProcessError ? settled.message : (settled.output?.toString("utf8") ?? "")
        yield* events.publish(SessionEvent.Shell.Ended, {
          sessionID: input.sessionID,
          callID,
          output,
          timestamp: yield* DateTime.now,
        })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* SessionRunner.Service.use((runner) => runner.compact(input.sessionID)).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.await(sessionID)
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      diff: Effect.fn("V2Session.diff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const messages = yield* result
          .messages({ sessionID: input.sessionID, order: "asc" })
          .pipe(Effect.catchTag("Session.MessageDecodeError", () => Effect.succeed([])))
        const range = turnSnapshots(messages, input.messageID)
        if (!range) return []
        return yield* Snapshot.Service.use((snapshot) =>
          snapshot.diff({ from: Snapshot.ID.make(range.from), to: Snapshot.ID.make(range.to) }).pipe(
            Effect.map((diffs) => [...diffs]),
            Effect.catch(() => Effect.succeed([])),
          ),
        ).pipe(Effect.provide(locations.get(session.location)))
      }),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

/** Pick the snapshot range for a turn: the first start and last end of its assistants. */
function turnSnapshots(messages: SessionMessage.Message[], messageID?: SessionMessage.ID) {
  const scoped = (() => {
    if (!messageID) return messages
    const index = messages.findIndex((message) => message.id === messageID)
    if (index === -1) return []
    if (messages[index]!.type !== "user") return [messages[index]!]
    const next = messages.findIndex((message, i) => i > index && message.type === "user")
    return messages.slice(index, next === -1 ? undefined : next)
  })()
  const starts = scoped.flatMap((message) =>
    message.type === "assistant" && message.snapshot?.start ? [message.snapshot.start] : [],
  )
  const ends = scoped.flatMap((message) =>
    message.type === "assistant" && message.snapshot?.end ? [message.snapshot.end] : [],
  )
  const from = starts[0]
  const to = ends[ends.length - 1]
  if (!from || !to || from === to) return undefined
  return { from, to }
}

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    AppProcess.node,
    FSUtil.node,
    LocationServiceMap.node,
    SessionProjector.node,
  ],
})
