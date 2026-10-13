import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsStatus } from "@/components/settings/settings-status";

test("SettingsStatus 常驻挂载且支持 ARIA 状态播报", () => {
  // 空闲状态：常驻挂载且内容为空
  const idleHtml = renderToStaticMarkup(createElement(SettingsStatus, { message: "" }));
  expect(idleHtml).toContain('id="settings-status"');
  expect(idleHtml).toContain('role="status"');
  expect(idleHtml).toContain('aria-live="polite"');
  expect(idleHtml).toContain('class="mt-2 text-xs leading-5 text-chalk-300"');
  expect(idleHtml).toBe('<p id="settings-status" role="status" aria-live="polite" class="mt-2 text-xs leading-5 text-chalk-300"></p>');

  // 状态变更：展示文案
  const activeHtml = renderToStaticMarkup(
    createElement(SettingsStatus, { message: "接口地址已保存，还要填 API Key 才能开讲。" }),
  );
  expect(activeHtml).toContain("接口地址已保存，还要填 API Key 才能开讲。");
  expect(activeHtml).toContain('role="status"');
  expect(activeHtml).toContain('aria-live="polite"');

  // 自定义 id 与 className
  const customHtml = renderToStaticMarkup(
    createElement(SettingsStatus, {
      id: "custom-status",
      message: "自定义状态",
      className: "custom-class",
    }),
  );
  expect(customHtml).toContain('id="custom-status"');
  expect(customHtml).toContain('class="custom-class"');
  expect(customHtml).toContain("自定义状态");
});
