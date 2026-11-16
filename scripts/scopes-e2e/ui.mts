// Playwright checks of the scopes UI on the local dev server. Needs setup.mts (+ api.test.mts ran).
// Run: node --experimental-strip-types --no-warnings scripts/scopes-e2e/ui.mts
import { chromium } from "playwright";
import { admin, api, tokenFor, ownerToken, loadState, BASE, SHOTS } from "./lib.mts";

const S = loadState();
const M = S.members;
const db = admin();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }).catch(() => {});

const browser = await chromium.launch({ headless: true });
async function login(email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(`${BASE}/`, { timeout: 120_000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  return { ctx, page };
}
async function navHrefs(page) {
  await page.locator("aside nav a").first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  return page.locator("aside nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const noAccess = (label) => new RegExp(`You don't have access to ${label}`);

try {
  // ── EMP ──
  {
    const { ctx, page } = await login(M.EMP.email, M.EMP.password);
    await page.waitForURL(/\/dashboard/, { timeout: 120_000 });
    const hrefs = await navHrefs(page);
    check("EMP nav = Dashboard, Unibox, Leads, Campaigns, Settings", same(hrefs, ["/dashboard", "/unibox", "/leads", "/campaigns", "/settings"]), hrefs.join(" "));
    await shot(page, "emp-dashboard");

    await page.goto(`${BASE}/model-lab`, { timeout: 120_000 });
    await page.waitForTimeout(3000);
    const mlBlocked = !/\/model-lab/.test(page.url()) || (await page.getByText(noAccess("Model Lab")).count()) > 0;
    check("EMP /model-lab blocked (redirect or no-access)", mlBlocked, page.url());
    await shot(page, "emp-model-lab");

    await page.goto(`${BASE}/credits`, { timeout: 120_000 });
    const cr = await page.getByText(noAccess("Credits")).waitFor({ timeout: 60_000 }).then(() => true, () => false);
    check("EMP /credits shows no-access", cr || !/\/credits/.test(page.url()), page.url());
    await shot(page, "emp-credits");

    await page.goto(`${BASE}/leads`, { timeout: 120_000 });
    await page.getByRole("button", { name: /Create campaign/ }).waitFor({ timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const assignBtn = await page.getByRole("button", { name: /^Assign/ }).count();
    const addBtn = await page.getByRole("button", { name: /Add leads/ }).count();
    check("EMP leads: no Assign button", assignBtn === 0, `count ${assignBtn}`);
    check("EMP leads: no Add leads button", addBtn === 0, `count ${addBtn}`);
    // Tick a row so the bulk bar shows; Delete must not be in it.
    const boxes = page.getByRole("checkbox");
    let ticked = false;
    if ((await boxes.count()) > 1) { await boxes.nth(1).click().then(() => (ticked = true), () => {}); await page.waitForTimeout(800); }
    const sel = await page.getByText(/\d+ selected/).count();
    const del = await page.getByRole("button", { name: /^Delete/ }).count();
    check("EMP leads: no Delete in bulk bar", del === 0, `row ticked=${ticked}, bulk bar shown=${sel > 0}, delete count=${del}`);
    await shot(page, "emp-leads");

    await page.goto(`${BASE}/settings`, { timeout: 120_000 });
    await page.getByText("My profile").first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(2000);
    const team = await page.getByText("Team", { exact: true }).count();
    check("EMP settings: no Team section", team === 0, `count ${team}`);
    const badge = await page.getByText("Employee", { exact: true }).count();
    check('EMP role badge says "Employee"', badge > 0, `count ${badge}`);
    await shot(page, "emp-settings");
    await page.goto(`${BASE}/settings?section=team`);
    await page.waitForTimeout(3000);
    const teamDeep = await page.getByRole("button", { name: /Add member/ }).count();
    check("EMP ?section=team deep link does not show Team", teamDeep === 0, `Add member count ${teamDeep}`);
    await ctx.close();
  }

  // ── READONLY (restored to leads:read only, active) ──
  {
    await db.from("profiles").update({ scopes: ["leads:read"], is_active: true }).eq("id", M.READONLY.id);
    await db.auth.admin.updateUserById(M.READONLY.id, { ban_duration: "none" });
    const { ctx, page } = await login(M.READONLY.email, M.READONLY.password);
    await page.waitForURL((u) => !/\/$/.test(u.pathname) || u.pathname !== "/", { timeout: 120_000 }).catch(() => {});
    const hrefs = await navHrefs(page);
    check("READONLY nav = Leads, Settings", same(hrefs, ["/leads", "/settings"]), hrefs.join(" "));
    await shot(page, "readonly-nav");
    await page.goto(`${BASE}/dashboard`, { timeout: 120_000 });
    await page.waitForTimeout(3000);
    const dBlocked = !/\/dashboard/.test(page.url()) || (await page.getByText(noAccess("Dashboard")).count()) > 0;
    check("READONLY /dashboard blocked (redirect or no-access)", dBlocked, page.url());
    await shot(page, "readonly-dashboard");
    await ctx.close();
  }

  // ── MGR ──
  {
    const { ctx, page } = await login(M.MGR.email, M.MGR.password);
    await page.waitForURL(/\/dashboard/, { timeout: 120_000 });
    const hrefs = await navHrefs(page);
    check("MGR nav has Model Lab + Credits", hrefs.includes("/model-lab") && hrefs.includes("/credits"), hrefs.join(" "));
    await shot(page, "mgr-nav");

    await page.goto(`${BASE}/settings?section=team`, { timeout: 120_000 });
    const openEmp = page.getByRole("button", { name: "Open scopes-e2e EMP", exact: true });
    const teamOk = await openEmp.waitFor({ timeout: 90_000 }).then(() => true, () => false);
    check("MGR settings: Team visible with EMP row", teamOk);
    if (teamOk) {
      await openEmp.click();
      const mgrT = page.getByRole("button", { name: "Manager", exact: true });
      const empT = page.getByRole("button", { name: "Employee", exact: true });
      await empT.waitFor({ timeout: 30_000 }).catch(() => {});
      check("MGR picker: Manager + Employee template buttons", (await mgrT.count()) === 1 && (await empT.count()) === 1);
      const manage = page.getByRole("checkbox", { name: /Add people, reset passwords/ });
      const manageDisabled = await manage.isDisabled().catch(() => false);
      await manage.locator("xpath=..").hover().catch(() => {});
      await page.waitForTimeout(500);
      const tip = await page.getByText("Only the owner can give the team:write permission.").count();
      check("MGR picker: Team · Manage disabled with a reason", manageDisabled && tip > 0, `disabled=${manageDisabled}, tooltip=${tip > 0}`);
      await shot(page, "mgr-team-picker");

      const status = page.getByRole("checkbox", { name: /Set a reply's interest status/ });
      const saveBtn = page.getByRole("button", { name: /Save permissions/ });
      const save = async () => {
        const resp = page.waitForResponse((r) => r.url().includes(`/api/v1/settings/users/${M.EMP.id}`) && r.request().method() === "PATCH", { timeout: 30_000 });
        await saveBtn.click();
        return (await resp).status();
      };
      const mgrToken = await tokenFor(M.MGR.email, M.MGR.password);
      const empScopes = async () => (await api(mgrToken, "GET", "/api/v1/settings/users")).body.data.find((u) => u.id === M.EMP.id)?.scopes ?? [];

      const wasChecked = (await status.getAttribute("aria-checked")) === "true";
      await status.click();
      const s1 = await save();
      const after = await empScopes();
      check("MGR UI untick EMP unibox:write + save → API shows it gone", wasChecked && s1 === 200 && !after.includes("unibox:write"), `was=${wasChecked} status=${s1} has=${after.includes("unibox:write")}`);
      await shot(page, "mgr-after-save");

      // Restore through the UI (row re-renders after save: re-open if collapsed).
      if ((await status.count()) === 0) await page.getByRole("button", { name: "Open scopes-e2e EMP", exact: true }).click();
      await status.click();
      const s2 = await save();
      const restored = await empScopes();
      check("MGR UI restore unibox:write", s2 === 200 && restored.includes("unibox:write"), `status=${s2}`);
      if (!restored.includes("unibox:write")) await db.from("profiles").update({ scopes: S.employee }).eq("id", M.EMP.id);
    }
    await ctx.close();
  }

  // ── Deactivated login ──
  {
    const owner = await ownerToken();
    const r = await api(owner, "PATCH", `/api/v1/settings/users/${M.READONLY.id}`, { is_active: false });
    check("owner deactivates READONLY (setup for login check)", r.status === 200, `status ${r.status}`);
    const { ctx, page } = await login(M.READONLY.email, M.READONLY.password);
    const err = page.getByText(/no access or has been turned off/);
    const shown = await err.waitFor({ timeout: 60_000 }).then(() => true, () => false);
    const body = (await page.locator("form").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    check('deactivated login shows "no access / turned off"', shown, shown ? "" : `url=${page.url()} form text: ${body}`);
    await shot(page, "deactivated-login");
    await ctx.close();
  }
} catch (e) {
  check("ui script crashed", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\nUI: ${results.length - fails} pass, ${fails} fail`);
  process.exitCode = fails ? 1 : 0;
}
