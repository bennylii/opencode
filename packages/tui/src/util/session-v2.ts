import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type {
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageShell,
  SessionMessageUser,
} from "@opencode-ai/sdk/v2"

export interface ProjectedSession {
  messages: Message[]
  parts: Map<string, Part[]>
}

const emptyModel = { providerID: "", modelID: "", variant: undefined as string | undefined }
const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function contentText(content: ReadonlyArray<{ type: string; [key: string]: unknown }>) {
  return content
    .flatMap((item) => (item.type === "text" && typeof item["text"] === "string" ? [item["text"]] : []))
    .join("\n")
    .trim()
}

function normalizeInput(name: string, input: Record<string, unknown>) {
  if (
    (name === "edit" || name === "write" || name === "apply_patch") &&
    typeof input["path"] === "string" &&
    typeof input["filePath"] !== "string"
  )
    return { ...input, filePath: input["path"] }
  return input
}

/** Map v2 `structured` output back to the metadata keys the TUI tool renderers expect. */
function toolMetadata(name: string, structured: Record<string, unknown>, content: ReadonlyArray<{ type: string }>) {
  const text = contentText(content)
  const base = typeof structured === "object" && structured !== null ? structured : {}
  switch (name) {
    case "bash":
      return { ...base, output: typeof base["output"] === "string" ? base["output"] : text }
    case "edit":
    case "apply_patch": {
      const files = Array.isArray(base["files"]) ? base["files"] : []
      const diff = files
        .flatMap((file) =>
          file && typeof file === "object" && typeof (file as { patch?: unknown }).patch === "string"
            ? [(file as { patch: string }).patch]
            : [],
        )
        .join("\n")
      return { ...base, ...(diff ? { diff } : {}), ...(text ? { output: text } : {}) }
    }
    case "grep":
      return { ...base, ...(Array.isArray(structured) ? { matches: structured.length } : {}), output: text }
    case "glob":
      return { ...base, ...(Array.isArray(structured) ? { count: structured.length } : {}), output: text }
    default:
      return { ...base, ...(text ? { output: text } : {}) }
  }
}

function toolState(item: SessionMessageAssistantTool, start: number, end: number): ToolPart["state"] {
  const state = item.state
  switch (state.status) {
    case "pending":
      return { status: "pending", input: {}, raw: state.input }
    case "running":
      return {
        status: "running",
        input: normalizeInput(item.name, state.input),
        metadata: toolMetadata(item.name, state.structured, state.content),
        time: { start },
      }
    case "completed":
      return {
        status: "completed",
        input: normalizeInput(item.name, state.input),
        output: contentText(state.content),
        title: item.name,
        metadata: toolMetadata(item.name, state.structured, state.content),
        time: { start, end },
      }
    case "error":
      return {
        status: "error",
        input: normalizeInput(item.name, state.input),
        error: state.error.message,
        metadata: toolMetadata(item.name, state.structured, state.content),
        time: { start, end },
      }
  }
}

function assistantParts(sessionID: string, message: SessionMessageAssistant): Part[] {
  return message.content.map((item): Part => {
    if (item.type === "text")
      return {
        id: item.id,
        sessionID,
        messageID: message.id,
        type: "text",
        text: item.text,
      } satisfies TextPart
    if (item.type === "reasoning")
      return {
        id: item.id,
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: item.text,
        metadata: item.providerMetadata,
        time: { start: item.time?.created ?? message.time.created, end: item.time?.completed },
      } satisfies ReasoningPart
    return {
      id: item.id,
      sessionID,
      messageID: message.id,
      type: "tool",
      callID: item.id,
      tool: item.name,
      state: toolState(item, item.time.ran ?? item.time.created, item.time.completed ?? item.time.created),
    } satisfies ToolPart
  })
}

function assistantMessage(sessionID: string, parentID: string, message: SessionMessageAssistant): AssistantMessage {
  const error = message.error
    ? message.error.message.toLowerCase().includes("abort") || message.error.message.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    error,
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    variant: message.model.variant,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens,
    finish: message.finish,
  }
}

function userMessage(
  sessionID: string,
  message: SessionMessageUser,
  agent: string | undefined,
  model: { providerID: string; modelID: string; variant?: string },
): UserMessage {
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: { created: message.time.created },
    agent: agent ?? "",
    model: { providerID: model.providerID, modelID: model.modelID, variant: model.variant },
  }
}

