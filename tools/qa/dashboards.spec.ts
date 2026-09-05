import { expect, test } from "@playwright/test";

for (const [index, name] of ["inference", "hosted seat", "local gateway"].entries()) {
  test(`${name} renders its unavailable state and scrolls inside the viewport`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/admin/**", (route) =>
      route.fulfill({
        status: 503,
        json: { error: { message: "QA service unavailable" } },
      }),
    );
    await page.goto(
      `http://127.0.0.1:${Number(process.env.STAVKA_QA_PORT ?? 18787) + index + 1}/_/`,
    );
    await expect(
      page.getByText(index === 1 ? "Hosted seat status unavailable" : "Gateway unavailable", {
        exact: true,
      }),
    ).toBeVisible();
    const shell = index === 0 ? ".maskirovka-gateway-shell" : ".maskirovka-shell";
    const pane = index === 0 ? ".maskirovka-gateway-content" : ".maskirovka-content";
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      const geometry = await page.evaluate(
        ({ shell, pane }) => {
          const content = document.querySelector(pane)!;
          content.scrollTop = content.scrollHeight;
          return {
            documentWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight,
            shellBottom: document.querySelector(shell)!.getBoundingClientRect().bottom,
            contentBottom: content.getBoundingClientRect().bottom,
            overflow: getComputedStyle(content).overflowY,
            scrollable: content.scrollHeight <= content.clientHeight || content.scrollTop > 0,
          };
        },
        { shell, pane },
      );
      expect(geometry.documentWidth).toBeLessThanOrEqual(size.width + 1);
      expect(geometry.documentHeight).toBeLessThanOrEqual(size.height + 1);
      expect(geometry.shellBottom).toBeLessThanOrEqual(size.height + 1);
      expect(geometry.contentBottom).toBeLessThanOrEqual(size.height + 1);
      expect(geometry.overflow).toBe("auto");
      expect(geometry.scrollable).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${size.width}.png`) });
    }
    expect(errors).toEqual([]);
  });
}
