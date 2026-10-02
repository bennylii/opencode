import { describe, expect, test } from "bun:test"
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserControlExecuteInput,
  BrowserControlPort,
} from "../src/contracts.js"
import { BrowserJsRuntime } from "../src/js-tool/index.js"
import { MAX_HOST_RESPONSE_BYTES, responseOversizeReason } from "../src/js-tool/worker-protocol.js"

const DESCRIPTOR: BrowserBackendDescriptor = {
  id: "cdp:test",
  generation: 1,
  type: "cdp",
  name: "Headless Chromium (test)",
  capabilities: {},
}

class FakePort implements BrowserControlPort {
  readonly calls: BrowserCommand[] = []
  currentUrl = "about:blank"

  async list(): Promise<BrowserBackendDescriptor[]> {
    return [DESCRIPTOR]
  }

  async execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult> {
    this.calls.push(input.command)
    const command = input.command
    switch (command.method) {
      case "newTab":
        return {
          ok: true,
          tab: {
            tabId: "t1",
            url: this.currentUrl,
            title: "",
            viewport: { width: 1280, height: 720 },
            active: true,
          },
          elapsedMs: 1,
        }
      case "list":
        return {
          ok: true,
          tabs: [
            {
              tabId: "t1",
              url: this.currentUrl,
              title: "",
              viewport: { width: 1280, height: 720 },
              active: true,
            },
          ],
          elapsedMs: 1,
        }
      case "navigate":
        this.currentUrl = command.url
        return {
          ok: true,
          state: { url: command.url, title: "", canGoBack: false, canGoForward: false },
          elapsedMs: 1,
        }
      case "getState":
        return {
          ok: true,
          state: { url: this.currentUrl, title: "", canGoBack: false, canGoForward: false },
          elapsedMs: 1,
        }
      case "screenshot":
        return { ok: true, image: { base64: "aGk=", mimeType: "image/png" }, elapsedMs: 1 }
      default:
        return { ok: true, elapsedMs: 1 }
    }
  }
}

function makeRuntime(port: BrowserControlPort) {
  return new BrowserJsRuntime({ port })
}

