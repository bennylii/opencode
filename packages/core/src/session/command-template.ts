export * as CommandTemplate from "./command-template"

const ARGUMENT_PATTERN = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const PLACEHOLDER_PATTERN = /\$(\d+)/g
const QUOTE_TRIM_PATTERN = /^["']|["']$/g
const SHELL_PATTERN = /!`([^`]+)`/g
const FILE_PATTERN = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

/** Split raw command arguments using the legacy quoting and image-placeholder rules. */
export function parseArguments(input: string) {
  return (input.match(ARGUMENT_PATTERN) ?? []).map((arg) => arg.replace(QUOTE_TRIM_PATTERN, ""))
}

/** Expand `$1..$9` and `$ARGUMENTS`; append raw arguments when the template has no placeholder. */
export function expandTemplate(template: string, argumentsText: string) {
  const args = parseArguments(argumentsText)
  const placeholders = template.match(PLACEHOLDER_PATTERN) ?? []
  const last = placeholders.reduce((max, item) => Math.max(max, Number(item.slice(1))), 0)
  const withArgs = template.replaceAll(PLACEHOLDER_PATTERN, (_, index: string) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]!
  })
  const usesArgumentsPlaceholder = template.includes("$ARGUMENTS")
  const expanded = withArgs.replaceAll("$ARGUMENTS", argumentsText)
  if (placeholders.length === 0 && !usesArgumentsPlaceholder && argumentsText.trim())
    return `${expanded}\n\n${argumentsText}`
  return expanded
}

export function shellMatches(template: string) {
  return Array.from(template.matchAll(SHELL_PATTERN), (match) => match[1]!)
}

/** Extract `@path` file mentions using the legacy lookbehind/quote rules. */
export function fileMentions(template: string) {
  return Array.from(template.matchAll(FILE_PATTERN), (match) => match[1]!).filter(Boolean)
}

export function replaceShellMatches(template: string, outputs: ReadonlyArray<string>) {
  let index = 0
  return template.replace(SHELL_PATTERN, () => outputs[index++] ?? "")
}
