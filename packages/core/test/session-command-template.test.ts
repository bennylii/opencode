import { describe, expect, test } from "bun:test"
import { CommandTemplate } from "@opencode-ai/core/session/command-template"

describe("CommandTemplate", () => {
  test("parses quoted and image arguments", () => {
    expect(CommandTemplate.parseArguments(`one "two three" 'four' [Image 1]`)).toEqual([
      "one",
      "two three",
      "four",
      "[Image 1]",
    ])
  })

  test("expands positional placeholders and joins the last one", () => {
    expect(CommandTemplate.expandTemplate("run $1 with $2", "alpha beta gamma")).toBe("run alpha with beta gamma")
    expect(CommandTemplate.expandTemplate("first $1 second $2", "alpha")).toBe("first alpha second ")
  })

  test("expands $ARGUMENTS and appends raw arguments when no placeholder exists", () => {
    expect(CommandTemplate.expandTemplate("say $ARGUMENTS", "hello world")).toBe("say hello world")
    expect(CommandTemplate.expandTemplate("plain template", "extra")).toBe("plain template\n\nextra")
    expect(CommandTemplate.expandTemplate("plain template", "  ")).toBe("plain template")
  })

  test("collects and replaces shell matches in order", () => {
    const template = "before !`echo one` middle !`echo two` after"
    expect(CommandTemplate.shellMatches(template)).toEqual(["echo one", "echo two"])
    expect(CommandTemplate.replaceShellMatches(template, ["ONE", "TWO"])).toBe("before ONE middle TWO after")
  })

  test("extracts file mentions without matching emails", () => {
    expect(CommandTemplate.fileMentions("read @src/a.ts and @~/notes.md mail a@b.com")).toEqual([
      "src/a.ts",
      "~/notes.md",
    ])
  })
})
