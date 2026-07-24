import { chromium } from "playwright";
import { SWIFTSHADER_ARGS } from "./harness.mjs";
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const p = await b.newPage();
await p.goto("http://localhost:8347/index.html?probe", { waitUntil: "domcontentloaded", timeout: 30000 });
await p.waitForTimeout(6000);
const v = await p.evaluate(()=>({ hidden: document.hidden, vis: document.visibilityState, fps: window.__captcha? window.__captcha.getFps():null }));
console.log("VIS:", JSON.stringify(v));
await b.close();
