import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import AiSetupPrompt from "../components/settings/ai-setup-prompt";

test("设置引导仅在服务端明确返回 keySource=none 时显示", () => {
  for (const keySource of ["settings", "env", null, undefined, "", {}, "unknown"]) {
    expect(renderToStaticMarkup(createElement(AiSetupPrompt, { keySource }))).toBe("");
  }
  const html = renderToStaticMarkup(createElement(AiSetupPrompt, { keySource: "none" }));
  expect(html).toContain("还没接上 AI？去设置");
  expect(html).toContain('href="/settings"');
});
