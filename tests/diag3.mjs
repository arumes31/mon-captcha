import { chromium } from "playwright";
import { SWIFTSHADER_ARGS } from "./harness.mjs";
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("PAGEERROR: " + e.message + "\n" + (e.stack||"").split("\n").slice(0,4).join("\n")));
p.on("console", m => { const t=m.type(); if (t==="error") errs.push("ERR: "+m.text()); });
await p.goto("http://localhost:8347/test.html", { waitUntil: "domcontentloaded", timeout: 30000 });
for (let i=0;i<10;i++){
  await p.waitForTimeout(1500);
  const st = await p.evaluate(() => {
    const l = document.getElementById("loading");
    return { t: performance.now()|0, hasCaptcha: !!window.__captcha, hasProbe: !!window.__probe, loadingHidden: l ? l.classList.contains("hidden") : "NO#loading", scene: (window.__probe&&window.__probe.state&&window.__probe.state.scene)?"yes":"no" };
  });
  if (st.loadingHidden===true) { console.log("READY", JSON.stringify(st)); break; }
  if (i===9) console.log("NOT READY after 15s", JSON.stringify(st));
}
console.log("ERRS:\n"+(errs.slice(0,15).join("\n")||"(none)"));
await b.close();
