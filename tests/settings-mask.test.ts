import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixture } from "./api-fixture";

test("settings GET：掩码只展示末四位，短 Key 全部遮蔽，空 Key 不产生掩码", async () => {
  const f = await createFixture({ modelServer: false });
  try {
    const { GET } = await import("../app/api/settings/route");
    for (const [apiKey, expected] of [
      ["sk-prefix-test-abcd", "••••abcd"],
      ["123456789", "••••6789"],
      ["12345678", "••••"],
      ["12345", "••••"],
      ["abcd", "••••"],
      ["abc", "••••"],
      ["  12345678  ", "••••"],
      ["  123456789  ", "••••6789"],
      ["  sk-trimmed-wxyz  ", "••••wxyz"],
      ["   ", undefined],
      ["", undefined],
    ] as const) {
      await f.save({ apiKey });
      const body = await (await GET()).json();
      assert.equal(body.settings.apiKey, undefined);
      assert.equal(body.settings.apiKeyMasked, expected);
      assert.equal(body.keySource, apiKey.trim() ? "settings" : "none");
      if (apiKey.trim()) assert.ok(!JSON.stringify(body).includes(apiKey.trim()));
    }
    process.env.AI_API_KEY = "env-prefix-private-abcd";
    const body = await (await GET()).json();
    assert.equal(body.keySource, "env");
    assert.equal(body.settings.apiKeyMasked, undefined);
    assert.ok(!JSON.stringify(body).includes(process.env.AI_API_KEY));
  } finally { await f.close(); }
});
