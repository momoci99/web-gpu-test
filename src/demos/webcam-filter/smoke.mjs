// Runs each variant at 640x360 with two blur radii on the synthetic source, once on the fake camera stream,
// and the GPU-vs-CPU parity check. Timings here are NOT performance results.
const WIDTH = 640;
const HEIGHT = 360;
const RADII = [2, 8];
const WARMUP = 8;
const MEASURE = 24;

const fmt = (x, d = 2) => (x === null || x === undefined ? '-' : x.toFixed(d));
const finite = (s) => s && [s.median, s.p95, s.mean, s.min, s.max].every(Number.isFinite) && s.n > 0;

export default async function smoke({ page, caps, fail, log }) {
  const checkResult = (tag, id, r) => {
    let bad = false;
    const problem = (msg) => {
      bad = true;
      fail(`${tag}: ${msg}`);
    };
    if (r.variantId !== id) problem(`variantId ${r.variantId}`);
    if (r.width !== WIDTH || r.height !== HEIGHT) problem(`size ${r.width}x${r.height}`);
    if (r.frames !== MEASURE) problem(`frames ${r.frames}`);
    if (!(r.refreshHz > 0 && Number.isFinite(r.refreshHz))) problem(`refreshHz ${r.refreshHz}`);
    if (!finite(r.interval) || r.interval.median <= 0) problem('bad interval summary');
    if (!finite(r.cpu) || r.cpu.median < 0) problem('bad cpu summary');
    if (r.gpu !== null && !finite(r.gpu)) problem('bad gpu summary');
    if (!(r.droppedRatio >= 0 && r.droppedRatio <= 1)) problem(`droppedRatio ${r.droppedRatio}`);
    if (!(r.effectiveFrameMs > 0 && Number.isFinite(r.effectiveFrameMs))) problem(`effectiveFrameMs ${r.effectiveFrameMs}`);
    return bad;
  };

  log(`caps: ${JSON.stringify(caps)}`);
  if (caps.webgpu.kind === 'available') {
    await page.waitForFunction(() => document.querySelector('.stage canvas'), undefined, { timeout: 15_000 }).catch(() => fail('UI: preview canvas never appeared'));
  }
  await page.evaluate(() => window.__demo.suspendPreview());
  const refreshHz = await page.evaluate(() => window.__demo.estimateRefresh());
  const ids = await page.evaluate(() => window.__demo.registry.map((e) => e.id));
  const rows = [];

  const runOne = async (sourceKind, id, filter, radius) => {
    const tag = `${sourceKind}/${id}/${filter}${filter === 'blur' ? ` r=${radius}` : ''}`;
    try {
      const r = await page.evaluate(
        async ([sourceKind, id, filter, radius, refreshHz, width, height, warmupFrames, measureFrames]) => {
          const entry = window.__demo.registry.find((x) => x.id === id);
          const host = document.createElement('div');
          document.body.append(host);
          const source = await window.__demo.openSource(sourceKind, width, height);
          try {
            return await window.__demo.runVariant(entry, { width, height, filter, radius }, source, window.__caps, refreshHz, { host, warmupFrames, measureFrames });
          } finally {
            source.stop();
            host.remove();
          }
        },
        [sourceKind, id, filter, radius, refreshHz, WIDTH, HEIGHT, WARMUP, MEASURE],
      );
      rows.push({ tag, status: checkResult(tag, id, r) ? 'FAIL' : 'PASS', r });
    } catch (err) {
      fail(`${tag}: threw: ${err.message.split('\n')[0]}`);
      rows.push({ tag, status: 'FAIL', note: err.message.split('\n')[0] });
    }
  };

  for (const id of ids) {
    const skip = await page.evaluate(
      ([id, caps]) => window.__demo.unmetReason(window.__demo.registry.find((x) => x.id === id).requires, caps),
      [id, caps],
    );
    if (skip) {
      rows.push({ tag: id, status: 'SKIP', note: skip });
      continue;
    }
    for (const radius of RADII) await runOne('synthetic', id, 'blur', radius);
    await runOne('synthetic', id, 'sobel', 1);
    await runOne('camera', id, 'blur', 4);
  }

  let parity = null;
  if (caps.webgpu.kind === 'available') {
    try {
      parity = await page.evaluate((caps) => window.__demo.verifyParity(caps), caps);
      if (!parity.pass) fail(`verifyParity: ${JSON.stringify(parity.cases.filter((c) => !c.pass))}`);
      if (parity.cases.length === 0 || parity.cases.some((c) => !Number.isFinite(c.maxAbsDiff) || !Number.isFinite(c.meanAbsDiff))) fail('verifyParity: bad case results');
    } catch (err) {
      fail(`verifyParity threw: ${err.message.split('\n')[0]}`);
    }
  }

  // The real controls: one fixed-setting run produces a row per available variant and a chart canvas.
  const enabled = ids.length - rows.filter((r) => r.status === 'SKIP').length;
  await page.getByRole('button', { name: '고정 설정 실행' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('table.results tbody tr').length >= n, enabled, { timeout: 180_000 });
  const uiRows = await page.locator('table.results tbody tr').count();
  const uiStatus = await page.locator('.status').textContent();
  if (uiRows !== enabled) fail(`UI: expected ${enabled} result rows, got ${uiRows}`);
  if (!uiStatus?.includes('완료')) fail(`UI: status after run was "${uiStatus}"`);
  if ((await page.locator('.chart-box canvas').count()) === 0) fail('UI: no uPlot canvas rendered');
  log(`UI: ${uiRows} result rows, status "${uiStatus}"`);

  log(`\nsmoke only (${WIDTH}x${HEIGHT}, ${WARMUP} warmup + ${MEASURE} measured frames, refresh ~${fmt(refreshHz, 1)} Hz). Not performance results.`);
  log('case                                    status  interval.med  cpu.med  gpu.med  dropped  eff.frame  note');
  for (const { tag, status, r, note } of rows) {
    log(
      [tag.padEnd(39), status.padEnd(7), fmt(r?.interval.median).padStart(12), fmt(r?.cpu.median, 3).padStart(8), fmt(r?.gpu?.median, 3).padStart(8), fmt(r?.droppedRatio, 3).padStart(8), fmt(r?.effectiveFrameMs).padStart(9), ` ${note ?? ''}`].join('  '),
    );
  }
  if (parity) {
    log(`\nverifyParity ${parity.pass ? 'PASS' : 'FAIL'} (${parity.width}x${parity.height}, tolerance max ${parity.maxTolerance} mean ${parity.meanTolerance} of 255)`);
    for (const c of parity.cases) log(`  ${c.filter}${c.filter === 'blur' ? ` r=${c.radius}` : ''}: max ${c.maxAbsDiff}, mean ${fmt(c.meanAbsDiff, 4)}, output spread ${c.outputSpread} ${c.pass ? 'PASS' : 'FAIL'}`);
  } else log(`\nverifyParity: SKIPPED (${caps.webgpu.reason})`);
}
