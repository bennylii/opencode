import { MessageChannel, Worker } from "node:worker_threads"
import type { BrowserControlPort } from "../contracts.js"
import type { BrowserDocsBundle } from "../facade/documentation.js"
import { setupBrowserRuntime } from "../facade/index.js"
import { NodeReplSession, type NodeReplImage, type NodeReplRunResult } from "../kernel/index.js"
import { DEFAULT_TIMEOUT_MS, JS_TOOL_DESCRIPTION, MAX_TIMEOUT_MS } from "./contract.js"
import { runBrowserKernel } from "./kernel-run.js"
import {
  BROWSER_JS_WORKER_KIND,
  attachHostBrowserControlPort,
  type WorkerCallMessage,
  type WorkerResultMessage,
} from "./worker-protocol.js"
import { createBrowserRunTransport } from "./transport.js"

export { DEFAULT_TIMEOUT_MS, JS_TOOL_DESCRIPTION, MAX_TIMEOUT_MS }
export type { BrowserClientTransport, BrowserAvailabilityGuard } from "../facade/index.js"

/** 每次调用额外预留的 Wall-clock 宽限，覆盖 Worker 启动与结构化克隆。 */
const WORKER_GRACE_MS = 2_000

/** 一次性 kernel Worker 的默认堆上限（JSC 合并 old/young 为一个上限）。 */
export const DEFAULT_WORKER_HEAP_LIMIT_MB = 512

/**
 * 编译版由宿主 build 注入（Bun define），指向嵌入的 worker 入口；
 * 开发版走相对源码路径。见 opencode 的 script/build.ts。
 */
declare const OPENCODE_BROWSER_USE_WORKER_PATH: string | undefined

function resolveWorkerTarget(): string | URL {
  if (typeof OPENCODE_BROWSER_USE_WORKER_PATH !== "undefined") {
    return OPENCODE_BROWSER_USE_WORKER_PATH
  }
  return new URL("./worker.ts", import.meta.url)
}

export type BrowserJsIsolation = "worker" | "in-process"

export interface BrowserJsRuntimeOptions {
  /** 进程内 headless CDP 运行时（按宿主的 session 粒度持有）。 */
  port: BrowserControlPort
  /** docs/ 目录，提供 api.json / documents.json 与能力文档。 */
  documentationRoot?: string
  /** 内嵌文档包，优先于 documentationRoot（编译后的二进制用）。 */
  docs?: BrowserDocsBundle
  /** 每次调用前的可用性守卫（宿主用它拒绝 subagent 或未启用场景）。 */
  assertAvailable?: () => void
  /** 动态模块加载策略；缺省拒绝一切宿主模块导入。传入时强制 in-process 执行。 */
  loadModule?: (specifier: string) => Promise<unknown>
  /**
   * kernel 隔离级别。`worker`（默认）每次调用 spawn 一个一次性 Worker，
   * 调用结束即 terminate，连模块缓存与用户代码分配一起回收；Worker 不可用时
   * 自动回退 `in-process`（fresh vm context）。
   */
  isolation?: BrowserJsIsolation
  /** 单次调用的模型可见输出预算（日志与返回值各自计算），默认 1MiB。 */
  maxOutputBytes?: number
  /**
   * Worker 堆上限（MB）。默认 512；`false` 关闭限制。
   *
   * 注意：Bun 1.4.2 只回显该选项、尚未执行限制；上游 enforcement 落地后
   * 超限会以 ERR_WORKER_OUT_OF_MEMORY 终止 Worker 而不是拖垮宿主进程。
   */
  workerHeapLimitMb?: number | false
}

export interface BrowserJsRunInput {
  code: string
  /** 宿主会话路由信息，进入 nodeRepl.requestMeta 并透传给 BrowserControlPort。 */
  sessionId: string
  turnId?: string
  timeoutMs?: number
  signal?: AbortSignal
  requestMeta?: Record<string, unknown>
}

