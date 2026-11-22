// Smoke test: builds the app, previews it, drives every available renderer through runFixed
// at a small N in Chromium, and runs verifyComputeParity. Timings here are NOT performance results.
import { build, preview } from 'vite';
import { chromium } from 'playwright';

const COUNT = 2000;
const WARMUP = 10;
const MEASURE = 30;
const SCENE = { seed: 1, count: COUNT, width: 800, height: 600 };

const GPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-webgpu-developer-features',
  '--ignore-gpu-blocklist',
  '--use-angle=metal',
];

const MODES = process.env.SMOKE_HEADED
  ? [{ name: 'headed', launch: { headless: false } }]
  : [
      { name: 'new headless', launch: { channel: 'chromium', headless: true } },
      { name: 'headed', launch: { headless: false } },
    ];

const failures = [];
const fail = (msg) => failures.push(msg);

async function openPage(mode, url) {
  const browser = await chromium.launch({ ...mode.launch, args: GPU_ARGS });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__bench !== undefined);
  const caps = await page.evaluate(() => window.__bench.detectCapabilities());
  return { browser, page, caps, consoleErrors };
}

function checkResult(id, r) {
  const finite = (s) => s && [s.median, s.p95, s.mean, s.min, s.max].every(Number.isFinite) && s.n > 0;
  if (r.rendererId !== id) fail(`${id}: rendererId mismatch (${r.rendererId})`);
  if (r.count !== COUNT) fail(`${id}: count ${r.count}`);
  if (r.frames !== MEASURE) fail(`${id}: frames ${r.frames}`);
  if (!(r.refreshHz > 0 && Number.isFinite(r.refreshHz))) fail(`${id}: refreshHz ${r.refreshHz}`);
  if (!finite(r.interval) || r.interval.median <= 0) fail(`${id}: bad interval summary`);
  if (!finite(r.cpu) || r.cpu.median < 0) fail(`${id}: bad cpu summary`);
  if (r.gpu !== null && !finite(r.gpu)) fail(`${id}: bad gpu summary`);
  if (!(r.droppedRatio >= 0 && r.droppedRatio <= 1)) fail(`${id}: droppedRatio ${r.droppedRatio}`);
  if (!(r.effectiveFrameMs > 0 && Number.isFinite(r.effectiveFrameMs))) fail(`${id}: effectiveFrameMs ${r.effectiveFrameMs}`);
}

const fmt = (x, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));

await build({ logLevel: 'warn' });
const server = await preview({ logLevel: 'warn', preview: { port: 0, host: '127.0.0.1' } });
const url = server.resolvedUrls.local[0];