describe("BrowserJsRuntime", () => {
  test("injects agent.browsers and drives the command transport", async () => {
    const port = new FakePort()
    const result = await makeRuntime(port).run({
      sessionId: "ses_test",
      code: [
        `const browser = await agent.browsers.getDefault()`,
        `const tabs = await browser.tabs.list()`,
        `nodeRepl.write("tabs=" + tabs.map((tab) => tab.id).join(","))`,
        `tabs.length`,
      ].join("\n"),
    })

    expect(result.error).toBeUndefined()
    expect(result.logs).toContain("tabs=t1")
    expect(result.result).toBe("1")
    expect(port.calls.map((command) => command.method)).toContain("list")
  })

  test("navigates and exposes page state", async () => {
    const port = new FakePort()
    const result = await makeRuntime(port).run({
      sessionId: "ses_test",
      code: [
        `const browser = await agent.browsers.getDefault()`,
        `const tab = await browser.tabs.new()`,
        `await tab.goto("https://example.com/")`,
        `tab.url()`,
      ].join("\n"),
    })

    expect(result.error).toBeUndefined()
    expect(result.result).toContain("example.com")
    expect(port.calls.map((command) => command.method)).toContain("navigate")
  })

  test("records screenshots emitted through nodeRepl.emitImage", async () => {
    const port = new FakePort()
    const result = await makeRuntime(port).run({
      sessionId: "ses_test",
      code: [
        `const browser = await agent.browsers.getDefault()`,
        `const tab = await browser.tabs.new()`,
        `await nodeRepl.emitImage(await tab.screenshot())`,
        `"ok"`,
      ].join("\n"),
    })

    expect(result.error).toBeUndefined()
    expect(result.images?.length).toBe(1)
    expect(result.images?.[0]?.mimeType).toBe("image/png")
    expect(result.browserScreenshotImageIndices).toEqual([0])
  })

  test("normalizes thrown errors without disposing the host", async () => {
    const result = await makeRuntime(new FakePort()).run({
      sessionId: "ses_test",
      code: `throw new Error("boom")`,
    })

    expect(result.error?.message).toBe("boom")
  })

  test("denies dynamic module imports by default", async () => {
    const result = await makeRuntime(new FakePort()).run({
      sessionId: "ses_test",
      code: `const fs = await import("node:fs"); fs`,
    })

    expect(result.error?.message).toContain("not available")
  })

  test("keeps request metadata available to the kernel", async () => {
    const result = await makeRuntime(new FakePort()).run({
      sessionId: "ses_test",
      turnId: "turn_1",
      code: `JSON.stringify(nodeRepl.requestMeta)`,
    })

    expect(result.error).toBeUndefined()
    expect(result.result).toContain("ses_test")
    expect(result.result).toContain("turn_1")
  })

  test("uses worker isolation by default and clears bindings between calls", async () => {
    const runtime = makeRuntime(new FakePort())
    const first = await runtime.run({
      sessionId: "ses_test",
      code: `globalThis.__leak = 42; "set"`,
    })
    expect(first.error).toBeUndefined()
    expect(runtime.lastIsolation).toBe("worker")

    const second = await runtime.run({
      sessionId: "ses_test",
      code: `typeof globalThis.__leak`,
    })
    expect(second.error).toBeUndefined()
    expect(second.result).toBe("undefined")
  })

  test("runs in-process when requested", async () => {
    const port = new FakePort()
    const runtime = new BrowserJsRuntime({ port, isolation: "in-process" })
    const result = await runtime.run({
      sessionId: "ses_test",
      code: `const browser = await agent.browsers.getDefault(); (await browser.tabs.list()).length`,
    })

    expect(result.error).toBeUndefined()
    expect(result.result).toBe("1")
    expect(runtime.lastIsolation).toBe("in-process")
  })

  test("aborts a running worker and reclaims it", async () => {
    const controller = new AbortController()
    const runtime = makeRuntime(new FakePort())
    const pending = runtime.run({
      sessionId: "ses_test",
      code: `await new Promise(() => {}); "never"`,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    const result = await pending

    expect(result.error?.name).toBe("AbortError")
  })

  test("truncates unbounded logs and results", async () => {
    const runtime = new BrowserJsRuntime({ port: new FakePort(), maxOutputBytes: 4096 })
    const logged = await runtime.run({
      sessionId: "ses_test",
      code: `console.log("x".repeat(20000)); "done"`,
    })
    expect(logged.error).toBeUndefined()
    expect(logged.logs).toContain("[output truncated]")
    expect(logged.logs.startsWith("\n")).toBe(false)
    expect(Buffer.byteLength(logged.logs, "utf8")).toBeLessThan(4300)
    expect(logged.result).toBe("done")

    const returned = await runtime.run({
      sessionId: "ses_test",
      code: `"y".repeat(20000)`,
    })
    expect(returned.error).toBeUndefined()
    expect(returned.result).toContain("[output truncated]")
    expect(Buffer.byteLength(returned.result ?? "", "utf8")).toBeLessThan(4300)
  })

  test("truncates oversized error messages", async () => {
    const runtime = new BrowserJsRuntime({ port: new FakePort(), maxOutputBytes: 4096 })
    const result = await runtime.run({
      sessionId: "ses_test",
      code: `throw new Error("e".repeat(20000))`,
    })

    expect(result.error?.message).toContain("[output truncated]")
    expect(Buffer.byteLength(result.error?.message ?? "", "utf8")).toBeLessThan(4300)
  })

  test("deduplicates byte-identical emitted images", async () => {
    const result = await makeRuntime(new FakePort()).run({
      sessionId: "ses_test",
      code: [
        `const bytes = new Uint8Array([1, 2, 3]);`,
        `await nodeRepl.emitImage(bytes);`,
        `await nodeRepl.emitImage(bytes);`,
        `await nodeRepl.emitImage(new Uint8Array([9, 9, 9]));`,
        `"ok"`,
      ].join("\n"),
    })

    expect(result.error).toBeUndefined()
    expect(result.images?.length).toBe(2)
  })

  test("supports disabling the worker heap limit", async () => {
    const runtime = new BrowserJsRuntime({ port: new FakePort(), workerHeapLimitMb: false })
    const result = await runtime.run({ sessionId: "ses_test", code: `1 + 1` })

    expect(result.error).toBeUndefined()
    expect(result.result).toBe("2")
    expect(runtime.lastIsolation).toBe("worker")
  })
})

describe("host response limits", () => {
  test("flags oversized image payloads without serializing them", () => {
    const image: BrowserCommandResult = {
      ok: true,
      image: { base64: "AAAA", mimeType: "image/png" },
      elapsedMs: 1,
    }
    expect(responseOversizeReason(image, 3)).toContain("exceeded")
    expect(responseOversizeReason(image, 1024)).toBeUndefined()
  })

  test("flags oversized string values and serialized results", () => {
    const value: BrowserCommandResult = { ok: true, value: "x".repeat(100), elapsedMs: 1 }
    expect(responseOversizeReason(value, 10)).toContain("exceeded")
    expect(responseOversizeReason({ ok: true, value: 42, elapsedMs: 1 }, 64)).toBeUndefined()
    expect(MAX_HOST_RESPONSE_BYTES).toBe(32 * 1024 * 1024)
  })
})
