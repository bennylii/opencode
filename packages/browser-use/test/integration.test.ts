import { afterAll, describe, expect, test } from "bun:test"
import { BrowserJsRuntime } from "../src/js-tool/index.js"
import { createManagedCdpBrowserRuntime, type ManagedCdpBrowserRuntime } from "../src/runtime/index.js"
import { loadPlaywrightChromium, resolveInstalledBrowserExecutable } from "../src/runtime/executable.js"

async function findBrowserExecutable(): Promise<string | undefined> {
  try {
    return resolveInstalledBrowserExecutable(await loadPlaywrightChromium())
  } catch {
    return undefined
  }
}

const executablePath = await findBrowserExecutable()

const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(
      [
        "<!doctype html><html><head><title>Browser Use IT</title></head><body>",
        '<h1>Integration fixture</h1>',
        '<button id="go" type="button">Click me</button>',
        "<script>",
        "document.getElementById('go').addEventListener('click', () => {",
        "  document.body.dataset.clicked = 'yes'",
        "})",
        "</script>",
        "</body></html>",
      ].join("\n"),
      { headers: { "content-type": "text/html" } },
    )
  },
})

let runtime: ManagedCdpBrowserRuntime | undefined

afterAll(async () => {
  await runtime?.close()
  await server.stop(true)
})

describe("managed headless CDP runtime", () => {
  test.skipIf(!executablePath)(
    "drives a real browser through the js kernel",
    async () => {
      runtime = createManagedCdpBrowserRuntime({ executablePath })
      const js = new BrowserJsRuntime({
        port: runtime.browserControlPort,
      })
      const result = await js.run({
        sessionId: "ses_it",
        timeoutMs: 60_000,
        code: [
          `const browser = await agent.browsers.getDefault()`,
          `const tab = await browser.tabs.new()`,
          `await tab.goto(${JSON.stringify(`http://127.0.0.1:${server.port}/`)})`,
          `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })`,
          `const snapshot = await tab.playwright.domSnapshot()`,
          `nodeRepl.write("snapshot=" + typeof snapshot)`,
          `await tab.playwright.getByRole("button", { name: "Click me" }).click()`,
          `await tab.playwright.evaluate("document.body.dataset.clicked")`,
        ].join("\n"),
      })

      expect(result.error?.message).toBeUndefined()
      expect(result.logs).toContain("snapshot=")
      expect(result.result).toBe("yes")
    },
    120_000,
  )

  test.skipIf(!executablePath)(
    "recycles a session context and allows the same session to reopen",
    async () => {
      const recycled = createManagedCdpBrowserRuntime({ executablePath })
      const js = new BrowserJsRuntime({ port: recycled.browserControlPort })
      try {
        const opened = await js.run({
          sessionId: "ses_recycle",
          timeoutMs: 60_000,
          code: [
            `const browser = await agent.browsers.getDefault();`,
            `await browser.tabs.new();`,
            `(await browser.tabs.list()).length;`,
          ].join("\n"),
        })
        expect(opened.error?.message).toBeUndefined()
        expect(opened.result).toBe("1")

        await recycled.browserControlPort.closeSession?.({ sessionId: "ses_recycle" })

        const reopened = await js.run({
          sessionId: "ses_recycle",
          timeoutMs: 60_000,
          code: [
            `const browser = await agent.browsers.getDefault();`,
            `(await browser.tabs.list()).length;`,
          ].join("\n"),
        })
        expect(reopened.error?.message).toBeUndefined()
        expect(reopened.result).toBe("0")
      } finally {
        await recycled.close()
      }
    },
    120_000,
  )
})
