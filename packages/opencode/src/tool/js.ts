import { DEFAULT_TIMEOUT_MS, JS_TOOL_DESCRIPTION, MAX_TIMEOUT_MS } from "@opencode-ai/browser-use"
import { Effect, Schema } from "effect"
import { BrowserUse } from "@/browser/browser-use"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "JavaScript code to execute in the fresh browser kernel",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description:
      `Per-call timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). ` +
      "Set it to at least the estimated total runtime plus 15000 ms when the code awaits long operations; " +
      "split the work into multiple calls if that exceeds the maximum.",
  }),
  title: Schema.optional(Schema.String).annotate({
    description:
      "Short user-facing title in the user's language describing the intended action without implementation terms",
  }),
})

export const JsTool = Tool.define(
  "js",
  Effect.gen(function* () {
    const browser = yield* BrowserUse.Service

    return {
      description: JS_TOOL_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser",
            patterns: ["*"],
            always: ["*"],
            metadata: {
              ...(params.title ? { title: params.title } : {}),
            },
          })

          const result = yield* browser.run({
            sessionId: ctx.sessionID,
            code: params.code,
            timeoutMs: Math.min(
              Math.max(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1),
              MAX_TIMEOUT_MS,
            ),
            signal: ctx.abort,
          })

          return {
            title: params.title ?? "Browser Use",
            output: result.output,
            metadata: {
              ...result.metadata,
              ...(result.isError ? { error: true } : {}),
            },
            ...(result.images.length > 0
              ? {
                  attachments: result.images.map((image) => ({
                    type: "file" as const,
                    mime: image.mimeType,
                    url: `data:${image.mimeType};base64,${image.base64}`,
                  })),
                }
              : {}),
          }
        }),
    }
  }),
)
