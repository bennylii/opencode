import { BrowserJsRuntime } from "@opencode-ai/browser-use"
import type { BrowserControlPort } from "@opencode-ai/browser-use/contracts"

const port: BrowserControlPort = {
  list: async () => [],
  execute: async () => ({ ok: true, elapsedMs: 1 }),
}

const runtime = new BrowserJsRuntime({ port })
const result = await runtime.run({
  sessionId: "ses_compile",
  code: `globalThis.__leak = 1; nodeRepl.write("compile-kernel-ok"); 1 + 1`,
})
const second = await runtime.run({
  sessionId: "ses_compile",
  code: `typeof globalThis.__leak`,
})

console.log(
  JSON.stringify({
    isolation: runtime.lastIsolation,
    result: result.result,
    logs: result.logs,
    error: result.error,
    leakAfterSecondCall: second.result,
  }),
)
process.exit(0)
