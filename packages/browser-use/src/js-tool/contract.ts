/**
 * `js` 工具的模型可见契约。移植自 zai-org/ZCode 的 node-repl-host（Apache-2.0），
 * 已裁剪 Computer Use 与 MCP 专属措辞：opencode 版只服务 Browser Use，
 * 且宿主动态模块导入默认关闭。
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;

export const JS_TOOL_DESCRIPTION =
  "Browser Use only. Run JavaScript in a fresh confined kernel with top-level await, only as instructed by the " +
  "built-in `control-browser` / `web-gui-tester` skills to control the headless browser. Do not use it as a " +
  "general-purpose JavaScript runtime or for filesystem, shell, package inspection, data processing, or other " +
  "non-browser work. The kernel exposes `agent.browsers` and `nodeRepl`; dynamic `import()` and `require` are " +
  "disabled, and global bindings do not persist across calls. " +
  `If \`timeout_ms\` is omitted, execution times out after ${DEFAULT_TIMEOUT_MS} ms. If the code may take more than ` +
  "30000 ms including all awaited operations, you MUST set `timeout_ms` to at least the estimated total runtime " +
  `plus 15000 ms; split the work into multiple calls if that exceeds the ${MAX_TIMEOUT_MS} ms maximum. ` +
  "Every call starts a fresh kernel: rebuild `const browser = await agent.browsers.getDefault()` (or the verified " +
  "backend selection) on every call and recover tabs from `browser.tabs.list()`. " +
  "Use `nodeRepl.write(value)` for short progress/status text, `nodeRepl.setResponseMeta(meta)` for structured " +
  "metadata, and `await nodeRepl.emitImage(imageLike)` to return a screenshot as an image content block. " +
  "Read the effective API surface once with `nodeRepl.write(await browser.documentation())` before driving it."
