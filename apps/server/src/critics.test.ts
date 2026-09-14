import { describe, expect, it } from "vitest";
import { addedLinesByFile, blockingFindings, planCritics } from "./critics.ts";

const diffFor = (file: string, added: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${added}\n`;

describe("critic routing", () => {
  it("runs no critic for docs, notes and lockfiles", () => {
    expect(planCritics(["README.md", ".ai/HANDOFF.md", "package-lock.json", "docs/logo.svg"], "")).toEqual([]);
  });

  it("sends UI files to the UI critic", () => {
    expect(planCritics(["src/components/Cart.tsx", "src/styles.css", "src/math.ts"], "")).toEqual([
      { kind: "ui", files: ["src/components/Cart.tsx", "src/styles.css"], reason: "2 UI files changed" },
    ]);
  });

  it("sends sensitive paths and sensitive code to the security critic", () => {
    const files = ["apps/server/src/routes/orders.ts", "src/lib/format.ts", ".env.example", "package.json"];
    const diff = diffFor("src/lib/format.ts", 'exec(`convert ${name}`)');
    expect(planCritics(files, diff)).toEqual([
      {
        kind: "security",
        files: ["apps/server/src/routes/orders.ts", ".env.example", "package.json", "src/lib/format.ts"],
        reason: "3 files in sensitive places and sensitive code in 1 file",
      },
    ]);
  });

  it("skips critics the project turned off", () => {
    expect(planCritics(["src/pages/Login.tsx"], "", ["security"]).map((p) => p.kind)).toEqual(["ui"]);
    expect(planCritics(["src/pages/Login.tsx"], "", ["ui", "security"])).toEqual([]);
  });

  it("does not treat an ordinary helper as sensitive", () => {
    expect(planCritics(["src/math.js", "test/math.test.js"], diffFor("src/math.js", "return a + b;"))).toEqual([]);
    // Generic words only count as folders: a fetch wrapper named api.ts or any file of a package called server is not sensitive.
    expect(planCritics(["apps/dashboard/src/api.ts", "apps/server/src/format.ts", "src/db.ts"], "")).toEqual([]);
    expect(planCritics(["src/api/orders.ts", "src/authMiddleware.ts"], "").map((p) => p.files)).toEqual([["src/api/orders.ts", "src/authMiddleware.ts"]]);
  });

  it("sends CI workflows to the security critic", () => {
    expect(planCritics([".github/workflows/deploy.yml", ".gitlab-ci.yml"], "").map((p) => [p.kind, p.files.length])).toEqual([["security", 2]]);
  });
});

describe("critic findings", () => {
  it("reads added lines per file", () => {
    expect(addedLinesByFile(diffFor("a.ts", "one") + diffFor("b.ts", "two"))).toEqual(new Map([["a.ts", "one\n"], ["b.ts", "two\n"]]));
  });

  it("keeps only confident, concrete findings, at most five", () => {
    const findings = [
      { problem: "Save button overflows on phones", confidence: 90 },
      { problem: "Maybe rename this", confidence: 40 },
      { problem: "", confidence: 95 },
      ...Array.from({ length: 6 }, (_, i) => ({ problem: `Issue ${i}` })),
    ];
    const kept = blockingFindings({ findings });
    expect(kept).toHaveLength(5);
    expect(kept[0]!.problem).toBe("Save button overflows on phones");
    expect(kept.some((f) => f.problem === "Maybe rename this")).toBe(false);
  });
});
