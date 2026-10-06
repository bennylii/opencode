import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { DateTime } from "effect"
import type { SessionID } from "./schema"

const emptyModel = { providerID: "", modelID: "", variant: undefined as string | undefined }
const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const millis = (value: DateTime.Utc) => DateTime.toEpochMillis(value)
const partID = (messageID: string, suffix: string | number) =>
  SessionV1.PartID.make(`prt_${messageID.replace(/^msg_?/, "")}_${suffix}`)
const messageID = (value: string) => SessionV1.MessageID.make(value)
const modelID = (value: string) => ModelV2.ID.make(value)
const providerID = (value: string) => ProviderV2.ID.make(value)

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

/** Map v2 `structured` output back to the metadata keys legacy renderers expect. */
function toolMetadata(
  name: string,
  input: Record<string, unknown>,
  structured: Record<string, unknown>,
  content: ReadonlyArray<{ type: string }>,
) {
  const text = contentText(content)
  const base = typeof structured === "object" && structured !== null ? structured : {}
  switch (name) {
    case "bash":
      return { ...base, output: typeof base["output"] === "string" ? base["output"] : text }
    case "edit": {
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
    case "apply_patch": {
      const applied = Array.isArray(base["applied"]) ? base["applied"] : []
      const files = Array.isArray(base["files"]) ? base["files"] : []
      const mapped = files.flatMap((file, index) => {
        if (!file || typeof file !== "object") return []
        const info = file as { file?: unknown; patch?: unknown; deletions?: unknown }
        const relativePath = typeof info.file === "string" ? info.file : undefined
        if (!relativePath) return []
        const operation = (applied[index] as { type?: unknown } | undefined)?.type
        const type = operation === "add" ? "add" : operation === "delete" ? "delete" : "update"
        return [
          {
            type,
            relativePath,
            filePath: relativePath,
            patch: typeof info.patch === "string" ? info.patch : "",
            deletions: typeof info.deletions === "number" ? info.deletions : 0,
          },
        ]
      })
      return { ...base, ...(mapped.length > 0 ? { files: mapped } : {}), ...(text ? { output: text } : {}) }
    }
    case "grep":
      return { ...base, ...(Array.isArray(structured) ? { matches: structured.length } : {}), output: text }
    case "glob":
      return { ...base, ...(Array.isArray(structured) ? { count: structured.length } : {}), output: text }
    case "websearch":
      return {
        ...base,
        ...(typeof input["numResults"] === "number" ? { numResults: input["numResults"] } : {}),
        output: text,
      }
    default:
      return { ...base, ...(text ? { output: text } : {}) }
  }
}

function toolState(item: SessionMessage.AssistantTool): SessionV1.ToolState {
  const state = item.state
  const start = millis(item.time.ran ?? item.time.created)
  const end = millis(item.time.completed ?? item.time.created)
  switch (state.status) {
    case "pending":
      return { status: "pending", input: {}, raw: state.input }
    case "running":
      return {
        status: "running",
        input: normalizeInput(item.name, state.input),
        metadata: toolMetadata(item.name, state.input, state.structured, state.content),
        time: { start },
      }
    case "completed":
      return {
        status: "completed",
        input: normalizeInput(item.name, state.input),
        output: contentText(state.content),
        title: item.name,
        metadata: toolMetadata(item.name, state.input, state.structured, state.content),
        time: { start, end },
      }
    case "error":
      return {
        status: "error",
        input: normalizeInput(item.name, state.input),
        error: state.error.message,
        metadata: toolMetadata(item.name, state.input, state.structured, state.content),
        time: { start, end },
      }
  }
}

function assistantParts(sessionID: SessionID, message: SessionMessage.Assistant): SessionV1.Part[] {
  return message.content.map((item, index): SessionV1.Part => {
    if (item.type === "text")
      return {
        id: partID(message.id, index),
        sessionID,
        messageID: messageID(message.id),
        type: "text",
        text: item.text,
      }
    if (item.type === "reasoning")
      return {
        id: partID(message.id, index),
        sessionID,
        messageID: messageID(message.id),
        type: "reasoning",
        text: item.text,
        metadata: item.providerMetadata,
        time: {
          start: millis(item.time?.created ?? message.time.created),
          end: item.time?.completed ? millis(item.time.completed) : undefined,
        },
      }
    return {
      id: partID(message.id, index),
      sessionID,
      messageID: messageID(message.id),
      type: "tool",
      callID: item.id,
      tool: item.name,
      state: toolState(item),
    }
  })
}

function assistantMessage(
  sessionID: SessionID,
  parentID: string,
  message: SessionMessage.Assistant,
): SessionV1.Assistant {
  const error = message.error
    ? message.error.message.toLowerCase().includes("abort") || message.error.message.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: messageID(message.id),
    sessionID,
    role: "assistant",
    time: {
      created: millis(message.time.created),
      completed: message.time.completed ? millis(message.time.completed) : undefined,
    },
    error,
    parentID: messageID(parentID),
    modelID: modelID(message.model.id),
    providerID: providerID(message.model.providerID),
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
  sessionID: SessionID,
  message: SessionMessage.User,
  agent: string | undefined,
  model: { providerID: string; modelID: string; variant?: string },
): SessionV1.User {
  return {
    id: messageID(message.id),
    sessionID,
    role: "user",
    time: { created: millis(message.time.created) },
    agent: agent ?? "",
    model: { providerID: providerID(model.providerID), modelID: modelID(model.modelID), variant: model.variant },
  }
}

function userParts(sessionID: SessionID, message: SessionMessage.User): SessionV1.Part[] {
  return [
    {
      id: partID(message.id, "text"),
      sessionID,
      messageID: messageID(message.id),
      type: "text",
      text: message.text,
    },
    ...(message.files ?? []).map(
      (file, index): SessionV1.FilePart => ({
        id: partID(message.id, `file_${index}`),
        sessionID,
        messageID: messageID(message.id),
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
      }),
    ),
  ]
}

function shellParts(
  sessionID: SessionID,
  assistantID: string,
  message: SessionMessage.Shell,
): { user: SessionV1.Part[]; assistant: SessionV1.Part[] } {
  const start = millis(message.time.created)
  const end = message.time.completed ? millis(message.time.completed) : start
  return {
    user: [
      {
        id: partID(message.id, "text"),
        sessionID,
        messageID: messageID(message.id),
        type: "text",
        text: message.command,
      },
    ],
    assistant: [
      {
        id: partID(message.id, "tool"),
        sessionID,
        messageID: messageID(assistantID),
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
      },
    ],
  }
}

/** Project durable v2 session messages into the legacy v1 message/part shapes. */
export function projectV2Messages(
  sessionID: SessionID,
  source: ReadonlyArray<SessionMessage.Message>,
): SessionV1.WithParts[] {
  const messages: SessionV1.WithParts[] = []
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
      messages.push({ info: userMessage(sessionID, message, agent, model), parts: userParts(sessionID, message) })
      continue
    }
    if (message.type === "synthetic") {
      parentID = message.id
      messages.push({
        info: {
          id: messageID(message.id),
          sessionID,
          role: "user",
          time: { created: millis(message.time.created) },
          agent: agent ?? "",
          model: { providerID: providerID(model.providerID), modelID: modelID(model.modelID), variant: model.variant },
        },
        parts: [
          {
            id: partID(message.id, "text"),
            sessionID,
            messageID: messageID(message.id),
            type: "text",
            text: message.text,
            synthetic: true,
          },
        ],
      })
      continue
    }
    if (message.type === "system") continue
    if (message.type === "shell") {
      const assistantID = `${message.id}:assistant`
      const shell = shellParts(sessionID, assistantID, message)
      messages.push({
        info: {
          id: messageID(message.id),
          sessionID,
          role: "user",
          time: { created: millis(message.time.created) },
          agent: agent ?? "",
          model: { providerID: providerID(model.providerID), modelID: modelID(model.modelID), variant: model.variant },
        },
        parts: shell.user,
      })
      messages.push({
        info: {
          id: messageID(assistantID),
          sessionID,
          role: "assistant",
          time: {
            created: millis(message.time.created),
            completed: message.time.completed ? millis(message.time.completed) : undefined,
          },
          parentID: messageID(message.id),
          modelID: modelID(model.modelID),
          providerID: providerID(model.providerID),
          variant: model.variant,
          mode: agent ?? "",
          agent: agent ?? "",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: emptyTokens,
        },
        parts: shell.assistant,
      })
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
      const parent = messages.findLast((item) => item.info.id === parentID)
      if (parent?.info.role === "user") {
        parent.info.agent = message.agent
        parent.info.model = {
          providerID: providerID(message.model.providerID),
          modelID: modelID(message.model.id),
          variant: message.model.variant,
        }
      }
      messages.push({
        info: assistantMessage(sessionID, parentID, message),
        parts: assistantParts(sessionID, message),
      })
      continue
    }
    if (message.type === "compaction") {
      if (!parentID) continue
      const parent = messages.findLast((item) => item.info.id === parentID)
      if (!parent) continue
      parent.parts.push({
        id: partID(message.id, "compaction"),
        sessionID,
        messageID: messageID(parentID),
        type: "compaction",
        auto: message.reason === "auto",
      })
      continue
    }
  }

  return messages
}

export * as V2Projection from "./v2-projection"
