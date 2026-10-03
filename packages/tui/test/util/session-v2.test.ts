import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { projectSessionMessages } from "../../src/util/session-v2"

const sessionID = "ses_projection_test"

const source = [
  { type: "agent-switched", id: "msg_agent", time: { created: 1 }, agent: "build" },
  {
    type: "model-switched",
    id: "msg_model",
    time: { created: 2 },
    model: { id: "gpt", providerID: "openai", variant: "high" },
  },
  {
    type: "user",
    id: "msg_user",
    time: { created: 3 },
    text: "hello",
    files: [{ uri: "data:text/plain;base64,aGk=", mime: "text/plain", name: "note.txt" }],
  },
  {
    type: "assistant",
    id: "msg_assistant",
    time: { created: 4, completed: 9 },
    agent: "build",
    model: { id: "gpt", providerID: "openai", variant: "high" },
    content: [
      { type: "text", id: "part_text", text: "answer" },
      { type: "reasoning", id: "part_reason", text: "thinking", time: { created: 5, completed: 6 } },
      {
        type: "tool",
        id: "call_bash",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "echo ok" },
          content: [{ type: "text", text: "ok" }],
          structured: { exit: 0, truncated: false, output: "ok" },
        },
        time: { created: 7, ran: 7, completed: 8 },
      },
    ],
  },
  { type: "compaction", id: "msg_compaction", time: { created: 10 }, reason: "auto", summary: "s", recent: "r" },
  { type: "synthetic", id: "msg_synthetic", sessionID, time: { created: 11 }, text: "Continue with the next plan item" },
] satisfies SessionMessage[]

describe("projectSessionMessages", () => {
  test("projects user, assistant and synthetic messages with parts", () => {
    const projected = projectSessionMessages(sessionID, source)

    expect(projected.messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_user", "user"],
      ["msg_assistant", "assistant"],
      ["msg_synthetic", "user"],
    ])

    const user = projected.messages[0]!
    expect(user.role).toBe("user")
    if (user.role === "user") {
      expect(user.agent).toBe("build")
      expect(user.model).toEqual({ providerID: "openai", modelID: "gpt", variant: "high" })
    }
    const userParts = projected.parts.get("msg_user")!
    expect(userParts.map((part) => part.type)).toEqual(["text", "file", "compaction"])

    const assistant = projected.messages[1]!
    expect(assistant.role).toBe("assistant")
    if (assistant.role === "assistant") {
      expect(assistant.parentID).toBe("msg_user")
      expect(assistant.modelID).toBe("gpt")
      expect(assistant.providerID).toBe("openai")
      expect(assistant.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    }
    const assistantParts = projected.parts.get("msg_assistant")!
    expect(assistantParts.map((part) => part.type)).toEqual(["text", "reasoning", "tool"])
    const tool = assistantParts[2]!
    expect(tool.type).toBe("tool")
    if (tool.type === "tool") {
      expect(tool.tool).toBe("bash")
      expect(tool.state.status).toBe("completed")
      if (tool.state.status === "completed") {
        expect(tool.state.output).toBe("ok")
        expect(tool.state.metadata).toMatchObject({ output: "ok", exit: 0 })
      }
    }

    expect(projected.parts.get("msg_user")!.at(-1)).toMatchObject({ type: "compaction", auto: true })
    expect(projected.parts.get("msg_synthetic")![0]).toMatchObject({ type: "text", synthetic: true })
  })

  test("projects shell messages into a bash tool part", () => {
    const projected = projectSessionMessages(sessionID, [
      {
        type: "shell",
        id: "msg_shell",
        time: { created: 1, completed: 2 },
        callID: "call_shell",
        command: "git status",
        output: "clean",
      },
    ])
    expect(projected.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    const tool = projected.parts.get("msg_shell:assistant")![0]!
    expect(tool.type).toBe("tool")
    if (tool.type === "tool" && tool.state.status === "completed") {
      expect(tool.state.output).toBe("clean")
      expect(tool.state.input).toEqual({ command: "git status" })
      expect(tool.callID).toBe("call_shell")
    }
  })
})
