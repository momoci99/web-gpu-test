// Shared smoke runner: builds the app, previews it, checks the home page, then runs every
// src/demos/<id>/smoke.mjs against a fresh page at #/<id>. Timings here are NOT performance results.
//   SMOKE_ONLY=<id>  run a single demo (the home check is skipped)
//   SMOKE_HEADED=1   headed Chromium only
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';

const DEMOS_DIR = new URL('../src/demos/', import.meta.url).pathname;

const GPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-webgpu-developer-features',
  '--ignore-gpu-blocklist',
  '--use-angle=metal',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
];

const MODES = process.env.SMOKE_HEADED
  ? [{ name: 'headed', launch: { headless: false } }]
  : [
      { name: 'new headless', launch: { channel: 'chromium', headless: true } },
      { name: 'headed', launch: { headless: false } },
    ];

const failures = [];

const demoIds = readdirSync(DEMOS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DEMOS_DIR, d.name, 'meta.ts')))
  .map((d) => d.name)
  .sort();
const only = process.env.SMOKE_ONLY;
if (only && !demoIds.includes(only)) {
  console.error(`SMOKE_ONLY=${only} matches no demo (have: ${demoIds.join(', ')})`);
  process.exit(1);
}

async function openPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(url);
  return { page, consoleErrors };
}

async function probeCaps(browser, url, id) {
  const { page } = await openPage(browser, `${url}#/${id}`);
  await page.waitForFunction(() => window.__caps !== undefined);
  const caps = await page.evaluate(() => window.__caps);
  await page.close();
  return caps;
}

async function checkHome(browser, url) {
  const { page, consoleErrors } = await openPage(browser, url);
  await page.waitForSelector('.card');
  const ids = (await page.locator('.card').evaluateAll((els) => els.map((e) => e.dataset.demoId))).sort();
  const links = await page.locator('.card').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  if (JSON.stringify(ids) !== JSON.stringify(demoIds)) fail('home', `cards ${JSON.stringify(ids)} != demos ${JSON.stringify(demoIds)}`);
  if (links.some((h, i) => !h?.startsWith('#/'))) fail('home', `bad card links ${JSON.stringify(links)}`);
  for (const e of consoleErrors) fail('home', `console error: ${e}`);
  console.log(`home: ${ids.length} cards (${ids.join(', ')})`);
  await page.close();
}

function fail(scope, msg) {
  failures.push(`${scope}: ${msg}`);
}

await build({ logLevel: 'warn' });
const server = await preview({ logLevel: 'warn', preview: { port: 0, host: '127.0.0.1' } });
const url = server.resolvedUrls.local[0];

let browser = null;
try {
  const modeNotes = [];
  let modeUsed = null;
  for (const mode of MODES) {
    let b;
    try {
      b = await chromium.launch({ ...mode.launch, args: GPU_ARGS });
    } catch (err) {
      modeNotes.push(`${mode.name}: launch failed (${err.message.split('\n')[0]})`);
      continue;
    }
    const caps = await probeCaps(b, url, demoIds[0]);
    const gpu = caps.webgpu;
    modeNotes.push(`${mode.name}: WebGPU ${gpu.kind === 'available' ? `available (${gpu.adapterInfo})` : `unavailable (${gpu.reason})`}`);
    if (browser) await browser.close();
    browser = b;
    modeUsed = mode.name;
    if (gpu.kind === 'available') break;
  }
  if (!browser) throw new Error(`no browser mode could launch:\n${modeNotes.join('\n')}`);
  console.log(`browser mode: ${modeUsed}`);
  for (const n of modeNotes) console.log(`  ${n}`);

  if (!only) await checkHome(browser, url);

  for (const id of demoIds) {
    if (only && id !== only) continue;
    console.log(`\n=== ${id} ===`);
    const smokePath = join(DEMOS_DIR, id, 'smoke.mjs');
    if (!existsSync(smokePath)) {
      fail(id, 'missing smoke.mjs');
      continue;
    }
    const { default: smoke } = await import(pathToFileURL(smokePath).href);
    const { page, consoleErrors } = await openPage(browser, `${url}#/${id}`);
    try {
      await page.waitForFunction(() => window.__demo !== undefined, undefined, { timeout: 30_000 });
      const caps = await page.evaluate(() => window.__caps);
      await smoke({ page, caps, url, log: console.log, fail: (msg) => fail(id, msg) });
    } catch (err) {
      fail(id, `smoke threw: ${err.message.split('\n')[0]}`);
    }
    for (const e of consoleErrors) fail(id, `console error: ${e}`);
    console.log(`console errors: ${consoleErrors.length}`);
    await page.close();
  }
  await browser.close();
} finally {
  await server.close();
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nSMOKE OK (for the demos and checks listed above)');
