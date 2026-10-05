/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function mountTimeline(input: {
  root: string
  messages: Message[]
  parts: Map<string, Part[]>
  onMove: (messageID: string) => void
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogTimeline },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/routes/session/dialog-timeline"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <DialogTimeline
                      sessionID="ses_timeline_test"
                      onMove={input.onMove}
                      messages={() => input.messages}
                      partsFor={(messageID) => input.parts.get(messageID) ?? []}
                    />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

async function captureFrame(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.renderOnce()
    await Bun.sleep(25)
    const frame = app.captureCharFrame()
    if (frame.includes("Timeline")) return frame
  }
  return app.captureCharFrame()
}

test("timeline renders projected v2 messages and previews the jump target", async () => {
  await using tmp = await tmpdir()
  const moved: string[] = []
  const messages: Message[] = [
    {
      id: "msg_user_1",
      sessionID: "ses_timeline_test",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
    } as Message,
  ]
  const parts = new Map<string, Part[]>([
    [
      "msg_user_1",
      [
        {
          id: "part_1",
          sessionID: "ses_timeline_test",
          messageID: "msg_user_1",
          type: "text",
          text: "hello timeline",
        } as Part,
      ],
    ],
  ])

  const timeline = await mountTimeline({ root: tmp.path, messages, parts, onMove: (id) => moved.push(id) })
  try {
    const frame = await captureFrame(timeline.app)
    expect(frame).toContain("Timeline")
    expect(frame).toContain("hello timeline")

    timeline.app.mockInput.pressArrow("down")
    await Bun.sleep(30)
    expect(moved).toEqual(["msg_user_1"])
  } finally {
    await timeline.cleanup()
  }
})
