export * as Session from "./session"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { Revert } from "./revert"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  slug: Schema.String,
  /** 会话引擎：v1 为 legacy 循环，v2 为 durable core runner。 */
  runtime: Schema.Literals(["v1", "v2"]),
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  revert: Revert.State.pipe(optional),
  /** 队列策略：autoDrain 控制空闲自动提升；followupMode 控制下一项以新 turn 还是同 turn 续跑。 */
  queue: Schema.Struct({
    autoDrain: Schema.Boolean,
    followupMode: Schema.Literals(["queue", "guide"]),
  }).pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
