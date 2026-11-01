import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

// Authenticated agent journeys. These skip unless global-setup wrote an auth
// state (i.e. E2E_AGENT_USERNAME/PASSWORD were set in .env.e2e).
const AGENT_STATE = path.join(process.cwd(), "e2e", ".auth", "agent.json");
const haveAuth = fs.existsSync(AGENT_STATE);

test.describe("agent (authenticated)", () => {
  test.skip(!haveAuth, "No e2e/.auth/agent.json — set E2E_AGENT_USERNAME/PASSWORD in .env.e2e (see e2e/README.md)");
  test.use({ storageState: haveAuth ? AGENT_STATE : undefined });

  test("lands past the login screen into the agent app", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/");
    // storageState pre-seeds the session token, so the login button must be gone.
    await expect(page.getByRole("button", { name: /login/i })).toHaveCount(0);
    await expect(page.getByText("PEARCE AND SONS")).toHaveCount(0);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  // ── TEMPLATE: offline-ETA UI (fill in once the test agent has a seeded
  // active trip). The shipped behaviour to assert:
  //   - while the driver is broadcasting: "Shuttle is about N mins away"
  //   - when the broadcast goes stale: past-tense "Shuttle was about N mins
  //     away" + "live tracking paused"
  //   - after MAX_RETAINED_ETA_MS: the number is dropped entirely.
  //
  // test("offline-ETA retains last-known then pauses", async ({ page }) => {
  //   await page.goto("/");
  //   // open the agent's active trip detail (selector TBD once seeded)…
  //   await expect(page.getByText(/shuttle/i)).toBeVisible();
  //   // simulate / wait for the broadcast to go stale, then:
  //   await expect(page.getByText(/live tracking paused/i)).toBeVisible();
  // });
});
