import { inspect } from "node:util";

export const PROCESS_MODULE_IDS = new Set(["process", "node:process"]);

export function createRestrictedProcessFacade(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    arch: process.arch,
    argv: Object.freeze([...process.argv]),
    cwd: () => process.cwd(),
    env: Object.freeze({ ...process.env }),
    execArgv: Object.freeze([...process.execArgv]),
    execPath: process.execPath,
    hrtime: process.hrtime.bind(process),
    memoryUsage: process.memoryUsage.bind(process),
    nextTick: process.nextTick.bind(process),
    pid: process.pid,
    platform: process.platform,
    release: Object.freeze({ ...process.release }),
    resourceUsage: process.resourceUsage.bind(process),
    uptime: process.uptime.bind(process),
    version: process.version,
    versions: Object.freeze({ ...process.versions }),
  });
}

export function createReplRequire(
  baseRequire: NodeJS.Require,
  restrictedProcess: Readonly<Record<string, unknown>> | undefined,
): NodeJS.Require {
  if (!restrictedProcess) return baseRequire;
  const facade = ((specifier: string) =>
    PROCESS_MODULE_IDS.has(specifier)
      ? restrictedProcess
      : baseRequire(specifier)) as NodeJS.Require;
  facade.cache = baseRequire.cache;
  facade.extensions = baseRequire.extensions;
  facade.main = baseRequire.main;
  facade.resolve = baseRequire.resolve;
  return facade;
}

export const OUTPUT_TRUNCATION_MARKER = "… [output truncated]";

/**
 * 按 UTF-8 字节上限截断文本，并追加截断标记。
 *
 * kernel 运行在一次性 Worker 里，但无上限的日志/返回值仍会在截断前把 Worker 堆和
 * 跨端口克隆量推高；所有模型可见的字符串都必须经过这里。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return OUTPUT_TRUNCATION_MARKER;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = `\n${OUTPUT_TRUNCATION_MARKER}`;
  const headBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const head = Buffer.from(text, "utf8").subarray(0, headBytes).toString("utf8");
  return `${head}${marker}`;
}

export function stringifyReplResult(value: unknown, maxBytes?: number): string | undefined {
  const finish = (text: string): string => (maxBytes === undefined ? text : truncateUtf8(text, maxBytes));
  if (value === undefined) return undefined;
  if (typeof value === "string") return finish(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // screenshot() 返回 Uint8Array；JSON.stringify 会把每个字节展开成数字键，
    // 因此使用有界 inspect，避免二进制结果膨胀为大段数字文本。
    return finish(inspect(value, { maxArrayLength: 100 }));
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return finish(json === undefined ? String(value) : json);
  } catch {
    return finish(String(value));
  }
}

/** vm context 的 Error 属于不同 realm，按 error-like 字段提取，避免 instanceof 误判。 */
export function normalizeReplError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof value.name === "string" ? value.name : "Error";
    const message = typeof value.message === "string" ? value.message : String(error);
    const stack = typeof value.stack === "string" ? value.stack : undefined;
    return { name, message, stack };
  }
  return { name: "Error", message: String(error) };
}
