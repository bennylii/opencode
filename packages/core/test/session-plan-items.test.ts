import { describe, expect, test } from "bun:test"
import { PlanItems } from "@opencode-ai/core/session/plan-items"

describe("PlanItems", () => {
  test("parses markdown checkbox items with pending, done and blocked markers", () => {
    const items = PlanItems.parsePlanItems("# Plan\n- [ ] first\n- [x] second\n- [!] third\nnot an item\n  * [X] nested")
    expect(items).toEqual([
      { line: 1, status: "pending", text: "first" },
      { line: 2, status: "done", text: "second" },
      { line: 3, status: "blocked", text: "third" },
      { line: 5, status: "done", text: "nested" },
    ])
  })

  test("computes progress counts and the next pending item", () => {
    const progress = PlanItems.planProgress("- [x] done\n- [ ] first pending\n- [ ] second pending\n- [!] blocked")
    expect(progress.total).toBe(4)
    expect(progress.done.map((item) => item.text)).toEqual(["done"])
    expect(progress.pending.map((item) => item.text)).toEqual(["first pending", "second pending"])
    expect(progress.blocked.map((item) => item.text)).toEqual(["blocked"])
    expect(progress.next?.text).toBe("first pending")
  })

  test("requires evidence before marking an item done", () => {
    expect(() => PlanItems.updatePlanItem({ content: "- [ ] first", item: "first", status: "done" })).toThrow(
      "Marking a plan item done requires verification evidence",
    )
    const updated = PlanItems.updatePlanItem({
      content: "- [ ] first",
      item: "first",
      status: "done",
      evidence: "npm test passed",
    })
    expect(updated.item).toEqual({ line: 0, status: "done", text: "first" })
    expect(updated.content).toBe("- [x] first\n  - Evidence: npm test passed")
  })

  test("updates an existing evidence line instead of appending", () => {
    const updated = PlanItems.updatePlanItem({
      content: "- [ ] first\n  - Evidence: old",
      item: "first",
      status: "done",
      evidence: "new proof",
    })
    expect(updated.content).toBe("- [x] first\n  - Evidence: new proof")
  })

  test("records a note for blocked items", () => {
    const updated = PlanItems.updatePlanItem({
      content: "- [ ] first",
      item: "first",
      status: "blocked",
      note: "waiting for credentials",
    })
    expect(updated.content).toBe("- [!] first\n  - Evidence: waiting for credentials")
  })

  test("rejects missing and ambiguous items", () => {
    expect(() => PlanItems.updatePlanItem({ content: "- [ ] first", item: "nope", status: "pending" })).toThrow(
      "Plan item not found: nope",
    )
    expect(() =>
      PlanItems.updatePlanItem({ content: "- [ ] same\n- [ ] same", item: "same", status: "pending" }),
    ).toThrow("Plan item is ambiguous (2 matches): same; use the exact item text")
  })

  test("renders progress with pending and blocked lists", () => {
    const output = PlanItems.renderPlanProgress(
      PlanItems.planProgress("- [x] done\n- [ ] pending\n- [!] blocked"),
    )
    expect(output).toContain("Plan progress: 1/3 done, 1 pending, 1 blocked")
    expect(output).toContain("Next item: pending")
    expect(output).toContain("Pending items:\n- pending")
    expect(output).toContain("Blocked items:\n- blocked")
  })
})
