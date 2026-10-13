import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expect, test, type Page } from "@playwright/test";

/** 发完 count 步后 800ms 直接 socket.destroy()，不发 error 事件（模拟手机掉网 / 连接被掐断）。 */
async function mockDisconnectingLecture(page: Page, count: number) {
  const payload = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      type: "step",
      step: { id: `s${i + 1}`, narration: `第${i + 1}步`, targets: [{ kind: "code-line", start: 1, end: 2 }], effects: [], dwellMs: 100 },
    }),
  ).join("\n");
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform" });
    res.write(payload ? `${payload}\n` : "");
    setTimeout(() => req.socket.destroy(), 800);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await page.route("**/api/lecture", async (route) => {
    const url = new URL(route.request().url());
    if (url.port === String(port)) return route.continue();
    await route.continue({ url: `http://127.0.0.1:${port}/api/lecture` });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

test.beforeEach(async ({ context, baseURL }) => {
  // 只放行本站和续到 127.0.0.1 的 /api/lecture 模拟流（与 autoplay.spec.ts 一致）。
  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    const mockLecture = url.hostname === "127.0.0.1" && url.pathname === "/api/lecture";
    if (url.origin === baseURL || mockLecture) return route.continue();
    throw new Error(`Unexpected external request: ${url.origin}`);
  });
});

for (const count of [1, 4]) {
  test(`收到 ${count} 步后 socket 被直接断开：保留步骤，显示备课中断和一个「重试」，不显示浏览器原文`, async ({ page }) => {
    const close = await mockDisconnectingLecture(page, count);
    try {
      await page.goto("/problem/group-anagrams");
      await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: `已收到 ${count} 步，备课中断` })).toBeVisible();
      await expect(page.getByRole("button", { name: `跳到第 ${count} 步`, exact: true })).toBeVisible();
      const alert = page.getByRole("alert").filter({ hasText: "备课中断，网络连接已断开" });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole("button")).toHaveText(["重试"]);
      await expect(alert.getByRole("link", { name: "去设置" })).toHaveCount(0);
      await expect(alert).not.toContainText("已收到");
      await expect(page.getByText("还没开始上课")).toHaveCount(0);
      await expect(page.getByText(/network error/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "重试讲课" })).toHaveCount(0);
    } finally {
      await close();
    }
  });
}

test("0 步时 socket 被直接断开：显示 A5 UPSTREAM_ERROR 文案和一个「重试」，不显示浏览器原文", async ({ page }) => {
  const close = await mockDisconnectingLecture(page, 0);
  try {
    await page.goto("/problem/group-anagrams");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "AI 服务暂时连不上，请稍后再试。" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button")).toHaveText(["重试"]);
    await expect(page.getByText(/network error/i)).toHaveCount(0);
    await expect(page.getByText("备课中断")).toHaveCount(0);
  } finally {
    await close();
  }
});
