import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
  type PlaywrightChromiumModule,
} from "../src/runtime/executable.js"

function fakePlaywright(executablePath: string | undefined): PlaywrightChromiumModule {
  return {
    chromium: {
      executablePath: () => executablePath,
    } as unknown as PlaywrightChromiumModule["chromium"],
  }
}

function makeExecutableFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-use-"))
  const path = join(dir, name)
  writeFileSync(path, "")
  return path
}

function makeInstalledSystemChrome(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "browser-use-programs-"))
  const path = join(root, "Google", "Chrome", "Application", "chrome.exe")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "")
  return { root, path }
}

describe("validateExplicitBrowserExecutable", () => {
  test("returns undefined for missing input", () => {
    expect(validateExplicitBrowserExecutable(undefined)).toBeUndefined()
  })

  test("rejects relative paths", () => {
    expect(() => validateExplicitBrowserExecutable("chrome.exe")).toThrow("absolute")
  })

  test("accepts an existing absolute file", () => {
    const path = makeExecutableFile("chrome.exe")
    expect(validateExplicitBrowserExecutable(path)).toBe(path)
  })

  test("rejects a missing file", () => {
    const path = join(tmpdir(), "browser-use-definitely-missing", "chrome.exe")
    expect(() => validateExplicitBrowserExecutable(path)).toThrow("missing")
  })
})

describe("resolveInstalledBrowserExecutable", () => {
  test("prefers a system browser over the Playwright path", () => {
    const system = makeInstalledSystemChrome()
    const playwright = makeExecutableFile("chromium")
    const resolved = resolveInstalledBrowserExecutable(fakePlaywright(playwright), {
      platform: "win32",
      env: { PROGRAMFILES: system.root },
    })
    expect(resolved).toBe(system.path)
  })

  test("falls back to the Playwright Chromium path", () => {
    const playwright = makeExecutableFile("chromium")
    const resolved = resolveInstalledBrowserExecutable(fakePlaywright(playwright), {
      platform: "win32",
      env: { PROGRAMFILES: join(tmpdir(), "browser-use-empty-programs") },
    })
    expect(resolved).toBe(playwright)
  })

  test("fails with an actionable message when nothing is found", () => {
    expect(() =>
      resolveInstalledBrowserExecutable(fakePlaywright(undefined), {
        platform: "win32",
        env: { PROGRAMFILES: join(tmpdir(), "browser-use-empty-programs") },
      }),
    ).toThrow("playwright install chromium")
  })
})
