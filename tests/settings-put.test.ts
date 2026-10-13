import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createFixture, request } from "./api-fixture";

test("settings PUT：类型与枚举校验，失败零写入，Key 不透传，合法更新原子保存", async () => {
  const f = await createFixture({ modelServer: false });
  try {
    const { PUT, GET } = await import("../app/api/settings/route");
    await f.save({ model: "original" });
    for (const settings of [
      { model: "changed", apiKey: 42 }, { model: "changed", apiKey: ["secret"] },
      { provider: "unknown" }, { theme: "invalid" }, { narrationSpeed: "999" },
      { baseURL: "invalid-url" }, { effectLevel: null },
    ]) {
      const response = await PUT(request({ settings }));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "BAD_REQUEST");
      assert.equal((await f.prisma.setting.findUnique({ where: { key_userId: { key: "model", userId: "local-default" } } }))?.value, "original");
      assert.equal(await f.prisma.setting.count(), 1);
    }
    for (const body of [null, [], {}, { settings: null }]) assert.equal((await PUT(request(body))).status, 400);
    assert.equal((await PUT(new NextRequest("http://localhost/api/settings", { method: "PUT", body: "{bad" }))).status, 400);
    const secret = "settings-test-secret";
    const response = await PUT(request({ settings: { apiKey: secret, model: "test", provider: "google", theme: "light", unknown: "ignore" } }));
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(secret));
    const saved = await (await GET()).json();
    assert.equal(saved.keySource, "settings");
    assert.equal(saved.settings.theme, "light");
    assert.equal(saved.settings.unknown, undefined);
    assert.equal(saved.settings.apiKeyMasked, "••••cret");
    assert.ok(!JSON.stringify(saved).includes(secret));
  } finally { await f.close(); }
});
