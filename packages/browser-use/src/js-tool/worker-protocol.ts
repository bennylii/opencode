import type { MessagePort } from "node:worker_threads"
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserControlPort,
} from "../contracts.js"
import type { BrowserDocsBundle } from "../facade/documentation.js"
import type { NodeReplRunResult } from "../kernel/index.js"

export const BROWSER_JS_WORKER_KIND = "opencode-browser-use-js-worker"

/**
 * 单条 Browser 命令响应的上限，对齐 ZCode broker 的 32 MiB。
 * 超过后返回结构化错误：避免图片/页面数据在 Worker 与宿主之间双份驻留。
 */
export const MAX_HOST_RESPONSE_BYTES = 32 * 1024 * 1024

/**
 * 主线程 → Worker 的单条调用消息。MessagePort 通过 transferList 转移，
 * Worker 侧用它建立反向的 BrowserControlPort RPC。
 */
export interface WorkerCallMessage {
  type: "call"
  kind: typeof BROWSER_JS_WORKER_KIND
  port: MessagePort
  code: string
  timeoutMs: number
  sessionId: string
  turnId?: string
  requestMeta: Record<string, unknown>
  docs?: BrowserDocsBundle
  documentationRoot?: string
  maxOutputBytes?: number
}

export type WorkerResultMessage =
  | { type: "result"; result: NodeReplRunResult }
  | { type: "failed"; error: { name: string; message: string } }

export type HostCall =
  | { op: "list" }
  | { op: "execute"; browserId: string; browserGeneration: number; command: BrowserCommand }

export type HostRequest = HostCall & { id: number }

export type HostResponse =
  | { id: number; ok: true; result: BrowserBackendDescriptor[] | BrowserCommandResult }
  | { id: number; ok: false; error: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Worker 侧：把端口请求包装成本地 BrowserControlPort，供 facade transport 使用。 */
export function createPortBrowserControlPort(port: MessagePort): BrowserControlPort {
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: BrowserBackendDescriptor[] | BrowserCommandResult) => void; reject: (error: Error) => void }
  >()
  port.on("message", (message: HostResponse) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  })
  port.start?.()

  const call = (request: HostCall) => {
    const id = nextId++
    return new Promise<BrowserBackendDescriptor[] | BrowserCommandResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      port.postMessage({ ...request, id } satisfies HostRequest)
    })
  }

  return {
    list: async () => (await call({ op: "list" })) as BrowserBackendDescriptor[],
    execute: async (input) =>
      (await call({
        op: "execute",
        browserId: input.browserId,
        browserGeneration: input.browserGeneration,
        command: input.command,
      })) as BrowserCommandResult,
  }
}

/** 主线程侧：把 Worker 的端口请求转发给真实运行时；返回解绑函数。 */
export function attachHostBrowserControlPort(input: {
  port: MessagePort
  control: BrowserControlPort
  sessionId: string
  turnId?: string
}): () => void {
  const respond = (response: HostResponse) => input.port.postMessage(response)
  const onMessage = (request: HostRequest) => {
    if (request.op === "list") {
      input.control
        .list({
          sessionId: input.sessionId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        })
        .then(
          (result) => respond({ id: request.id, ok: true, result }),
          (error) => respond({ id: request.id, ok: false, error: messageOf(error) }),
        )
      return
    }
    input.control
      .execute({
        browserId: request.browserId,
        browserGeneration: request.browserGeneration,
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        command: request.command,
      })
      .then(
        (result) => {
          const oversize = responseOversizeReason(result)
          if (oversize) {
            respond({ id: request.id, ok: false, error: oversize })
            return
          }
          respond({ id: request.id, ok: true, result })
        },
        (error) => respond({ id: request.id, ok: false, error: messageOf(error) }),
      )
  }
  input.port.on("message", onMessage)
  input.port.start?.()
  return () => {
    input.port.off("message", onMessage)
    input.port.close()
  }
}

export function responseOversizeReason(
  result: BrowserCommandResult,
  maxBytes = MAX_HOST_RESPONSE_BYTES,
): string | undefined {
  const message = `Browser response exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`
  // 图片先走特判：对带图结果做 JSON.stringify 会额外复制一份巨串，正是要避免的双份驻留。
  if (result.image) {
    return result.image.base64.length > maxBytes ? message : undefined
  }
  if (typeof result.value === "string" && result.value.length > maxBytes) {
    return message
  }
  try {
    if (JSON.stringify(result).length > maxBytes) {
      return message
    }
  } catch {
    return "Browser response could not be serialized"
  }
  return undefined
}
