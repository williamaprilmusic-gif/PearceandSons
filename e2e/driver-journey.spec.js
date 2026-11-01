import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

// Authenticated driver journeys. These skip unless global-setup wrote an auth
// state (i.e. E2E_DRIVER_USERNAME/PASSWORD were set in .env.e2e).
const DRIVER_STATE = path.join(process.cwd(), "e2e", ".auth", "driver.json");
const haveAuth = fs.existsSync(DRIVER_STATE);

test.describe("driver (authenticated)", () => {
  test.skip(!haveAuth, "No e2e/.auth/driver.json — set E2E_DRIVER_USERNAME/PASSWORD in .env.e2e (see e2e/README.md)");
  test.use({ storageState: haveAuth ? DRIVER_STATE : undefined });

  test("lands past the login screen into the driver app", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/");
    // storageState pre-seeds the session token, so the login button must be gone.
    await expect(page.getByRole("button", { name: /login/i })).toHaveCount(0);
    await expect(page.getByText("PEARCE AND SONS")).toHaveCount(0);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("sees the assigned active trip on the trips tab", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/");

    // The driver app boots on the Trips tab; the seeded DRIVER_CONFIRMED trip
    // (950001, driver 9002) must be listed with its id, the passenger's name,
    // and the CONFIRMED state badge (DRIVER_CONFIRMED renders as "CONFIRMED").
    await expect(page.getByText("950001")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/E2E Test Agent/i)).toBeVisible();
    await expect(page.getByText("CONFIRMED", { exact: true })).toBeVisible();
  });
});