let session = null;
let modeUsed = null;
const modeNotes = [];
try {
  for (const mode of MODES) {
    let s;
    try {
      s = await openPage(mode, url);
    } catch (err) {
      modeNotes.push(`${mode.name}: launch failed (${err.message.split('\n')[0]})`);
      continue;
    }
    const gpu = s.caps.webgpu;
    modeNotes.push(`${mode.name}: WebGPU ${gpu.kind === 'available' ? `available (${gpu.adapterInfo})` : `unavailable (${gpu.reason})`}`);
    if (session) await session.browser.close();
    session = s;
    modeUsed = mode.name;
    if (gpu.kind === 'available') break;
  }
  if (!session) throw new Error(`no browser mode could launch:\n${modeNotes.join('\n')}`);

  const { page, caps, consoleErrors } = session;
  console.log(`browser mode: ${modeUsed}`);
  for (const n of modeNotes) console.log(`  ${n}`);
  console.log(`caps: ${JSON.stringify(caps)}`);

  const refreshHz = await page.evaluate(() => window.__bench.estimateRefresh());
  const rows = [];
  const ids = await page.evaluate(() => window.__bench.registry.map((e) => e.id));
  for (const id of ids) {
    const skip = await page.evaluate(
      ([id, caps]) => {
        const e = window.__bench.registry.find((x) => x.id === id);
        return window.__bench.unmetReason(e.requires, caps);
      },
      [id, caps],
    );
    if (skip) {
      rows.push({ id, status: 'SKIP', note: skip });
      continue;
    }
    try {
      const r = await page.evaluate(
        async ([id, caps, scene, refreshHz, warmupFrames, measureFrames]) => {
          const entry = window.__bench.registry.find((x) => x.id === id);
          const host = document.createElement('div');
          document.body.append(host);
          try {
            return await window.__bench.runFixed(entry, scene, caps, refreshHz, { host, warmupFrames, measureFrames });
          } finally {
            host.remove();
          }
        },
        [id, caps, SCENE, refreshHz, WARMUP, MEASURE],
      );
      const before = failures.length;
      checkResult(id, r);
      rows.push({ id, status: failures.length === before ? 'PASS' : 'FAIL', r });
    } catch (err) {
      fail(`${id}: runFixed threw: ${err.message.split('\n')[0]}`);
      rows.push({ id, status: 'FAIL', note: err.message.split('\n')[0] });
    }
  }

  let parity = null;
  if (caps.webgpu.kind === 'available') {
    try {
      parity = await page.evaluate((caps) => window.__bench.verifyComputeParity(caps), caps);
      if (!parity.pass) fail(`verifyComputeParity: max abs error ${parity.maxAbsError} > 1e-2`);
    } catch (err) {
      fail(`verifyComputeParity threw: ${err.message.split('\n')[0]}`);
    }
  }

  // UI pass: the real controls produce one table row per enabled renderer and a chart canvas.
  const enabled = rows.filter((r) => r.status !== 'SKIP').length;
  await page.locator('input[type=number]').fill(String(COUNT));
  await page.getByRole('button', { name: '고정 N 실행' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.table tbody tr').length >= n, enabled, { timeout: 120_000 });
  const uiRows = await page.locator('.table tbody tr').count();
  const uiStatus = await page.locator('.status').textContent();
  const chartCanvas = await page.locator('.chart canvas').count();
  if (uiRows !== enabled) fail(`UI: expected ${enabled} result rows, got ${uiRows}`);
  if (!uiStatus?.includes('완료')) fail(`UI: status after run was "${uiStatus}"`);
  if (chartCanvas === 0) fail('UI: no uPlot canvas rendered');
  if (caps.webgpu.kind === 'available') {
    await page.getByRole('button', { name: '컴퓨트 검증' }).click();
    await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('컴퓨트 검증 '));
    const v = await page.locator('.status').textContent();
    if (!v?.includes('통과')) fail(`UI: verify status "${v}"`);
    console.log(`UI verify status: ${v}`);
  }
  console.log(`UI: ${uiRows} result rows, status "${uiStatus}", ${chartCanvas} chart canvas`);

  if (consoleErrors.length > 0) for (const e of consoleErrors) fail(`console error: ${e}`);

  console.log(`\nsmoke only (N=${COUNT}, ${WARMUP} warmup + ${MEASURE} measured frames, refresh ~${fmt(refreshHz, 1)} Hz). Not performance results.`);
  console.log('renderer         status  interval.med  cpu.med  gpu.med  dropped  eff.frame  LoAF(count/block ms)  note');
  for (const { id, status, r, note } of rows) {
    const loaf = r?.longFrames ? `${r.longFrames.count}/${fmt(r.longFrames.totalBlockingMs, 1)}` : '-';
    console.log(
      [
        id.padEnd(16),
        status.padEnd(7),
        fmt(r?.interval.median).padStart(12),
        fmt(r?.cpu.median, 3).padStart(8),
        fmt(r?.gpu?.median, 3).padStart(8),
        fmt(r?.droppedRatio, 3).padStart(8),
        fmt(r?.effectiveFrameMs).padStart(9),
        loaf.padStart(21),
        ` ${note ?? ''}`,
      ].join('  '),
    );
  }
  if (parity) console.log(`\nverifyComputeParity: ${parity.pass ? 'PASS' : 'FAIL'} (max abs error ${parity.maxAbsError.toExponential(3)} over ${parity.count} circles, ${parity.steps} steps)`);
  else console.log(`\nverifyComputeParity: SKIPPED (${caps.webgpu.reason})`);
  console.log(`console errors: ${consoleErrors.length}`);

  await session.browser.close();
} finally {
  await server.close();
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nSMOKE OK (for the renderers and checks listed above)');
