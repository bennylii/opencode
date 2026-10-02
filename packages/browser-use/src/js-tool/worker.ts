import { isMainThread, parentPort, workerData } from "node:worker_threads"
import { runBrowserKernel } from "./kernel-run.js"
import {
  BROWSER_JS_WORKER_KIND,
  createPortBrowserControlPort,
  type WorkerCallMessage,
  type WorkerResultMessage,
} from "./worker-protocol.js"

/**
 * 一次性 JS kernel Worker 入口。
 *
 * 主线程每次 `js` 调用 spawn 一个这样的 Worker，拿到结果后立即 terminate：
 * vm context、用户代码分配、闭包全部随线程一起回收，且不污染宿主线程的模块缓存。
 */
if (!isMainThread && (workerData as { kind?: unknown } | undefined)?.kind === BROWSER_JS_WORKER_KIND) {
  parentPort?.on("message", (message: WorkerCallMessage) => {
    void handle(message)
  })
}

async function handle(message: WorkerCallMessage): Promise<void> {
  try {
    const result = await runBrowserKernel({
      code: message.code,
      timeoutMs: message.timeoutMs,
      requestMeta: message.requestMeta,
      sessionId: message.sessionId,
      port: createPortBrowserControlPort(message.port),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.docs ? { docs: message.docs } : {}),
      ...(message.documentationRoot ? { documentationRoot: message.documentationRoot } : {}),
      ...(message.maxOutputBytes !== undefined ? { maxOutputBytes: message.maxOutputBytes } : {}),
    })
    parentPort?.postMessage({ type: "result", result } satisfies WorkerResultMessage)
  } catch (error) {
    parentPort?.postMessage({
      type: "failed",
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies WorkerResultMessage)
  }
}
