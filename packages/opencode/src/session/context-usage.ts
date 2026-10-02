import { Token } from "@/util/token"
import { Effect } from "effect"
import type { ModelMessage, Tool } from "ai"

/**
 * 上下文用量计量 —— 借鉴 zai-org/ZCode 的 context-usage。
 *
 * 在下一次模型请求组装完成后，按 category/contributor 统计估算 token：
 * system prompt、内置工具 schema、MCP 工具 schema、messages（含逐工具明细）。
 * 只写 debug 日志，不影响请求本身；用于观察上下文构成、验证压缩/清理策略。
 */

export interface ContextUsageCategory {
  source: "system_prompt" | "system_tool_schemas" | "mcp_tool_schemas" | "messages"
  tokens: number
  count: number
}

export interface ContextUsageTool {
  name: string
  source: "system" | "mcp"
  tokens: number
}

export interface ContextUsageRole {
  role: string
  tokens: number
  count: number
}

export interface ContextUsageSnapshot {
  totalTokens: number
  categories: ContextUsageCategory[]
  tools: ContextUsageTool[]
  /** 消息内按工具名归集的 token（tool-call / tool-result 明细）。 */
  toolDetails: ContextUsageTool[]
  messageRoles: ContextUsageRole[]
  attachmentBytes: number
}

const MAX_TOOL_DETAILS = 12

export function buildContextUsageSnapshot(input: {
  system: readonly string[]
  tools: Record<string, Tool>
  messages: readonly ModelMessage[]
}): ContextUsageSnapshot {
  const estimate = (value: unknown): number =>
    Token.estimate(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))

  const systemTokens = input.system.reduce((total, section) => total + estimate(section), 0)

  const tools: ContextUsageTool[] = Object.entries(input.tools).map(([name, tool]) => ({
    name,
    source: name.startsWith("mcp__") ? "mcp" : "system",
    tokens: estimate({ description: tool.description, parameters: tool.inputSchema }),
  }))

  const roles = new Map<string, { tokens: number; count: number }>()
  const toolDetails = new Map<string, { tokens: number; source: "system" | "mcp" }>()
  let messageTokens = 0
  let attachmentBytes = 0

  for (const message of input.messages) {
    const role = roles.get(message.role) ?? { tokens: 0, count: 0 }
    role.count += 1
    if (typeof message.content === "string") {
      const tokens = estimate(message.content)
      role.tokens += tokens
      messageTokens += tokens
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const tokens = estimate(part)
        role.tokens += tokens
        messageTokens += tokens
        const candidate = part as { type?: unknown; toolName?: unknown; image?: unknown; data?: unknown }
        if (
          (candidate.type === "tool-call" || candidate.type === "tool-result") &&
          typeof candidate.toolName === "string"
        ) {
          const detail = toolDetails.get(candidate.toolName) ?? {
            tokens: 0,
            source: candidate.toolName.startsWith("mcp__") ? ("mcp" as const) : ("system" as const),
          }
          detail.tokens += tokens
          toolDetails.set(candidate.toolName, detail)
        }
        if (candidate.type === "image") {
          const image = candidate.image ?? candidate.data
          if (typeof image === "string") attachmentBytes += image.length
          else if (ArrayBuffer.isView(image)) attachmentBytes += image.byteLength
        }
      }
    }
    roles.set(message.role, role)
  }

  const systemToolTokens = tools.filter((tool) => tool.source === "system")
  const mcpToolTokens = tools.filter((tool) => tool.source === "mcp")
  const categories: ContextUsageCategory[] = [
    { source: "system_prompt", tokens: systemTokens, count: input.system.length },
    { source: "system_tool_schemas", tokens: sum(systemToolTokens), count: systemToolTokens.length },
    { source: "mcp_tool_schemas", tokens: sum(mcpToolTokens), count: mcpToolTokens.length },
    { source: "messages", tokens: messageTokens, count: input.messages.length },
  ]

  const toolDetailList: ContextUsageTool[] = [...toolDetails.entries()]
    .map(([name, detail]) => ({ name, ...detail }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_TOOL_DETAILS)

  return {
    totalTokens: categories.reduce((total, category) => total + category.tokens, 0),
    categories,
    tools: tools.sort((a, b) => b.tokens - a.tokens).slice(0, MAX_TOOL_DETAILS),
    toolDetails: toolDetailList,
    messageRoles: [...roles.entries()]
      .map(([role, value]) => ({ role, ...value }))
      .sort((a, b) => b.tokens - a.tokens),
    attachmentBytes,
  }
}

function sum(tools: readonly ContextUsageTool[]): number {
  return tools.reduce((total, tool) => total + tool.tokens, 0)
}

export const log = Effect.fn("SessionContextUsage.log")(function* (input: {
  sessionID: string
  providerID: string
  modelID: string
  system: readonly string[]
  tools: Record<string, Tool>
  messages: readonly ModelMessage[]
}) {
  const snapshot = buildContextUsageSnapshot(input)
  yield* Effect.logDebug("context usage snapshot", {
    event: "context_usage_snapshot",
    module: "session.context-usage",
    "session.id": input.sessionID,
    providerID: input.providerID,
    modelID: input.modelID,
    totalTokens: snapshot.totalTokens,
    categories: snapshot.categories,
    tools: snapshot.tools,
    toolDetails: snapshot.toolDetails,
    messageRoles: snapshot.messageRoles,
    attachmentBytes: snapshot.attachmentBytes,
  })
})

export * as SessionContextUsage from "./context-usage"
