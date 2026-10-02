import type { BrowserControlPort } from "../contracts.js"
import type { BrowserDocsBundle } from "../facade/documentation.js"
import { setupBrowserRuntime } from "../facade/index.js"
import { NodeReplSession, type NodeReplRunResult } from "../kernel/index.js"
import { createBrowserRunTransport } from "./transport.js"

export interface KernelRunInput {
  code: string
  timeoutMs: number
  requestMeta: Record<string, unknown>
  port: BrowserControlPort
  sessionId: string
  turnId?: string
  docs?: BrowserDocsBundle
  documentationRoot?: string
  assertAvailable?: () => void
  signal?: AbortSignal
  loadModule?: (specifier: string) => Promise<unknown>
  maxOutputBytes?: number
}

/**
 * 在调用方线程内执行一个 fresh kernel。Worker 隔离入口与 in-process 回退共用，
 * 保证两条路径的注入对象、超时和截图登记语义完全一致。
 */
export async function runBrowserKernel(input: KernelRunInput): Promise<NodeReplRunResult> {
  let session: NodeReplSession | undefined
  const transport = createBrowserRunTransport({
    port: input.port,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    onScreenshot: (image) => session?.recordBrowserScreenshot(image),
  })
  session = new NodeReplSession({
    restrictProcess: true,
    ...(input.loadModule ? { loadModule: input.loadModule } : {}),
    ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    injectedGlobals: () => {
      const globals: Record<string, unknown> = {}
      setupBrowserRuntime({
        globals,
        transport,
        ...(input.documentationRoot ? { documentationRoot: input.documentationRoot } : {}),
        ...(input.docs ? { docs: input.docs } : {}),
        ...(input.assertAvailable ? { assertAvailable: input.assertAvailable } : {}),
      })
      return globals
    },
  })
  try {
    return await session.run(input.code, {
      ...(input.signal ? { signal: input.signal } : {}),
      requestMeta: input.requestMeta,
      syncTimeoutMs: Math.max(1, Math.trunc(input.timeoutMs)),
    })
  } finally {
    session.dispose()
  }
}
