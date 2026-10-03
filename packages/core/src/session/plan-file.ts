export * as PlanFile from "./plan-file"

import path from "path"
import { DateTime } from "effect"
import { Global } from "../global"
import type { SessionSchema } from "./schema"

/** Plan files live in the project worktree when it has VCS, otherwise in the global data directory. */
export function planFile(
  info: Pick<SessionSchema.Info, "slug" | "time">,
  location: { readonly project: { readonly directory: string }; readonly vcs?: unknown },
) {
  const base = location.vcs
    ? path.join(location.project.directory, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, `${DateTime.toEpochMillis(info.time.created)}-${info.slug}.md`)
}
