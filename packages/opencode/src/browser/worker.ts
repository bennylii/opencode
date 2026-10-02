// 编译版 Worker 入口 shim：script/build.ts 把本文件作为嵌入 entrypoint，
// 并通过 define OPENCODE_BROWSER_USE_WORKER_PATH 指向它。
// 开发版不会加载本文件（js-tool 直接使用包内的 worker.ts）。
import "@opencode-ai/browser-use/worker"
