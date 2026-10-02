import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { BrowserUse } from "../src/browser/browser-use"

console.log("smoke: starting")
const watchdog = setTimeout(() => {
  console.error("smoke: watchdog timeout")
  process.exit(2)
}, 120_000)

const program = Effect.gen(function* () {
  const service = yield* BrowserUse.Service
  const sessionId = "ses_smoke"

  const opened = yield* service.run({
    sessionId,
    timeoutMs: 60_000,
    code: [
      `const browsers = await agent.browsers.list();`,
      `const browser = await agent.browsers.getDefault();`,
      `const docs = await browser.documentation();`,
      `const tab = await browser.tabs.new();`,
      `await tab.goto("about:blank");`,
      `nodeRepl.write("backends=" + browsers.map((item) => item.type).join(","));`,
      `nodeRepl.write("docs=" + docs.length);`,
      `({ tabs: (await browser.tabs.list()).length });`,
    ].join("\n"),
  })

  const beforeClose = yield* service.run({
    sessionId,
    timeoutMs: 60_000,
    code: [
      `const browser = await agent.browsers.getDefault();`,
      `(await browser.tabs.list()).length;`,
    ].join("\n"),
  })

  yield* service.closeSession(sessionId)

  const afterClose = yield* service.run({
    sessionId,
    timeoutMs: 60_000,
    code: [
      `const browser = await agent.browsers.getDefault();`,
      `(await browser.tabs.list()).length;`,
    ].join("\n"),
  })

  return { opened, beforeClose, afterClose }
})

const { opened, beforeClose, afterClose } = await Effect.runPromise(
  program.pipe(Effect.provide(LayerNode.compile(BrowserUse.node))),
)
console.log(JSON.stringify({ opened, beforeClose, afterClose }, null, 2))
clearTimeout(watchdog)
process.exit(0)
