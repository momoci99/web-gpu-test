// Generic over workloads: knows them only through window.__demo, so a new workload needs no edit here.
const fmt = (x, d = 3) => (x === null || x === undefined ? '-' : x.toFixed(d));
const finite = (s) => s && [s.median, s.p95, s.mean, s.min, s.max].every(Number.isFinite) && s.n > 0;

export default async function smoke({ page, caps, fail, log }) {
  const info = await page.evaluate(() => ({ workloads: window.__demo.workloads, hasDevice: window.__demo.hasDevice }));
  const gpuAvailable = caps.webgpu.kind === 'available';
  if (gpuAvailable && !info.hasDevice) fail('WebGPU is available but the page has no GPUDevice');
  if (info.workloads.length === 0) fail('no workloads discovered');

  const rows = [];
  for (const w of info.workloads) {
    for (const impl of w.impls) {
      const tag = `${w.id}/${impl.id}`;
      if (impl.kind === 'gpu' && !gpuAvailable) {
        rows.push({ tag, status: 'SKIP', note: 'WebGPU unavailable' });
        continue;
      }
      const sizes = w.smokeSizes.filter((n) => impl.maxN === null || n <= impl.maxN);
      if (sizes.length === 0) fail(`${tag}: no smoke size fits maxN ${impl.maxN}`);
      try {
        const { results } = await page.evaluate(([id, sizes, implId]) => window.__demo.runSweep(id, sizes, [implId]), [w.id, sizes, impl.id]);
        if (results.length !== sizes.length) fail(`${tag}: expected ${sizes.length} results, got ${results.length}`);
        for (const r of results) {
          const problems = [];
          if (!r.check.ok) problems.push(`check failed (${r.check.detail})`);
          if (!finite(r.e2e) || r.e2e.median <= 0) problems.push('bad e2e summary');
          if (r.runs < 3) problems.push(`runs ${r.runs}`);
          if (r.kind === 'gpu') {
            if (!finite(r.compute) || !finite(r.readback)) problems.push('bad compute/readback summary');
            if (r.kernel !== null && !finite(r.kernel)) problems.push('bad kernel summary');
            if (!(r.setupMs >= 0)) problems.push(`setupMs ${r.setupMs}`);
          }
          if (r.throughput !== null && !Number.isFinite(r.throughput)) problems.push('bad throughput');
          for (const p of problems) fail(`${tag} n=${r.n}: ${p}`);
          rows.push({ tag, n: r.n, status: problems.length ? 'FAIL' : 'PASS', r, note: r.check.detail });
        }
      } catch (err) {
        fail(`${tag}: runSweep threw: ${err.message.split('\n')[0]}`);
        rows.push({ tag, status: 'FAIL', note: err.message.split('\n')[0] });
      }
    }
  }

  const optionCount = await page.locator('select option').count();
  if (optionCount !== info.workloads.length) fail(`UI: ${optionCount} workload options for ${info.workloads.length} workloads`);
  if ((await page.getByRole('button', { name: '실행' }).count()) !== 1) fail('UI: run button missing');

  log('\nworkload/impl                 n        status  e2e.med  kernel.med  readback.med  setup(ms)  check');
  for (const { tag, n, status, r, note } of rows) {
    log(
      [
        tag.padEnd(28),
        String(n ?? '-').padStart(8),
        status.padEnd(6),
        fmt(r?.e2e.median).padStart(8),
        fmt(r?.kernel?.median).padStart(11),
        fmt(r?.readback?.median).padStart(13),
        fmt(r?.setupMs, 1).padStart(10),
        ` ${note ?? ''}`,
      ].join('  '),
    );
  }
}
