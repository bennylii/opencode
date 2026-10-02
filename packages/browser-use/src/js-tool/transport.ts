import type { BrowserClientTransport } from "../facade/index.js"
import type { BrowserControlPort } from "../contracts.js"
import type { NodeReplImage } from "../kernel/index.js"

export interface BrowserRunTransportOptions {
  port: BrowserControlPort
  sessionId: string
  turnId?: string
  signal?: AbortSignal
  onScreenshot?(image: NodeReplImage): void
}

/**
 * 把 host 的 BrowserControlPort 适配成 facade 需要的 BrowserClientTransport。
 *
 * ZCode 里这一跳走 socket broker（node_repl 是独立 MCP 进程）；opencode 里
 * kernel 与运行时同进程，直接调用，并把真实 screenshot 载荷登记回会话，
 * 供 browserScreenshotImageIndices 做来源对应。
 */
export function createBrowserRunTransport(options: BrowserRunTransportOptions): BrowserClientTransport {
  return {
    list: async () =>
      await options.port.list({
        sessionId: options.sessionId,
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    execute: async (browserId, browserGeneration, command) => {
      const result = await options.port.execute({
        browserId,
        browserGeneration,
        sessionId: options.sessionId,
        ...(options.turnId ? { turnId: options.turnId } : {}),
        command,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (result.ok && command.method === "screenshot" && result.image) {
        options.onScreenshot?.(result.image)
      }
      return result
    },
  }
}
