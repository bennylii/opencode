export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "url"
// @ts-expect-error npm does not publish types for this internal config API.
import Config from "@npmcli/config"
// @ts-expect-error npm does not publish types for this internal config API.
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect } from "effect"

const npmPath = fileURLToPath(new URL("..", import.meta.url))

export const load = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const config = new Config({
        npmPath,
        cwd: dir,
        env: { ...process.env },
        argv: [process.execPath, process.execPath],
        execPath: process.execPath,
        platform: process.platform,
        definitions,
        flatten,
        nerfDarts,
        shorthands,
        warn: false,
      })
      // npm only reads the project .npmrc when it detects a local prefix
      // (package.json or node_modules). This API already knows the project
      // directory, so pin it explicitly and skip that detection.
      config.localPrefix = dir
      await config.load()
      return config.flat as Record<string, unknown>
    },
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))

export const registry = (dir: string) =>
  load(dir).pipe(
    Effect.map((config) => {
      const registry = typeof config.registry === "string" ? config.registry : "https://registry.npmjs.org"
      return registry.endsWith("/") ? registry.slice(0, -1) : registry
    }),
  )
