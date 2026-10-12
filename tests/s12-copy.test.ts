import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("S12 Demo 文案", () => {
  it("首页 Demo 文案不再承诺记住进度", () => {
    const page = read("app/page.tsx");
    expect(page).not.toContain("记住进度");
    expect(page).toContain("体验版不记进度，没有看板");
  });
});
