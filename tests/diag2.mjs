import { chromium } from "playwright";
import { SWIFTSHADER_ARGS } from "./harness.mjs";
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("PAGEERROR: " + e.message + "\n" + (e.stack||"")));
p.on("console", m => { const t=m.type(); if (t==="error"||t==="warning") errs.push(t.toUpperCase()+": "+m.text()); });
await p.goto("http://localhost:8347/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
for (let i=0;i<12;i++){
  await p.waitForTimeout(1500);
  const st = await p.evaluate(() => {
    const l = document.getElementById("loading");
    return { t: performance.now()|0, hasCaptcha: !!window.__captcha, loadingHidden: l ? l.classList.contains("hidden") : null, err: (document.getElementById("error-message")||{}).textContent };
  });
  if (st.loadingHidden) { console.log("READY at", st); break; }
  if (i===11) console.log("NOT READY after 18s", st);
}
console.log("ERRORS/WARN:\n" + (errs.slice(0,20).join("\n") || "(none)"));
await b.close();
