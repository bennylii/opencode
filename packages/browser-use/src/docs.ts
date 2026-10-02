import apiJson from "../resources/docs/api.json"
import documentsJson from "../resources/docs/documents.json"
import browserTroubleshooting from "../resources/docs/browser-troubleshooting.md" with { type: "text" }
import overview from "../resources/docs/overview.md" with { type: "text" }
import playwrightDoc from "../resources/docs/playwright.md" with { type: "text" }
import safety from "../resources/docs/safety.md" with { type: "text" }
import screenshot from "../resources/docs/screenshot.md" with { type: "text" }
import viewport from "../resources/docs/viewport.md" with { type: "text" }
import workflow from "../resources/docs/workflow.md" with { type: "text" }
import controlBrowserSkill from "../resources/skills/control-browser/SKILL.md" with { type: "text" }
import webGuiTesterSkill from "../resources/skills/web-gui-tester/SKILL.md" with { type: "text" }
import type { BrowserDocsBundle } from "./facade/documentation.js"

const apiJsonText = JSON.stringify(apiJson)
const documentsJsonText = JSON.stringify(documentsJson)

/**
 * 内嵌文档与技能内容：编译后的 opencode 二进制不保证能读到包内文件，
 * 因此把 docs/ 与 skills/ 以文本形式打进 bundle 交给运行时。
 */
export const BrowserUseDocs: BrowserDocsBundle = {
  apiJson: apiJsonText,
  documentsJson: documentsJsonText,
  files: {
    "api.json": apiJsonText,
    "documents.json": documentsJsonText,
    "browser-troubleshooting.md": browserTroubleshooting,
    "overview.md": overview,
    "playwright.md": playwrightDoc,
    "safety.md": safety,
    "screenshot.md": screenshot,
    "viewport.md": viewport,
    "workflow.md": workflow,
  },
}

export { controlBrowserSkill, webGuiTesterSkill }
export type { BrowserDocsBundle }

export interface EmbeddedSkill {
  name: string
  description: string
  content: string
}

function parseEmbeddedSkill(raw: string, fallbackName: string): EmbeddedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw)
  const frontmatter = match?.[1] ?? ""
  const body = match ? raw.slice(match[0].length) : raw
  const name = /^name:\s*"?([^"\r\n]+)"?\s*$/mu.exec(frontmatter)?.[1]?.trim() ?? fallbackName
  const description = /^description:\s*"?([\s\S]*?)"?\s*$/mu.exec(frontmatter)?.[1]?.trim() ?? ""
  return { name, description, content: body.trim() }
}

/** 预解析的两个官方 Browser Use 技能，供宿主直接注册为内置 skill。 */
export const BrowserUseSkills: readonly EmbeddedSkill[] = [
  parseEmbeddedSkill(controlBrowserSkill, "control-browser"),
  parseEmbeddedSkill(webGuiTesterSkill, "web-gui-tester"),
]
