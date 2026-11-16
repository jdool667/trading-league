// End-to-end test of the beta site (staging data, so the real league is untouched).
// Run: node tests/e2e.mjs   (uses Playwright from ~/Projects/fpl/node_modules)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.HOME + "/Projects/fpl/node_modules/playwright");

const URL = "https://jdool667.github.io/trading-league/beta/?v=" + Date.now();
const PASS = "bulls-chsiu2";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };

async function loaded(page) {
  await page.goto(URL);
  await page.waitForFunction(() => /trades? logged/.test(document.getElementById("status").textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#race .face").length === 5, null, { timeout: 20000 }).catch(() => {});
}

async function layoutChecks(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${label}: no sideways scrolling`, overflow <= 0, `overflow ${overflow}px`);
  check(`${label}: 5 faces on race chart`, (await page.locator("#race .face").count()) === 5);
  check(`${label}: 5 lines on race chart`, (await page.locator("#raceSvg path.line").count()) === 5);
  check(`${label}: 5 rows in standings`, (await page.locator("#board tr").count()) === 5);
  const faceImgsOk = await page.evaluate(() => [...document.querySelectorAll("#race .face img")].every((i) => i.complete && i.naturalWidth > 0));
  check(`${label}: face photos load`, faceImgsOk);
  const logSummary = await page.locator("#logSummary").textContent();
  check(`${label}: trade log summary`, /trades\. Latest:|No trades yet/.test(logSummary), logSummary);
  const pricesSummary = await page.locator("#pricesSummary").textContent();
  check(`${label}: prices summary`, pricesSummary.length > 0, pricesSummary);
  await page.screenshot({ path: `${process.env.SHOTS}/${label}.png`, fullPage: true });
}

const browser = await chromium.launch();
const errors = [];

// ---------- Desktop ----------
const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
desk.on("pageerror", (e) => errors.push("desktop: " + e.message));
await loaded(desk);
await layoutChecks(desk, "desktop");

// Hover the race chart -> tooltip with 5 people
await desk.locator("#race").scrollIntoViewIfNeeded();
const box = await desk.locator("#hit").boundingBox();
await desk.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
check("race chart hover shows everyone", (await desk.locator(".tip div").count()) === 5);

// Tap a name in standings -> their portfolio opens
await desk.locator('#board tr[data-person="Bell"]').click();
check("standings click opens that portfolio", (await desk.locator('#holdChips button[data-n="Bell"]').getAttribute("aria-pressed")) === "true");

// Wrong passphrase is rejected
await desk.selectOption("#fTrader", "Ethan");
await desk.fill("#fTicker", "AAPL");
await desk.waitForSelector("#tickerMatches .match", { timeout: 15000 });
await desk.fill("#fQty", "0.01");
await desk.fill("#fTotal", "2");
await desk.fill("#fPass", "wrong-pass");
await desk.click("#fSubmit");
await desk.click("#confirmTrade");
await desk.waitForFunction(() => /wrong passphrase/i.test(document.getElementById("fMsg").textContent), null, { timeout: 15000 }).then(() => check("wrong passphrase rejected", true), () => check("wrong passphrase rejected", false));

// Ambiguous ticker must be picked
await desk.fill("#fTicker", "tsco");
await desk.waitForFunction(() => document.querySelectorAll("#tickerMatches .match").length === 2, null, { timeout: 15000 });
check("TSCO shows two companies", (await desk.locator("#tickerMatches .match").count()) === 2);
await desk.fill("#fQty", "0.5");
await desk.fill("#fTotal", "2.83");
check("price per share worked out", (await desk.inputValue("#fPrice")) === "5.66", await desk.inputValue("#fPrice"));
await desk.fill("#fPass", PASS);
await desk.click("#fSubmit");
check("must pick a company when ambiguous", /Tap which company/.test(await desk.locator("#fMsg").textContent()));
await desk.click('#tickerMatches .match[data-symbol="TSCO.L"]');

// Confirm step shows the details, then save
await desk.click("#fSubmit");
const confirmText = await desk.locator("#confirmBox").textContent();
check("confirm step shows trader, company, shares, total", /Ethan/.test(confirmText) && /Tesco/.test(confirmText) && /0\.5/.test(confirmText) && /£2\.83/.test(confirmText));
await desk.click("#confirmTrade");
await desk.waitForFunction(() => /Saved/.test(document.getElementById("fMsg").textContent), null, { timeout: 15000 }).then(() => check("buy saved", true), () => check("buy saved", false, desk.locator("#fMsg").textContent()));
await desk.click("#logBox summary");
check("new trade shows in trade log", (await desk.locator("#log tr", { hasText: "TSCO.L" }).filter({ hasText: "Ethan" }).count()) >= 1);

// Remembered trader after reload
await loaded(desk);
check("trader remembered on this device", (await desk.inputValue("#fTrader")) === "Ethan");
check("passphrase remembered on this device", (await desk.getAttribute("#fPass", "placeholder")) === "Saved on this device");

// Selling more than held is blocked
await desk.click("#sideSell");
await desk.fill("#fTicker", "TSCO.L");
await desk.waitForSelector('#tickerMatches .match[aria-pressed="true"]', { timeout: 15000 });
await desk.fill("#fQty", "1000");
await desk.fill("#fTotal", "5000");
await desk.click("#fSubmit");
check("can't sell more than held", /only holds/.test(await desk.locator("#fMsg").textContent()));

// Price override: big warning, then trust checkbox gates saving
await desk.click("#sideBuy");
await desk.fill("#fQty", "0.5");
await desk.fill("#fTotal", "2.83");
await desk.fill("#fPrice", "5.70");
check("override shows big warning", await desk.locator("#priceWarn").isVisible());
await desk.click("#fSubmit");
check("override needs trust checkbox", await desk.locator("#confirmTrade").isDisabled());
await desk.check("#trustMe");
check("ticking it enables saving", await desk.locator("#confirmTrade").isEnabled());
await desk.click("#cancelTrade");
check("Go back closes confirm", !(await desk.locator("#confirmBox").isVisible()));

// Delete the test trade (two taps)
await desk.click("#logBox summary").catch(() => {});
if (!(await desk.locator("#logBox").getAttribute("open")) && (await desk.locator("#logBox").getAttribute("open")) !== "") await desk.click("#logBox summary");
const row = desk.locator("#log tr", { hasText: "TSCO.L" }).filter({ hasText: "Ethan" }).first();
await row.locator(".del").click();
await desk.locator("#log .del.confirm").click();
await desk.waitForFunction(() => ![...document.querySelectorAll("#log tr")].some((r) => /TSCO\.L/.test(r.textContent) && /Ethan/.test(r.textContent)), null, { timeout: 15000 })
  .then(() => check("delete removes the trade", true), () => check("delete removes the trade", false));

// Suggestion
await desk.fill("#sText", "E2E test suggestion");
await desk.click("#sSubmit");
await desk.waitForFunction(() => /E2E test suggestion/.test(document.getElementById("suggList").textContent), null, { timeout: 15000 })
  .then(() => check("suggestion posts and shows", true), () => check("suggestion posts and shows", false));

// ---------- Phone ----------
const phoneCtx = await browser.newContext({ ...devices["iPhone 13"] });
const phone = await phoneCtx.newPage();
phone.on("pageerror", (e) => errors.push("phone: " + e.message));
await loaded(phone);
await layoutChecks(phone, "phone");
const formFits = await phone.evaluate(() => { const r = document.getElementById("tradeForm").getBoundingClientRect(); return r.right <= window.innerWidth; });
check("phone: trade form fits screen", formFits);

check("no JavaScript errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
