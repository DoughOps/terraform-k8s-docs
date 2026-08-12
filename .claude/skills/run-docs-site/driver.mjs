#!/usr/bin/env node
// Minimal chromium-cli-style REPL for driving the docs/ static site.
// Reads newline-delimited commands from stdin, one per line:
//
//   nav <url>
//   wait-for <css-selector>
//   click <css-selector>
//   screenshot <name>          → screenshots/<name>.png
//   console-errors             → prints any page console.error/pageerror seen so far
//   eval <js-expression>       → prints the result
//   quit
//
// Example:
//   node driver.mjs <<'EOF'
//   nav http://127.0.0.1:8642/index.html
//   wait-for .sidebar
//   screenshot index
//   click a.nav-link[href="network-architecture.html"]
//   wait-for text=網路架構總覽
//   screenshot network-architecture
//   console-errors
//   quit
//   EOF

import { chromium } from "playwright";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = join(here, "screenshots");
mkdirSync(shotsDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const consoleIssues = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleIssues.push(`[console.error] ${msg.text()}`);
});
page.on("pageerror", (err) => consoleIssues.push(`[pageerror] ${err.message}`));

function toLocator(sel) {
  if (sel.startsWith("text=")) return page.getByText(sel.slice(5), { exact: false });
  return page.locator(sel);
}

const rl = createInterface({ input: process.stdin });
let exitCode = 0;

for await (const rawLine of rl) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const sp = line.indexOf(" ");
  const cmd = sp === -1 ? line : line.slice(0, sp);
  const arg = sp === -1 ? "" : line.slice(sp + 1).trim();

  try {
    switch (cmd) {
      case "nav":
        await page.goto(arg, { waitUntil: "domcontentloaded" });
        console.log(`ok: navigated to ${arg}`);
        break;
      case "wait-for":
        await toLocator(arg).first().waitFor({ state: "visible", timeout: 10000 });
        console.log(`ok: visible ${arg}`);
        break;
      case "click":
        await toLocator(arg).first().click();
        console.log(`ok: clicked ${arg}`);
        break;
      case "screenshot": {
        const file = join(shotsDir, `${arg || "screenshot"}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(`ok: screenshot -> ${file}`);
        break;
      }
      case "console-errors":
        if (consoleIssues.length === 0) console.log("ok: no console errors");
        else console.log(`FAIL: ${consoleIssues.length} console issue(s)\n${consoleIssues.join("\n")}`);
        break;
      case "eval":
        console.log("ok:", await page.evaluate(arg));
        break;
      case "quit":
        rl.close();
        break;
      default:
        console.log(`unknown command: ${cmd}`);
    }
  } catch (err) {
    console.log(`ERROR: ${cmd} ${arg} -> ${err.message.split("\n")[0]}`);
    exitCode = 1;
  }
}

await browser.close();
process.exit(exitCode);
