import { describe, expect, it } from "vitest";
import { checkBuildCommit } from "@/lib/build-commit";

describe("checkBuildCommit", () => {
  it("returns ok true when built and head commits match", () => {
    const result = checkBuildCommit("abc1234", "abc1234");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("matches HEAD");
  });

  it("handles whitespace and trailing newlines gracefully", () => {
    const result = checkBuildCommit("  abc1234\n", "abc1234  ");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("matches HEAD");
  });

  it("returns ok false when commits differ", () => {
    const result = checkBuildCommit("abc1234", "def5678");
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "rebuild needed: .next/BUILD_COMMIT=abc1234 HEAD=def5678; run npm run build",
    );
  });

  it("reports <missing> when built commit is missing, null, or empty", () => {
    expect(checkBuildCommit(null, "def5678")).toEqual({
      ok: false,
      message: "rebuild needed: .next/BUILD_COMMIT=<missing> HEAD=def5678; run npm run build",
    });
    expect(checkBuildCommit(undefined, "def5678")).toEqual({
      ok: false,
      message: "rebuild needed: .next/BUILD_COMMIT=<missing> HEAD=def5678; run npm run build",
    });
    expect(checkBuildCommit("   ", "def5678")).toEqual({
      ok: false,
      message: "rebuild needed: .next/BUILD_COMMIT=<missing> HEAD=def5678; run npm run build",
    });
  });

  it("reports <missing> when head commit is missing, null, or empty", () => {
    expect(checkBuildCommit("abc1234", null)).toEqual({
      ok: false,
      message: "rebuild needed: .next/BUILD_COMMIT=abc1234 HEAD=<missing>; run npm run build",
    });
    expect(checkBuildCommit("abc1234", undefined)).toEqual({
      ok: false,
      message: "rebuild needed: .next/BUILD_COMMIT=abc1234 HEAD=<missing>; run npm run build",
    });
  });

  it("reports <missing> for both when both are empty", () => {
    expect(checkBuildCommit("", "")).toEqual({
      ok: false,
      message: "rebuild needed: .next/BUILD_COMMIT=<missing> HEAD=<missing>; run npm run build",
    });
  });
});
