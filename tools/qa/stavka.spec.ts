import { expect, test } from "@playwright/test";

test("profile setup, private bindings, simulation, session inspection, and responsive panes", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:\/\/(?!(?:127\.0\.0\.1|localhost)(?::|\/))/, (route) => {
    external.push(new URL(route.request().url()).origin);
    return route.abort();
  });
  await page.goto("/");
  await page.getByLabel("Your name").fill("QA Operator");
  await page.getByLabel("Organization", { exact: true }).fill("QA Stavka");
  await page.getByRole("button", { name: "Create my Stavka profile" }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const session = await request.get("/auth/session");
  expect(session.status()).toBe(200);
  expect((await session.json()).status).toBe("active");

  await page
    .getByRole("navigation", { name: "Primary", exact: true })
    .getByRole("link", { name: "Health", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  // Mock transport deliberately reports degraded instead of claiming live readiness.
  await expect(page.getByText("Degraded", { exact: true })).toBeVisible();
  const modelStatus = await request.get("/admin/status");
  expect(modelStatus.status(), await modelStatus.text()).toBe(200);
  expect((await modelStatus.json()).aliases).toHaveLength(3);

  await page.goto("/simulations?scenario=engagement&seed=12&time_scale=10&host=agent");
  await expect(page.getByRole("button", { name: "Step", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByText(/11 fixed steps/)).toBeVisible();
  await expect(page.locator('footer[aria-label="Commander status"]')).toContainText("OPFOR");
  await expect(page.locator('footer[aria-label="Commander status"]')).toContainText(
    /Awaiting decision|Rule decisions/,
  );
  const archived = await request.get(
    "/api/commander/export?session_id=poligon-engagement-12-opfor-balanced-x10-single&faction=OPFOR",
  );
  expect(archived.status(), await archived.text()).toBe(200);
  expect((await archived.json()).archive.ticks.length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByText(/11 fixed steps/)).toBeVisible();
  await page.getByRole("link", { name: "Open OPFOR in Sessions" }).click();
  await expect(page.getByLabel("Session ID")).toHaveValue(
    "poligon-engagement-12-opfor-balanced-x10-single",
  );
  await expect(page.getByRole("heading", { name: "Decision timeline" })).toBeVisible();
  await page.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("region", { name: "Replay cost breakdown" })).toBeVisible();
  await page.goto("/usage");
  await page.getByRole("button", { name: "Paste an ID instead" }).click();
  await page.getByLabel("Session ID").fill("poligon-engagement-12-opfor-balanced-x10-single");
  await page.getByRole("button", { name: "Load session" }).click();
  await expect(page.getByRole("heading", { name: "Calls, tokens, and cost" })).toBeVisible();

  await page.goto("/simulations?scenario=movement&seed=13&time_scale=10&host=offline");
  await expect(page.getByText("Paused offline", { exact: true })).toBeVisible();
  const offlineRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/agents\/|\/api\/tick|\/api\/connect/.test(request.url()))
      offlineRequests.push(request.url());
  });
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByText(/110 fixed steps/)).toBeVisible();
  expect(offlineRequests).toEqual([]);

  for (const size of [
    { width: 1440, height: 900 },
    { width: 935, height: 1034 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    for (const path of [
      "/",
      "/models",
      "/settings/access",
      "/settings/providers",
      "/sessions",
      "/replays",
      "/decisions",
      "/usage",
      "/system",
      "/simulations?host=offline",
    ]) {
      await page.goto(path);
      await expect(page.locator(".stavka-shell")).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
      if (size.width >= 900) {
        const icons = page.getByRole("navigation", { name: "Primary", exact: true }).locator("svg");
        for (const icon of await icons.all())
          expect((await icon.boundingBox())!.width).toBeGreaterThanOrEqual(16);
      }
      const geometry = await page.evaluate(() => ({
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        shellHeight: document.querySelector(".stavka-shell")!.getBoundingClientRect().height,
        paneBottom: document.querySelector(".poligon-shell, .stavka-pane")!.getBoundingClientRect()
          .bottom,
      }));
      expect(geometry.documentWidth, path).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(geometry.documentHeight, path).toBeLessThanOrEqual(geometry.viewportHeight + 1);
      expect(geometry.shellHeight, path).toBeLessThanOrEqual(geometry.viewportHeight + 1);
      expect(geometry.paneBottom, path).toBeLessThanOrEqual(geometry.viewportHeight + 1);
      if (path === "/" && size.width === 390) {
        await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
        await expect(page.getByRole("navigation", { name: "Primary", exact: true })).toBeVisible();
        await page
          .getByRole("navigation", { name: "Primary", exact: true })
          .getByRole("link", { name: "Sessions", exact: true })
          .click();
        await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
        await expect(
          page.getByRole("navigation", { name: "Primary", exact: true }),
        ).not.toBeVisible();
      }
      if (path.startsWith("/simulations")) {
        const map = page.getByRole("img", { name: "Tactical map with live unit positions" });
        await expect(map).toBeVisible();
        const clippedHeight = await page
          .locator(".simulation-body > section > .stavka-panel")
          .first()
          .evaluate((panel) => panel.scrollHeight - panel.clientHeight);
        expect(clippedHeight).toBeLessThanOrEqual(1);
        const units = page.locator("[data-unit]");
        expect(await units.count()).toBeGreaterThan(0);
        const mapBox = (await map.boundingBox())!;
        for (const unit of await units.all()) {
          const unitBox = (await unit.boundingBox())!;
          expect(unitBox.x).toBeGreaterThanOrEqual(mapBox.x);
          expect(unitBox.x + unitBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width);
          expect(unitBox.y).toBeGreaterThanOrEqual(mapBox.y);
          expect(unitBox.y + unitBox.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);
          const labelHeight = await unit
            .locator("text")
            .first()
            .evaluate((e) => e.getBoundingClientRect().height);
          expect(labelHeight).toBeGreaterThanOrEqual(10);
        }
        await units.first().click();
        await expect(page.locator(".stavka-map-detail")).toBeVisible();
        await page.getByRole("button", { name: "Fit battlefield", exact: true }).click();
        await expect(page.locator(".stavka-map-detail")).toHaveCount(0);
        const originalUrl = page.url();
        if (size.width < 640) await page.getByRole("tab", { name: "Setup", exact: true }).click();
        else await page.getByRole("button", { name: "Scenario…", exact: true }).click();
        await expect(page.getByLabel("Seed", { exact: true })).toBeVisible();
        await page.getByLabel("Seed", { exact: true }).fill("999");
        await page.keyboard.press("Escape");
        await expect(page.getByLabel("Seed", { exact: true })).toHaveCount(0);
        expect(page.url()).toBe(originalUrl);
        if (size.width < 640) await page.getByRole("tab", { name: "Map", exact: true }).click();
        const mapBoxBefore = (await map.boundingBox())!;
        const runControlsBox = (await page
          .getByRole("group", { name: "Run controls", exact: true })
          .boundingBox())!;
        expect(mapBoxBefore.height).toBeGreaterThan(200);
        expect(mapBoxBefore.y + mapBoxBefore.height).toBeLessThanOrEqual(size.height + 1);
        expect(runControlsBox.y + runControlsBox.height).toBeLessThanOrEqual(size.height + 1);
        await page.getByRole("button", { name: "3D view", exact: true }).click();
        await expect(page.locator("canvas")).toBeVisible();
        await expect(page.locator("[data-3d-unit]").first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`simulation-3d-${size.width}.png`) });
        await page.getByRole("button", { name: "2D map", exact: true }).click();
        await expect(map).toBeVisible();
        expect(new URL(page.url()).searchParams.get("seed")).toBe(
          new URL(originalUrl).searchParams.get("seed"),
        );
        await page.getByRole("button", { name: "Step", exact: true }).click();
        await expect(page.getByText(/110 fixed steps/)).toBeVisible();
        await page.locator(".simulation-body").evaluate((pane) => {
          pane.scrollTop = 0;
          for (const child of pane.children) child.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath(`simulation-${size.width}.png`) });
        if (size.width < 640) await page.getByRole("tab", { name: "Setup", exact: true }).click();
        else await page.getByRole("button", { name: "Scenario…", exact: true }).click();
        await page.getByLabel("Seed", { exact: true }).fill("14");
        await page.getByRole("button", { name: "Load scenario", exact: true }).click();
        await expect(page).toHaveURL(/seed=14/);
        await expect(map).toBeVisible();
        await expect(page.getByText("10 fixed steps", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Step", exact: true }).click();
        await expect(page.getByText(/110 fixed steps/)).toBeVisible();
      }
    }
  }
  await page.goto("/decisions");
  await page.getByRole("button", { name: "Paste an ID instead" }).click();
  await page.getByLabel("Session ID").fill("missing-session");
  const missing = page.waitForResponse((response) =>
    response.url().includes("/api/commander/export?session_id=missing-session"),
  );
  await page.getByRole("button", { name: "Load session" }).click();
  expect((await missing).status()).toBe(404);
  await expect(page.getByText("Session unavailable", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("session source isolation, identity loading, export validation, and model-test history", async ({
  page,
}) => {
  const { replayFixture } = await import("../../apps/stavka/tests/replay-fixture");
  const probes: string[] = [];
  const exports: string[] = [];
  await page.route("**/api/commander/export?**", async (route) => {
    exports.push(route.request().url());
    await route.fulfill({ json: replayFixture });
  });
  await page.route("**/admin/status", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        mode: "live",
        killed: false,
        container: { status: "running", last_change: 0 },
        aliases: ["commander", "sergeant", "heavy"].map((tier) => ({
          tier: "stavka/" + tier,
          seat: "codex",
          model: "qa-" + tier,
        })),
      },
    });
  });
  await page.route("**/v1/responses", async (route) => {
    probes.push(route.request().postData() ?? "");
    await route.fulfill({
      json: {
        model: "qa-probed-model",
        usage: { input_tokens: 5, output_tokens: 2 },
        output: [{ content: [{ text: "STAVKA_READY" }] }],
      },
    });
  });
  await page.goto("/sessions");
  await page.getByRole("button", { name: "Load session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Decision timeline" })).toBeVisible();
  expect(new URL(exports[0]!).searchParams.get("session_id")).toBe(
    replayFixture.session.session_id,
  );
  await page.getByRole("tab", { name: "State", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Reconstructed replay world progression" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Decision timeline" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("region", { name: "Replay cost breakdown" })).toBeVisible();
  await page.getByRole("tab", { name: "From export file", exact: true }).click();
  await expect(page.getByRole("region", { name: "Session summary" })).toHaveCount(0);
  await page.getByLabel("Session export file").setInputFiles({
    name: "session.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replayFixture)),
  });
  await expect(page.getByRole("region", { name: "Session summary" })).toContainText(
    replayFixture.session.session_id,
  );
  await page.getByLabel("Session export file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("not json"),
  });
  await expect(page.getByText("Replay import rejected", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session summary" })).toHaveCount(0);
  await page.getByLabel("Session export file").setInputFiles({
    name: "too-large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/5 MiB limit/)).toBeVisible();
  // Resolve an older file after switching sources; it must not replace Commander evidence.
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      return this.name === "slow.json"
        ? new Promise((resolve) => {
            setTimeout(() => {
              void original.call(this).then(resolve);
            }, 300);
          })
        : original.call(this);
    };
  });
  await page.getByLabel("Session export file").setInputFiles({
    name: "slow.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...replayFixture,
        session: { ...replayFixture.session, session_id: "old-file-result" },
      }),
    ),
  });
  await page.getByRole("tab", { name: "From Commander", exact: true }).click();
  await expect(page.getByRole("region", { name: "Session summary" })).toContainText(
    replayFixture.session.session_id,
  );
  await page.getByRole("tab", { name: "From export file", exact: true }).click();
  await page.waitForTimeout(400);
  await expect(page.getByRole("region", { name: "Session summary" })).toHaveCount(0);
  await expect(page.getByText("old-file-result", { exact: true })).toHaveCount(0);

  await page.goto("/models");
  await expect(page.getByText("Not tested", { exact: true })).toHaveCount(3);
  expect(probes).toHaveLength(0);
  await page.getByRole("button", { name: "Test model", exact: true }).first().click();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(page.getByText("STAVKA_READY", { exact: true })).toBeVisible();
  expect(probes).toHaveLength(1);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(page.getByText(/qa-probed-model/)).toBeVisible();
  expect(probes).toHaveLength(1);
});