function userParts(sessionID: string, message: SessionMessageUser): Part[] {
  return [
    {
      id: `${message.id}:text`,
      sessionID,
      messageID: message.id,
      type: "text",
      text: message.text,
    } satisfies TextPart,
    ...(message.files ?? []).map(
      (file, index): FilePart => ({
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
      }),
    ),
  ]
}

function shellParts(sessionID: string, messageID: string, message: SessionMessageShell): { user: Part[]; assistant: Part[] } {
  const start = message.time.created
  const end = message.time.completed ?? start
  return {
    user: [
      {
        id: `${message.id}:text`,
        sessionID,
        messageID: message.id,
        type: "text",
        text: message.command,
      } satisfies TextPart,
    ],
    assistant: [
      {
        id: `${message.id}:tool`,
        sessionID,
        messageID,
        type: "tool",
        callID: message.callID,
        tool: "bash",
        state: {
          status: "completed",
          input: { command: message.command },
          output: message.output,
          title: "Shell",
          metadata: { output: message.output },
          time: { start, end },
        },
      } satisfies ToolPart,
    ],
  }
}

/** Project durable v2 session messages into the legacy message/part shapes the TUI renders. */
export function projectSessionMessages(sessionID: string, source: ReadonlyArray<SessionMessage>): ProjectedSession {
  const messages: Message[] = []
  const parts = new Map<string, Part[]>()
  let agent: string | undefined
  let model = emptyModel
  let parentID: string | undefined

  for (const message of source) {
    if (message.type === "agent-switched") {
      agent = message.agent
      continue
    }
    if (message.type === "model-switched") {
      model = {
        providerID: message.model.providerID,
        modelID: message.model.id,
        variant: message.model.variant,
      }
      continue
    }
    if (message.type === "user") {
      parentID = message.id
      messages.push(userMessage(sessionID, message, agent, model))
      parts.set(message.id, userParts(sessionID, message))
      continue
    }
    if (message.type === "synthetic") {
      parentID = message.id
      messages.push({
        id: message.id,
        sessionID,
        role: "user",
        time: { created: message.time.created },
        agent: agent ?? "",
        model: { providerID: model.providerID, modelID: model.modelID, variant: model.variant },
      })
      parts.set(message.id, [
        {
          id: `${message.id}:text`,
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.text,
          synthetic: true,
        } satisfies TextPart,
      ])
      continue
    }
    if (message.type === "system") continue
    if (message.type === "shell") {
      const assistantID = `${message.id}:assistant`
      messages.push({
        id: message.id,
        sessionID,
        role: "user",
        time: { created: message.time.created },
        agent: agent ?? "",
        model: { providerID: model.providerID, modelID: model.modelID, variant: model.variant },
      })
      messages.push({
        id: assistantID,
        sessionID,
        role: "assistant",
        time: message.time,
        parentID: message.id,
        modelID: model.modelID,
        providerID: model.providerID,
        variant: model.variant,
        mode: agent ?? "",
        agent: agent ?? "",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: emptyTokens,
      })
      const shell = shellParts(sessionID, assistantID, message)
      parts.set(message.id, shell.user)
      parts.set(assistantID, shell.assistant)
      parentID = undefined
      continue
    }
    if (message.type === "assistant") {
      if (!parentID) continue
      agent = message.agent
      model = {
        providerID: message.model.providerID,
        modelID: message.model.id,
        variant: message.model.variant,
      }
      const parent = messages.findLast((item) => item.id === parentID)
      if (parent?.role === "user") {
        parent.agent = message.agent
        parent.model = {
          providerID: message.model.providerID,
          modelID: message.model.id,
          variant: message.model.variant,
        }
      }
      messages.push(assistantMessage(sessionID, parentID, message))
      parts.set(message.id, assistantParts(sessionID, message))
      continue
    }
    if (message.type === "compaction") {
      if (!parentID) continue
      parts.set(parentID, [
        ...(parts.get(parentID) ?? []),
        {
          id: `${message.id}:compaction`,
          sessionID,
          messageID: parentID,
          type: "compaction",
          auto: message.reason === "auto",
        },
      ])
      continue
    }
  }

  return { messages, parts }
}
