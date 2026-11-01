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

  // Offline-ETA cold start — the whole point of the driver-offline-ETA
  // feature. The seeded test agent (id 9001) has a DRIVER_CONFIRMED trip
  // (950001) to the seeded test driver (9002), who has a recent
  // driver_positions fix but is NOT broadcasting live (their app is
  // "closed" — exactly the cold-start case). So no realtime position ever
  // arrives this session; after ~2 broadcast intervals the hook seeds the
  // last-known ETA from the agent-trip-eta edge function and renders it in
  // the past tense with "live tracking paused" — never any coordinate.
  // Requires the seed rows (see project-transitos-e2e-harness memory); if
  // they're gone this will time out on the ETA text rather than pass hollow.
  test("offline-ETA shows last-known then pauses on the active trip", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");

    // Home screen once session + data have loaded.
    await expect(page.getByText(/GOOD DAY, AGENT/i)).toBeVisible();

    // The DRIVER_CONFIRMED trip surfaces as the tappable ACTIVE TRIP card;
    // tapping it deep-links to that trip's detail view.
    const activeCard = page.getByText(/ACTIVE TRIP/i);
    await expect(activeCard).toBeVisible({ timeout: 15_000 });
    await activeCard.click();

    // Trip detail: the assigned driver card hosts the (text-only) ETA.
    await expect(page.getByText(/Assigned Driver/i)).toBeVisible();

    // Cold-start seed fires ~8s in (no live broadcast), marking the value
    // stale → past-tense number + the paused note. "is" is accepted too in
    // case a live broadcast ever races in first — either proves the pipeline.
    await expect(page.getByText(/shuttle (is|was) about \d+ min/i)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/live tracking paused/i)).toBeVisible();

    // The feature's hard invariant: an agent screen must NEVER show a raw
    // coordinate. Assert no lat/lng-looking decimal pair leaked into the DOM.
    const body = await page.locator("body").innerText();
    expect(body, "a coordinate-looking pair rendered on the agent screen").not.toMatch(/-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/);
  });
});
