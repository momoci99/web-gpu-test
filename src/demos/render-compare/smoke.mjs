// Drives every available renderer through runFixed at a small N and runs verifyComputeParity.
// Timings here are NOT performance results.
const COUNT = 2000;
const WARMUP = 10;
const MEASURE = 30;
const SCENE = { seed: 1, count: COUNT, width: 800, height: 600 };

const fmt = (x, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));

export default async function smoke({ page, caps, fail: failOuter, log }) {
  const fail = failOuter;
  const checkResult = (id, r) => {
    let bad = false;
    const fail = (msg) => {
      bad = true;
      failOuter(msg);
    };
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
    return bad;
  };

  log(`caps: ${JSON.stringify(caps)}`);
  // The live preview starts on load; it must be drawing, and must stop on request so it never shares the GPU with a run.
  await page.waitForFunction(() => document.querySelector('.stage canvas, .stage svg'), null, { timeout: 15_000 });
  await page.evaluate(() => window.__demo.suspendPreview());
  if ((await page.locator('.stage canvas, .stage svg').count()) !== 0) fail('preview: stage not empty after suspendPreview');
  const refreshHz = await page.evaluate(() => window.__demo.estimateRefresh());
  const rows = [];
  const ids = await page.evaluate(() => window.__demo.registry.map((e) => e.id));
  for (const id of ids) {
    const skip = await page.evaluate(
      ([id, caps]) => {
        const e = window.__demo.registry.find((x) => x.id === id);
        return window.__demo.unmetReason(e.requires, caps);
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
          const entry = window.__demo.registry.find((x) => x.id === id);
          const host = document.createElement('div');
          document.body.append(host);
          try {
            return await window.__demo.runFixed(entry, scene, caps, refreshHz, { host, warmupFrames, measureFrames });
          } finally {
            host.remove();
          }
        },
        [id, caps, SCENE, refreshHz, WARMUP, MEASURE],
      );
      const bad = checkResult(id, r);
      rows.push({ id, status: bad ? 'FAIL' : 'PASS', r });
    } catch (err) {
      fail(`${id}: runFixed threw: ${err.message.split('\n')[0]}`);
      rows.push({ id, status: 'FAIL', note: err.message.split('\n')[0] });
    }
  }

  let parity = null;
  if (caps.webgpu.kind === 'available') {
    try {
      parity = await page.evaluate((caps) => window.__demo.verifyComputeParity(caps), caps);
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
    log(`UI verify status: ${v}`);
  }
  log(`UI: ${uiRows} result rows, status "${uiStatus}", ${chartCanvas} chart canvas`);

  log(`\nsmoke only (N=${COUNT}, ${WARMUP} warmup + ${MEASURE} measured frames, refresh ~${fmt(refreshHz, 1)} Hz). Not performance results.`);
  log('renderer         status  interval.med  cpu.med  gpu.med  dropped  eff.frame  LoAF(count/block ms)  note');
  for (const { id, status, r, note } of rows) {
    const loaf = r?.longFrames ? `${r.longFrames.count}/${fmt(r.longFrames.totalBlockingMs, 1)}` : '-';
    log(
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
  if (parity) log(`\nverifyComputeParity: ${parity.pass ? 'PASS' : 'FAIL'} (max abs error ${parity.maxAbsError.toExponential(3)} over ${parity.count} circles, ${parity.steps} steps)`);
  else log(`\nverifyComputeParity: SKIPPED (${caps.webgpu.reason})`);
}
