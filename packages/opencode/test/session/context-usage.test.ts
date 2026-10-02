import { describe, expect, test } from "bun:test"
import type { ModelMessage, Tool } from "ai"
import { buildContextUsageSnapshot } from "../../src/session/context-usage"

describe("session.context-usage", () => {
  test("breaks down tokens by category and contributor", () => {
    const snapshot = buildContextUsageSnapshot({
      system: ["s".repeat(400), "t".repeat(40)],
      tools: {
        read: { description: "r".repeat(400) } as unknown as Tool,
        "mcp__demo__lookup": { description: "m".repeat(200) } as unknown as Tool,
      },
      messages: [
        { role: "user", content: "u".repeat(80) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "a".repeat(80) },
            { type: "tool-call", toolCallId: "1", toolName: "read", input: { file: "x".repeat(80) } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: "read",
              output: { type: "text", value: "o".repeat(400) },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "image", image: "i".repeat(128), mimeType: "image/png" }],
        },
      ] as unknown as ModelMessage[],
    })

    expect(snapshot.totalTokens).toBeGreaterThan(0)
    const system = snapshot.categories.find((category) => category.source === "system_prompt")
    expect(system?.count).toBe(2)
    expect(system?.tokens).toBe(110)
    expect(snapshot.categories.find((category) => category.source === "system_tool_schemas")?.count).toBe(1)
    expect(snapshot.categories.find((category) => category.source === "mcp_tool_schemas")?.count).toBe(1)
    expect(snapshot.tools.find((tool) => tool.name === "mcp__demo__lookup")?.source).toBe("mcp")
    expect(snapshot.toolDetails.find((tool) => tool.name === "read")?.tokens).toBeGreaterThan(0)
    expect(snapshot.attachmentBytes).toBe(128)
    expect(snapshot.messageRoles.find((role) => role.role === "user")?.count).toBe(2)
  })
})
