import {
  IDS,
  expect,
  expectControlHeight,
  expectNoHorizontalOverflow,
  test,
} from "./fixtures";

for (const width of [1024, 1280, 1440, 1728]) {
  test(`desktop command center at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/workspaces/${IDS.workspace}`);

    await expect(page.getByRole("heading", { name: "Needs you now" })).toBeVisible();
    await expect(page.getByText("Authorize the launch follow-up")).toBeVisible();
    await expectControlHeight(page.getByRole("link", { name: "Create draft" }), 40);
    await expectControlHeight(page.getByRole("link", { name: "Open authorization" }), 40);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`command-center-${width}.png`), fullPage: true });
  });
}

test("batch authorization preserves partial outcomes in a bounded dialog", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `/workspaces/${IDS.workspace}/review?tab=authorizations&action=${IDS.action}`,
  );

  await expect(page.getByRole("main").getByRole("heading", { name: "Review" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Send launch follow-up for batch authorization" }).check();
  await page.getByRole("button", { name: "Preview 1 authorization" }).click();

  const dialog = page.getByRole("dialog", { name: "Authorization batch preview" });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(1280);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(900);
  await expectControlHeight(page.getByRole("button", { name: "Authorize included actions" }), 40);

  await page.getByRole("button", { name: "Authorize included actions" }).click();
  await expect(page.getByRole("status")).toContainText("Partially completed");
  await expect(dialog.getByText(/1 need attention/)).toBeVisible();
  await expect(dialog.getByText("Provider rejected the deterministic fixture send.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("batch-partial-result.png"), fullPage: true });
});

test("workspace policy exposes stable, keyboard-sized controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/workspaces/${IDS.workspace}/automation`);
  await expect(page.getByRole("heading", { name: "Action permissions" })).toBeVisible();
  await expect(page.getByLabel("Send permission")).toBeVisible();
  await expectControlHeight(page.getByRole("button", { name: "Run automation now" }), 36);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("workspace-policy.png"), fullPage: true });
});

test("sender and connection policy fit the desktop surface", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/workspaces/${IDS.workspace}/connectors`);
  await expect(page.getByRole("heading", { name: "Verified email sender" })).toBeVisible();
  await expect(page.getByText("hello@example.com", { exact: true })).toBeVisible();
  await expectControlHeight(page.getByRole("button", { name: "Save sender" }), 40);
  await page.locator("summary").filter({ hasText: "Action permission" }).click();
  await expect(
    page.getByRole("region", { name: "Action permission for Founder account" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("sender-and-connection-policy.png"), fullPage: true });
});

test("persona policy fits the desktop context inspector", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/workspaces/${IDS.workspace}/resolver`);
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("region", { name: "Action permission for CEO voice" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("persona-policy.png"), fullPage: true });
});

test("Meta budget mutation keeps provider state and guarded action visible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/workspaces/${IDS.workspace}/ad-launches?launch=${IDS.launch}&mutation=budget`,
  );
  const mutation = page.getByRole("region", { name: "Change budget" });
  await expect(mutation).toBeVisible();
  await expect(mutation.getByText("Current provider budget")).toBeVisible();
  await expectControlHeight(mutation.getByRole("button", { name: "Propose budget change" }), 40);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("meta-budget-mutation.png"), fullPage: true });
});

test("native email send reports accepted delivery", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/workspaces/${IDS.workspace}/outbound`);
  const send = page.getByRole("button", { name: "Send from Tuezday" });
  await expect(send).toBeEnabled();
  await expectControlHeight(send, 40);
  await send.click();
  await expect(page.getByRole("region", { name: "Native email delivery status" })).toContainText(
    "Accepted",
  );
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("native-email-delivery.png"), fullPage: true });
});
