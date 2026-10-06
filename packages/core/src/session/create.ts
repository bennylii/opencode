export * as SessionCreate from "./create"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import path from "path"
import type { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { InstallationVersion } from "../installation/version"
import type { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Slug } from "../util/slug"
import { SessionProjector } from "./projector"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionStore } from "./store"

export type Input = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  title?: string
  parentID?: SessionSchema.ID
}

export type Deps = {
  database: Database.Interface
  events: EventV2.Interface
  projects: ProjectV2.Interface
  store: SessionStore.Interface
}

/**
 * Create and project a durable v2 session. Shared by the public SessionV2
 * service and location-scoped tools that spawn child sessions, because those
 * tools cannot depend on SessionV2 without cycling through the location map.
 */
export const create = Effect.fn("SessionCreate.create")(function* (input: Input, deps: Deps) {
  const sessionID = input.id ?? SessionSchema.ID.create()
  const recorded = yield* deps.store.get(sessionID)
  if (recorded) return recorded
  const project = yield* deps.projects.resolve(input.location.directory)
  yield* deps.database.db
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
    parentID: input.parentID,
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
  const projected = yield* deps.events
    .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
    .pipe(
      Effect.as({ type: "created" } as const),
      Effect.catchDefect((defect) => {
        if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) return Effect.die(defect)
        // Concurrent creation lost the projection race. The existing Session identity wins.
        return deps.store.get(sessionID).pipe(
          Effect.flatMap((session) =>
            session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
          ),
        )
      }),
    )
  if (projected.type === "existing") return projected.session
  // V2 创建标记 durable runtime，legacy 行保持默认 v1。
  yield* deps.database.db
    .update(SessionTable)
    .set({ runtime: "v2" })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
  const created = yield* deps.store.get(sessionID).pipe(Effect.orDie)
  if (!created) return yield* Effect.die(new Error(`Session was not projected: ${sessionID}`))
  return created
})