/**
 * BrowserJsRuntime —— 一次 `js` 工具调用的执行器。
 *
 * 每次 run 都是 fresh kernel：JS 顶层绑定不跨调用持久，
 * BrowserControl 的 tab 状态由 port 侧持有。
 */
export class BrowserJsRuntime {
  readonly #options: BrowserJsRuntimeOptions
  #workerUnavailable = false
  #lastIsolation: BrowserJsIsolation | undefined

  constructor(options: BrowserJsRuntimeOptions) {
    this.#options = options
  }

  /** 最近一次调用实际使用的隔离级别（诊断用）。 */
  get lastIsolation(): BrowserJsIsolation | undefined {
    return this.#lastIsolation
  }

  async run(input: BrowserJsRunInput): Promise<NodeReplRunResult> {
    this.#options.assertAvailable?.()
    // loadModule 是宿主函数，无法跨 Worker；显式传入时走 in-process。
    const isolation: BrowserJsIsolation = this.#options.loadModule
      ? "in-process"
      : (this.#options.isolation ?? "worker")
    if (isolation === "worker" && !this.#workerUnavailable) {
      const viaWorker = await this.#runInWorker(input)
      if (viaWorker !== undefined) {
        this.#lastIsolation = "worker"
        return viaWorker
      }
      this.#workerUnavailable = true
    }
    this.#lastIsolation = "in-process"
    return await this.#runInProcess(input)
  }

  async #runInProcess(input: BrowserJsRunInput): Promise<NodeReplRunResult> {
    let session: NodeReplSession | undefined
    const transport = createBrowserRunTransport({
      port: this.#options.port,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      onScreenshot: (image: NodeReplImage) => session?.recordBrowserScreenshot(image),
    })
    session = new NodeReplSession({
      restrictProcess: true,
      ...(this.#options.loadModule ? { loadModule: this.#options.loadModule } : {}),
      ...(this.#options.maxOutputBytes !== undefined
        ? { maxOutputBytes: this.#options.maxOutputBytes }
        : {}),
      injectedGlobals: () => {
        const globals: Record<string, unknown> = {}
        this.#setupGlobals(globals, transport)
        return globals
      },
    })
    try {
      return await session.run(input.code, {
        ...(input.signal ? { signal: input.signal } : {}),
        requestMeta: this.#requestMeta(input),
        syncTimeoutMs: Math.max(1, Math.trunc(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      })
    } finally {
      session.dispose()
    }
  }

  /**
   * 一次性 Worker 执行。返回 undefined 表示 Worker 无法启动（调用尚未产生任何副作用），
   * 调用方应回退 in-process；真正的运行期错误会以结果形式返回，绝不重试。
   */
  async #runInWorker(input: BrowserJsRunInput): Promise<NodeReplRunResult | undefined> {
    const heapLimitMb =
      this.#options.workerHeapLimitMb === false
        ? undefined
        : (this.#options.workerHeapLimitMb ?? DEFAULT_WORKER_HEAP_LIMIT_MB)
    let worker: Worker
    try {
      // Bun 运行时支持 `smol`（JSC 小堆）但 node:worker_threads 的 d.ts 未声明；
      // 用交叉类型表达，避免 any。
      const workerOptions: ConstructorParameters<typeof Worker>[1] & { smol?: boolean } = {
        workerData: { kind: BROWSER_JS_WORKER_KIND },
        smol: true,
        ...(heapLimitMb !== undefined
          ? {
              resourceLimits: {
                maxOldGenerationSizeMb: heapLimitMb,
                maxYoungGenerationSizeMb: Math.min(128, heapLimitMb),
              },
            }
          : {}),
      }
      worker = new Worker(resolveWorkerTarget(), workerOptions)
    } catch {
      return undefined
    }

    const channel = new MessageChannel()
    const timeoutMs = Math.max(1, Math.trunc(input.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    const detach = attachHostBrowserControlPort({
      port: channel.port1,
      control: this.#options.port,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    })

    return await new Promise<NodeReplRunResult | undefined>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        input.signal?.removeEventListener("abort", onAbort)
        worker.off("message", onMessage)
        worker.off("error", onError)
        worker.off("exit", onExit)
        detach()
      }
      const finish = (result: NodeReplRunResult) => {
        if (settled) return
        settled = true
        cleanup()
        void worker.terminate().catch(() => undefined)
        resolve(result)
      }
      const fail = (name: string, message: string) => finish({ logs: "", error: { name, message } })
      const onMessage = (message: unknown) => {
        const typed = message as WorkerResultMessage
        if (typed.type === "result") finish(typed.result)
        else fail(typed.error.name, typed.error.message)
      }
      const onError = (error: Error) => fail(error.name, error.message)
      const onExit = (code: number) => {
        if (settled) return
        fail(
          "WorkerExitError",
          `Browser kernel worker exited before returning a result (${code})`,
        )
      }
      const onAbort = () => {
        const reason = input.signal?.reason
        if (reason && typeof reason === "object" && "name" in reason) {
          fail(String(reason.name), reason instanceof Error ? reason.message : String(reason))
          return
        }
        fail("AbortError", typeof reason === "string" ? reason : "aborted")
      }

      worker.on("message", onMessage)
      worker.once("error", onError)
      worker.once("exit", onExit)
      input.signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(
        () =>
          fail(
            "TimeoutError",
            `Browser kernel worker did not settle within ${timeoutMs + WORKER_GRACE_MS} ms`,
          ),
        timeoutMs + WORKER_GRACE_MS,
      )

      try {
        worker.postMessage(
          {
            type: "call",
            kind: BROWSER_JS_WORKER_KIND,
            port: channel.port2,
            code: input.code,
            timeoutMs,
            sessionId: input.sessionId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            requestMeta: this.#requestMeta(input),
            ...(this.#options.docs ? { docs: this.#options.docs } : {}),
            ...(this.#options.documentationRoot
              ? { documentationRoot: this.#options.documentationRoot }
              : {}),
            ...(this.#options.maxOutputBytes !== undefined
              ? { maxOutputBytes: this.#options.maxOutputBytes }
              : {}),
          } satisfies WorkerCallMessage,
          [channel.port2],
        )
      } catch {
        if (!settled) {
          settled = true
          cleanup()
          void worker.terminate().catch(() => undefined)
          resolve(undefined)
        }
      }
    })
  }

  #setupGlobals(globals: Record<string, unknown>, transport: ReturnType<typeof createBrowserRunTransport>): void {
    setupBrowserRuntime({
      globals,
      transport,
      ...(this.#options.documentationRoot ? { documentationRoot: this.#options.documentationRoot } : {}),
      ...(this.#options.docs ? { docs: this.#options.docs } : {}),
      ...(this.#options.assertAvailable ? { assertAvailable: this.#options.assertAvailable } : {}),
    })
  }

  #requestMeta(input: BrowserJsRunInput): Record<string, unknown> {
    return {
      session_id: input.sessionId,
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      ...input.requestMeta,
    }
  }
}

export interface BrowserJsRenderedOutput {
  output: string
  images: NodeReplImage[]
  isError: boolean
  metadata: Record<string, unknown>
}

/**
 * 把 kernel 运行结果渲染成与 opencode ExecuteResult 一一对应的模型输出。
 * 图片由宿主转成附件；这里只负责文本与错误语义。
 */
export function renderBrowserJsOutput(run: NodeReplRunResult): BrowserJsRenderedOutput {
  if (run.error) {
    return {
      output: run.error.message,
      images: run.images ?? [],
      isError: true,
      metadata: { ...run.responseMeta },
    }
  }
  const textParts = [run.logs, run.result !== undefined ? `=> ${run.result}` : ""].filter(
    (part) => part.length > 0,
  )
  return {
    output: textParts.length > 0 ? textParts.join("\n") : "(no output)",
    images: run.images ?? [],
    isError: false,
    metadata: { ...run.responseMeta },
  }
}
