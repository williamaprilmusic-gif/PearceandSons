import { test, expect } from "@playwright/test";

// Unauthenticated smoke — no credentials required, always runs.
// Guards the login screen render and a clean console on first load.
test.describe("unauthenticated smoke", () => {
  test("login screen renders with no console errors", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/");

    await expect(page.getByText("PEARCE AND SONS")).toBeVisible();
    await expect(page.getByRole("button", { name: /login/i })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator("input").first()).toBeVisible(); // username field

    expect(errors, `console errors on load:\n${errors.join("\n")}`).toEqual([]);
  });
});
