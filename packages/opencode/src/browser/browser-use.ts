import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  BrowserJsRuntime,
  BrowserUseDocs,
  createManagedCdpBrowserRuntime,
  renderBrowserJsOutput,
  type BrowserJsRenderedOutput,
  type ManagedCdpBrowserRuntime,
} from "@opencode-ai/browser-use"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"

/**
 * 无活跃 `js` 调用后回收 Chromium 的空闲窗口。
 * 浏览器进程常驻约 100MB+ RSS；opencode 是长驻进程，空闲回收比多等一次冷启动更划算。
 */
const IDLE_CLOSE_MS = 10 * 60_000

/**
 * 单个 session 的 BrowserContext 空闲回收窗口。比整体关闭更细粒度：
 * 页面/渲染器内存按会话释放，浏览器进程保留待命。
 */
const SESSION_IDLE_CLOSE_MS = 15 * 60_000

/** 内存遥测采样间隔（只在浏览器运行时存活期间记录 debug 日志）。 */
const MEMORY_SAMPLE_MS = 60_000

export interface RunInput {
  sessionId: string
  turnId?: string
  code: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<BrowserJsRenderedOutput>
  /** 释放指定会话的 BrowserContext；空闲时运行时会把整个浏览器一起关掉。 */
  readonly closeSession: (sessionId: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserUse") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    // 进程级共享：一个 headless Chromium 进程，BrowserContext 按 opencode session 隔离。
    // tab 状态因此跨 turn 存活，与 ZCode 的进程内 browser 语义一致。
    let runtime: ManagedCdpBrowserRuntime | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let activeRuns = 0
    const sessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const cancelIdle = () => {
      if (!idleTimer) return
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const clearSessionIdleTimer = (sessionId: string) => {
      const timer = sessionIdleTimers.get(sessionId)
      if (timer === undefined) return
      clearTimeout(timer)
      sessionIdleTimers.delete(sessionId)
    }
    const clearAllSessionIdleTimers = () => {
      for (const timer of sessionIdleTimers.values()) clearTimeout(timer)
      sessionIdleTimers.clear()
    }
    /**
     * 立即释放某个会话的 BrowserContext（与 Effect 无关的底层实现，
     * 供 timer / session.deleted / Effect 包装三处共用）。
     */
    const closeSessionNow = (sessionId: string): Promise<void> => {
      clearSessionIdleTimer(sessionId)
      const current = runtime
      if (!current) return Promise.resolve()
      const closing = current.browserControlPort.closeSession?.({ sessionId })
      return closing ? closing.catch(() => undefined) : Promise.resolve()
    }
    const scheduleSessionIdleClose = (sessionId: string) => {
      clearSessionIdleTimer(sessionId)
      if (!runtime) return
      const timer = setTimeout(() => {
        sessionIdleTimers.delete(sessionId)
        void closeSessionNow(sessionId)
      }, SESSION_IDLE_CLOSE_MS)
      unrefTimer(timer)
      sessionIdleTimers.set(sessionId, timer)
    }
    const closeRuntime = () => {
      cancelIdle()
      clearAllSessionIdleTimers()
      const current = runtime
      runtime = undefined
      if (current) void current.close().catch(() => undefined)
    }
    const ensureRuntime = () => {
      cancelIdle()
      if (runtime) return runtime
      runtime = createManagedCdpBrowserRuntime()
      process.once("exit", () => {
        void runtime?.close()
      })
      return runtime
    }
    const scheduleIdleClose = () => {
      cancelIdle()
      if (activeRuns > 0 || !runtime) return
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        if (activeRuns === 0) closeRuntime()
      }, IDLE_CLOSE_MS)
      unrefTimer(idleTimer)
    }

    const closeSession = Effect.fn("BrowserUse.closeSession")(function* (sessionId: string) {
      yield* Effect.promise(() => closeSessionNow(sessionId))
    })

    const run = Effect.fn("BrowserUse.run")(function* (input: RunInput) {
      const js = new BrowserJsRuntime({
        port: ensureRuntime().browserControlPort,
        docs: BrowserUseDocs,
      })
      activeRuns += 1
      try {
        const result = yield* Effect.promise(() =>
          js.run({
            code: input.code,
            sessionId: input.sessionId,
            timeoutMs: input.timeoutMs,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        )
        return renderBrowserJsOutput(result)
      } finally {
        activeRuns -= 1
        scheduleSessionIdleClose(input.sessionId)
        scheduleIdleClose()
      }
    })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== "session.deleted") return Effect.void
      const sessionID = (event.data as { sessionID?: unknown }).sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) return Effect.void
      return closeSession(sessionID)
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    // 内存遥测：浏览器进程存续期间周期记录宿主 RSS/heap，用于验证回收策略效果。
    yield* Effect.gen(function* () {
      if (!runtime) return
      const usage = process.memoryUsage()
      yield* Effect.logDebug("browser-use.memory", {
        event: "browser_use.memory",
        rssKb: Math.round(usage.rss / 1024),
        heapUsedKb: Math.round(usage.heapUsed / 1024),
        externalKb: Math.round(usage.external / 1024),
        sessionIdleTimers: sessionIdleTimers.size,
        activeRuns,
      })
    }).pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(MEMORY_SAMPLE_MS))),
      Effect.forkScoped,
    )

    return Service.of({ run, closeSession })
  }),
)

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref()
  }
}

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node] })

export * as BrowserUse from "./browser-use"
