import { describe, expect, test } from "bun:test"
import { PlanContinuation, MAX_PLAN_STALLS } from "../../src/session/plan-continuation"
import { PlanItemError, PlanItems } from "../../src/session/plan-items"

const plan = [
  "# Plan",
  "",
  "- [ ] first item",
  "- [x] already done",
  "  - Evidence: bun test passed",
  "- [!] blocked item",
  "- [ ] second item",
].join("\n")

describe("PlanItems.parsePlanItems", () => {
  test("parses checkbox items with status and text", () => {
    const items = PlanItems.parsePlanItems(plan)
    expect(items).toEqual([
      { line: 2, status: "pending", text: "first item" },
      { line: 3, status: "done", text: "already done" },
      { line: 5, status: "blocked", text: "blocked item" },
      { line: 6, status: "pending", text: "second item" },
    ])
  })

  test("reports progress and next pending item", () => {
    const progress = PlanItems.planProgress(plan)
    expect(progress.total).toBe(4)
    expect(progress.pending.map((item) => item.text)).toEqual(["first item", "second item"])
    expect(progress.done.map((item) => item.text)).toEqual(["already done"])
    expect(progress.blocked.map((item) => item.text)).toEqual(["blocked item"])
    expect(progress.next?.text).toBe("first item")
  })

  test("renders a model-facing summary", () => {
    const text = PlanItems.renderPlanProgress(PlanItems.planProgress(plan))
    expect(text).toContain("1/4 done, 2 pending, 1 blocked")
    expect(text).toContain("Next item: first item")
    expect(text).toContain("Pending items:")
  })
})

describe("PlanItems.updatePlanItem", () => {
  test("marks an item done and records evidence", () => {
    const updated = PlanItems.updatePlanItem({
      content: plan,
      item: "first item",
      status: "done",
      evidence: "bun test passed",
    })
    expect(updated.item).toEqual({ line: 2, status: "done", text: "first item" })
    expect(updated.content.split("\n")[2]).toBe("- [x] first item")
    expect(updated.content.split("\n")[3]).toBe("  - Evidence: bun test passed")
    expect(PlanItems.planProgress(updated.content).done.map((item) => item.text)).toEqual([
      "first item",
      "already done",
    ])
  })

  test("requires evidence when marking done", () => {
    expect(() => PlanItems.updatePlanItem({ content: plan, item: "first item", status: "done" })).toThrow(
      PlanItemError,
    )
  })

  test("marks an item blocked with a note", () => {
    const updated = PlanItems.updatePlanItem({
      content: plan,
      item: "second item",
      status: "blocked",
      note: "missing credentials",
    })
    expect(updated.content.split("\n")[6]).toBe("- [!] second item")
    expect(updated.content.split("\n")[7]).toBe("  - Evidence: missing credentials")
  })

  test("replaces an existing evidence line instead of stacking", () => {
    const once = PlanItems.updatePlanItem({
      content: plan,
      item: "first item",
      status: "done",
      evidence: "first run",
    })
    const twice = PlanItems.updatePlanItem({
      content: once.content,
      item: "first item",
      status: "done",
      evidence: "second run",
    })
    expect(twice.content.match(/Evidence:/g)?.length).toBe(2)
    expect(twice.content).toContain("Evidence: second run")
  })

  test("rejects unknown and ambiguous items", () => {
    expect(() => PlanItems.updatePlanItem({ content: plan, item: "missing", status: "pending" })).toThrow(
      "Plan item not found",
    )
    const ambiguous = ["- [ ] duplicate", "- [ ] duplicate"].join("\n")
    expect(() => PlanItems.updatePlanItem({ content: ambiguous, item: "duplicate", status: "pending" })).toThrow(
      "ambiguous",
    )
  })
})

describe("PlanContinuation", () => {
  test("continues to the next pending item and stops after stalls", () => {
    const session = "ses_plan_continuation_test"
    PlanContinuation.resetPlanContinuation(session)
    expect(PlanContinuation.nextPlanContinuation(session, plan)?.item.text).toBe("first item")
    for (let index = 0; index <= MAX_PLAN_STALLS + 1; index += 1) {
      PlanContinuation.nextPlanContinuation(session, plan)
    }
    expect(PlanContinuation.nextPlanContinuation(session, plan)).toBeUndefined()
  })

  test("does not continue when there are no pending items", () => {
    const content = ["- [x] done", "- [!] blocked"].join("\n")
    expect(PlanContinuation.nextPlanContinuation("ses_plan_done", content)).toBeUndefined()
  })

  test("resets after explicit user input", () => {
    const session = "ses_plan_reset_test"
    PlanContinuation.resetPlanContinuation(session)
    PlanContinuation.nextPlanContinuation(session, plan)
    for (let index = 0; index <= MAX_PLAN_STALLS; index += 1) PlanContinuation.nextPlanContinuation(session, plan)
    expect(PlanContinuation.nextPlanContinuation(session, plan)).toBeUndefined()
    PlanContinuation.resetPlanContinuation(session)
    expect(PlanContinuation.nextPlanContinuation(session, plan)?.item.text).toBe("first item")
  })
})
