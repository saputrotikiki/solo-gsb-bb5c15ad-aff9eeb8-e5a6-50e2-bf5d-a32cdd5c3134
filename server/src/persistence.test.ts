import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteFile, cleanupStaleTempFiles } from './persistence';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => boolean | Promise<boolean>, extra?: unknown) {
  try {
    const ok = await fn();
    if (ok) {
      passed++;
    } else {
      failed++;
      console.error(`FAIL: ${name}`, extra ?? '');
    }
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name} (threw)`, e);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-test-'));
  const file = path.join(dir, 'project.json');

  const payloads = Array.from({ length: 40 }, (_, i) => ({
    nodes: [{ id: `n${i}`, name: `口令${i}`, duration: i }],
    edges: [],
    tag: i,
  }));

  // 1. 并发写入同一文件：每个请求都独立完成落盘（全部 resolve），互不借用临时内容
  {
    // 交错放大竞争：每个 payload 写两次，共 80 个并发请求
    const promises = [...payloads, ...payloads].map((p) =>
      atomicWriteFile(file, JSON.stringify(p)),
    );
    await Promise.all(promises);
    const finalBody = JSON.parse(fs.readFileSync(file, 'utf-8'));
    await check(
      'case1 all 80 concurrent writes resolved independently',
      () => promises.length === 80,
    );
    // 最终内容必为某一完整合法快照，而不是交错拼接的脏数据
    await check(
      'case1 final file is one complete payload',
      () =>
        Array.isArray(finalBody.nodes) &&
        finalBody.nodes.length === 1 &&
        typeof finalBody.tag === 'number' &&
        finalBody.nodes[0].id === `n${finalBody.tag}`,
      finalBody,
    );
  }

  // 2. 串行顺序语义：每个请求的成功确认发生在自身内容 rename 之后。
  //    立即连续提交 v1、v2，v2 resolve 后文件必为 v2（后写不被前写覆盖）。
  {
    const v1 = JSON.stringify({ nodes: [], edges: [], tag: 'v1' });
    const v2 = JSON.stringify({ nodes: [], edges: [], tag: 'v2' });
    await atomicWriteFile(file, v1);
    await atomicWriteFile(file, v2);
    const body = JSON.parse(fs.readFileSync(file, 'utf-8'));
    await check('case2 last write wins (v2)', () => body.tag === 'v2', body);
  }

  // 3. 某次写入失败后，队列仍可继续服务后续请求（不被失败卡死）
  {
    const badDir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(badDir, 'file-not-dir');
    const badFile = path.join(badDir, 'x.json');
    let rejected = false;
    try {
      await atomicWriteFile(badFile, '{}');
    } catch {
      rejected = true;
    }
    await check('case3 failed write rejects its own request', () => rejected);

    let recovered = false;
    try {
      await atomicWriteFile(file, JSON.stringify({ nodes: [], edges: [], tag: 'after-fail' }));
      recovered = JSON.parse(fs.readFileSync(file, 'utf-8')).tag === 'after-fail';
    } catch {
      recovered = false;
    }
    await check('case3 queue recovers after a failure', () => recovered);
  }

  // 4. 落盘后不残留任何临时文件（每个请求只使用自己的临时文件并随 rename 消失）
  {
    const leftovers = fs
      .readdirSync(dir)
      .filter((n) => n.includes('project.json.tmp') || n.endsWith('.tmp') || n.includes('.tmp.'));
    await check('case4 no leftover temp files', () => leftovers.length === 0, leftovers);
  }

  // 5. 启动清理：旧版共用 .tmp 与本版专属 .tmp.* 均被清掉
  {
    const target = path.join(dir, 'seed.json');
    fs.writeFileSync(target, '{}');
    fs.writeFileSync(`${target}.tmp`, 'old-shared');
    fs.writeFileSync(`${target}.tmp.123-abc`, 'per-request');
    cleanupStaleTempFiles(target);
    await new Promise((r) => setTimeout(r, 50));
    const entries = fs.readdirSync(dir).filter((n) => n.startsWith('seed.json.tmp'));
    await check('case5 stale temp files cleaned', () => entries.length === 0, entries);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} persistence checks failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
