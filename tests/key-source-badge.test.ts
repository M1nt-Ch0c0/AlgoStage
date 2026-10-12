import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KeySourceBadge } from "../components/settings/key-source-badge";

test("设置页 Key 来源徽标：三个来源都有明确标签、不同颜色与无障碍状态", () => {
  const cases = [
    ["settings", "设置页", "text-beam-mint"],
    ["env", "环境变量", "text-beam-cyan"],
    ["none", "未配置", "text-chalk-500"],
  ] as const;
  for (const [source, label, color] of cases) {
    const html = renderToStaticMarkup(
      createElement(KeySourceBadge, { source }),
    );
    assert.ok(html.includes(`Key 来源：${label}`));
    assert.ok(html.includes(color));
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes('aria-live="polite"'));
  }
});
