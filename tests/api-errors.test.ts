import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createFixture, request } from "./api-fixture";

test("S4：讲解和提示的坏 JSON 为 400，未知题为 404（没有 Key 也正确返回）", async () => {
  const f = await createFixture();
  try {
    for (const route of [await import("../app/api/lecture/route"), await import("../app/api/hint/route")]) {
      const bad = new NextRequest("http://localhost/api/test", { method: "POST", body: "{bad" });
      const badResponse = await route.POST(bad);
      assert.equal(badResponse.status, 400);
      assert.equal((await badResponse.json()).error, "BAD_JSON");
      const missing = await route.POST(request({ slug: "not-a-problem", level: 1 }));
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error, "NOT_FOUND");
    }
  } finally { await f.close(); }
});
