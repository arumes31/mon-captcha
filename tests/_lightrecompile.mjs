/* Does approaching a cave recompile every shader in the scene?
   caves.js toggles cave PointLight.visible by distance band. three.js bakes the
   VISIBLE light counts into the program cache key, so flipping one invalidates
   every material. Teleport to a cave, drive the cull pass, render, and watch
   renderer.info.programs. */
import { chromium } from 'playwright';
import { SWIFTSHADER_ARGS } from './harness.mjs';
const BASE = process.env.CAPTCHA_BASE_URL || 'http://localhost:8080';
const b = await chromium.launch({ headless: true, args: SWIFTSHADER_ARGS });
const ctx = await b.newContext({ viewport: { width: 640, height: 400 } });
const p = await ctx.newPage();
let ok=false;
for(let a=0;a<4&&!ok;a++){ try{await p.goto(`${BASE}/index.html?probe&quality=high&seed=4242`,{waitUntil:'domcontentloaded',timeout:60000});}catch(e){}
 for(let i=0;i<70;i++){ if(await p.evaluate(()=>!!window.__probe).catch(()=>false)){ok=true;break;} await p.waitForTimeout(1000);} }
if(!ok){console.log('LOAD FAILED');await b.close();process.exit(2);}
const r = await p.evaluate(() => {
  const P=window.__probe,s=P.state;
  const snap=()=>{ let vis=0,tot=0; s.scene.traverse(o=>{ if(o.isPointLight){tot++; if(o.visible)vis++;} });
    return {programs:s.renderer.info.programs.length, visLights:vis, totLights:tot}; };
  const render=()=>{ try{ s.renderer.shadowMap.needsUpdate=true; s.composer? s.composer.render() : s.renderer.render(s.scene,s.camera);}catch(e){} };
  render(); const away = snap();
  // teleport to the first cave's centre and drive the cull/LOD pass
  const c=P.CAVES[0]; const n=c.paths[0][Math.floor(c.paths[0].length/2)];
  s.camera.position.set(n.x, n.floorY+1.6, n.z);
  for(let i=0;i<4;i++){ P.updateCaves(1/60, i/60); P.updateCaveLight(1/60, i/60); render(); }
  const near = snap();
  // walk back out
  s.camera.position.set(0, 5, 0);
  for(let i=0;i<4;i++){ P.updateCaves(1/60, i/60); P.updateCaveLight(1/60, i/60); render(); }
  const back = snap();
  return {away, near, back};
});
console.log('LIGHTRECOMPILE_BEGIN');
console.log(`far from cave : programs=${r.away.programs}  visiblePointLights=${r.away.visLights}/${r.away.totLights}`);
console.log(`AT the cave   : programs=${r.near.programs}  visiblePointLights=${r.near.visLights}/${r.near.totLights}   (+${r.near.programs-r.away.programs} programs)`);
console.log(`back outside  : programs=${r.back.programs}  visiblePointLights=${r.back.visLights}/${r.back.totLights}   (+${r.back.programs-r.near.programs} programs)`);
console.log('\nEvery "+N programs" is N shader link stalls at that moment.');
console.log('LIGHTRECOMPILE_END');
await b.close();
