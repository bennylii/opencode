export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

/**
 * 队列项在 admission 时冻结的执行属性：计划/模型/思考强度/上下文预算。
 * 提升时以本结构覆盖 session 当前选择；属性本身不允许事后修改（只允许改文本）。
 */
export interface Intent extends Schema.Schema.Type<typeof Intent> {}
export const Intent = Schema.Struct({
  /** 计划模式：plan | build（省略则沿用 session 当前 agent）。 */
  mode: optional(Schema.Literals(["build", "edit", "plan", "yolo"])),
  /** 模型与思考强度（variant）一起冻结、一起生效。 */
  model: optional(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: optional(Schema.String),
    }),
  ),
  /** 上下文预算：历史超过该 token 数时先压缩/裁剪到预算再继续同一对话。 */
  context: optional(
    Schema.Struct({
      maxInputTokens: PositiveInt,
    }),
  ),
  /** 子代理任务：命令以 subtask 语义执行时，在 provider turn 前派发一次 task 工具调用。 */
  task: optional(
    Schema.Struct({
      agent: Schema.String,
      description: Schema.String,
      model: optional(
        Schema.Struct({
          providerID: Schema.String,
          modelID: Schema.String,
          variant: optional(Schema.String),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "SessionInput.Intent" })

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  intent: Intent.pipe(optional),
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })
