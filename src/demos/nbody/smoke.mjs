// Runs every variant at a small N through runFixed, then verifyNBody, then drives the real UI once.
// Timings here are NOT performance results.
const COUNT = 1024;
const WARMUP = 5;
const MEASURE = 20;
const CONFIG = { seed: 1, count: COUNT, stepsPerFrame: 1 };

const fmt = (x, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));

export default async function smoke({ page, caps, fail, log }) {
  const finite = (s) => s && [s.median, s.p95, s.mean, s.min, s.max].every(Number.isFinite) && s.n > 0;
  const check = (id, r) => {
    const problems = [];
    if (r.variantId !== id) problems.push(`variantId ${r.variantId}`);
    if (r.count !== COUNT) problems.push(`count ${r.count}`);
    if (r.frames !== MEASURE) problems.push(`frames ${r.frames}`);
    if (!(r.refreshHz > 0 && Number.isFinite(r.refreshHz))) problems.push(`refreshHz ${r.refreshHz}`);
    if (!finite(r.interval) || r.interval.median <= 0) problems.push('bad interval summary');
    if (!finite(r.cpu) || r.cpu.median < 0) problems.push('bad cpu summary');
    if (r.gpu !== null && !finite(r.gpu)) problems.push('bad gpu summary');
    if (!(r.droppedRatio >= 0 && r.droppedRatio <= 1)) problems.push(`droppedRatio ${r.droppedRatio}`);
    if (!(r.effectiveFrameMs > 0 && Number.isFinite(r.effectiveFrameMs))) problems.push(`effectiveFrameMs ${r.effectiveFrameMs}`);
    problems.forEach((p) => fail(`${id}: ${p}`));
    return problems.length > 0;
  };

  log(`caps: ${JSON.stringify(caps)}`);
  const refreshHz = await page.evaluate(() => window.__demo.estimateRefresh());
  const ids = await page.evaluate(() => window.__demo.registry.map((e) => e.id));
  const rows = [];
  for (const id of ids) {
    const skip = await page.evaluate(
      ([id, caps]) => window.__demo.unmetReason(window.__demo.registry.find((x) => x.id === id).requires, caps),
      [id, caps],
    );
    if (skip) {
      rows.push({ id, status: 'SKIP', note: skip });
      continue;
    }
    try {
      const r = await page.evaluate(
        async ([id, caps, config, refreshHz, warmupFrames, measureFrames]) => {
          const entry = window.__demo.registry.find((x) => x.id === id);
          const host = document.createElement('div');
          document.body.append(host);
          try {
            return await window.__demo.runFixed(entry, config, caps, refreshHz, { host, warmupFrames, measureFrames });
          } finally {
            host.remove();
          }
        },
        [id, caps, CONFIG, refreshHz, WARMUP, MEASURE],
      );
      rows.push({ id, status: check(id, r) ? 'FAIL' : 'PASS', r });
    } catch (err) {
      fail(`${id}: runFixed threw: ${err.message.split('\n')[0]}`);
      rows.push({ id, status: 'FAIL', note: err.message.split('\n')[0] });
    }
  }

  let verified = null;
  if (caps.webgpu.kind === 'available') {
    try {
      verified = await page.evaluate((caps) => window.__demo.verifyNBody(caps), caps);
      if (verified.length === 0) fail('verifyNBody returned no results');
      for (const v of verified) {
        if (!Number.isFinite(v.maxAbsError) || !v.pass) fail(`verify ${v.id}: max abs error ${v.maxAbsError} > ${v.tolerance}`);
      }
    } catch (err) {
      fail(`verifyNBody threw: ${err.message.split('\n')[0]}`);
    }
  }

  const enabled = rows.filter((r) => r.status !== 'SKIP').length;
  if (enabled > 0) {
    await page.locator('input[type=number]').first().fill(String(COUNT));
    await page.getByRole('button', { name: '고정 N 실행' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.table tbody tr').length >= n, enabled, { timeout: 120_000 });
    const uiRows = await page.locator('.table tbody tr').count();
    const uiStatus = await page.locator('.status').textContent();
    if (uiRows !== enabled) fail(`UI: expected ${enabled} result rows, got ${uiRows}`);
    if (!uiStatus?.includes('완료')) fail(`UI: status after run was "${uiStatus}"`);
    if ((await page.locator('.chart canvas').count()) === 0) fail('UI: no uPlot canvas rendered');
    log(`UI: ${uiRows} result rows, status "${uiStatus}"`);
    await page.getByRole('button', { name: '정확도 검증' }).click();
    await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('정확도 검증 '));
    const v = await page.locator('.status').textContent();
    if (!v?.includes('통과')) fail(`UI: verify status "${v}"`);
  }

  log(`\nsmoke only (N=${COUNT}, ${WARMUP} warmup + ${MEASURE} measured frames, refresh ~${fmt(refreshHz, 1)} Hz). Not performance results.`);
  log('variant      status  eff.frame(ms)  interval.med  cpu.med  gpu.med  dropped  note');
  for (const { id, status, r, note } of rows) {
    log(
      [id.padEnd(11), status.padEnd(7), fmt(r?.effectiveFrameMs).padStart(13), fmt(r?.interval.median).padStart(12), fmt(r?.cpu.median, 3).padStart(8), fmt(r?.gpu?.median, 3).padStart(8), fmt(r?.droppedRatio, 3).padStart(8), ` ${note ?? ''}`].join('  '),
    );
  }
  if (verified) {
    for (const v of verified) log(`verify ${v.id}: ${v.pass ? 'PASS' : 'FAIL'} (max abs position error ${v.maxAbsError.toExponential(3)} px, tolerance ${v.tolerance}, N=${v.count}, ${v.steps} steps)`);
  } else {
    log(`verify: SKIPPED (${caps.webgpu.reason})`);
  }
}
