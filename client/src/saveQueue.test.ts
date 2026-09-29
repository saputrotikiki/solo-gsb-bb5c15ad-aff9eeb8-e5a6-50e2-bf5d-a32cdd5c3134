import { SaveQueue, SaveStatus } from './saveQueue';
import type { Project } from './types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`, extra ?? '');
  }
}

const project = (tag: string): Project => ({
  nodes: [{ id: tag, name: tag, duration: 1, crew: 0, x: 0, y: 0 }],
  edges: [],
});

interface FakeSave {
  (p: Project): Promise<void>;
  calls: Project[];
  inFlight: number;
  maxConcurrent: number;
  failNext: number; // 接下来 N 次调用拒绝
  resolveAll: () => void;
  resolveNext: () => void;
  rejectNext: () => void;
}

/** 可控的假 save：调用返回挂起 Promise，由测试手动逐个 resolve/reject。 */
function makeFakeSave(): FakeSave {
  const waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const fn = ((p: Project) => {
    fn.calls.push(p);
    fn.inFlight++;
    fn.maxConcurrent = Math.max(fn.maxConcurrent, fn.inFlight);
    return new Promise<void>((resolve, reject) => {
      const settle = (ok: boolean) => () => {
        fn.inFlight--;
        if (ok) resolve();
        else reject(new Error('network'));
      };
      waiters.push({ resolve: settle(true), reject: settle(false) });
    });
  }) as FakeSave;
  fn.calls = [];
  fn.inFlight = 0;
  fn.maxConcurrent = 0;
  fn.failNext = 0;
  fn.resolveAll = () => {
    const all = waiters.splice(0);
    for (const w of all) w.resolve();
  };
  fn.resolveNext = () => waiters.shift()?.resolve();
  fn.rejectNext = () => waiters.shift()?.reject(new Error('network'));
  return fn;
}

/** 注入式手动计时器：保存队列内部计时完全由测试推进。 */
function makeManualTimers() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (cb: () => void) => {
      pending.push(cb);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
    flush: () => {
      const due = pending.splice(0);
      for (const cb of due) cb();
    },
    pending: () => pending.length,
  };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function makeQueue(save: FakeSave) {
  const timers = makeManualTimers();
  const events: SaveStatus[] = [];
  const queue = new SaveQueue({
    save,
    delay: 10,
    onStatusChange: (s) => events.push(s),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { queue, timers, events };
}

// 1. 基本：防抖后保存成功才显示 saved；落盘确认前为 saving
{
  const save = makeFakeSave();
  const { queue, timers, events } = makeQueue(save);
  queue.enqueue(project('a'));
  check('case1 saving immediately', queue.getStatus() === 'saving');
  timers.flush(); // 触发请求
  check('case1 request sent', save.calls.length === 1);
  check('case1 still saving before ack', queue.getStatus() === 'saving');
  save.resolveNext();
  await flushMicrotasks();
  check('case1 saved after ack', queue.getStatus() === 'saved', events);
  check('case1 saved version 1', queue.getSavedVersion() === 1);
}

// 2. 连续编辑防抖合并：仅最后一次完整快照被保存
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  const b = project('b');
  const c = project('c');
  queue.enqueue(a);
  queue.enqueue(b);
  queue.enqueue(c);
  timers.flush();
  check('case2 single request', save.calls.length === 1);
  check('case2 last snapshot saved', save.calls[0] === c);
  save.resolveNext();
  await flushMicrotasks();
  check('case2 saved', queue.getStatus() === 'saved');
}

// 3. 飞行期间继续编辑：旧请求完成后自动再保存最新版本；旧版本成功不提前“已保存”
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  const b = project('b');
  queue.enqueue(a);
  timers.flush();
  check('case3 first in flight', save.calls.length === 1 && save.calls[0] === a);
  // a 仍在飞行时编辑 b
  queue.enqueue(b);
  timers.flush(); // 防抖到期，但 a 未完成，b 必须等待，不得并行
  check('case3 no parallel request', save.calls.length === 1);
  check('case3 saving while older in flight', queue.getStatus() === 'saving');
  save.resolveNext(); // a 成功
  await flushMicrotasks();
  check('case3 not saved early (b pending)', queue.getStatus() === 'saving');
  check('case3 b sent after a', save.calls.length === 2 && save.calls[1] === b);
  save.resolveNext();
  await flushMicrotasks();
  check('case3 saved after latest ack', queue.getStatus() === 'saved');
  check('case3 latest version persisted', queue.getSavedVersion() === 2);
}

// 4. 串行保证：保存请求永不并发（每次独立完成自己的落盘）
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  const b = project('b');
  const c = project('c');
  queue.enqueue(a);
  timers.flush(); // a 发出
  queue.enqueue(b);
  timers.flush(); // a 仍在飞行：b 记为待保存，不并行发出
  save.resolveNext();
  await flushMicrotasks();
  check('case4 second in flight after a done', save.calls.length === 2 && save.calls[1] === b);
  queue.enqueue(c);
  timers.flush(); // b 仍在飞行：c 排队等待
  check('case4 no parallel while b flying', save.inFlight === 1);
  save.resolveNext();
  await flushMicrotasks();
  check('case4 third in flight after b done', save.calls.length === 3);
  check('case4 never concurrent', save.maxConcurrent === 1, save.maxConcurrent);
  check('case4 final is latest', save.calls[2] === c);
  save.resolveNext();
  await flushMicrotasks();
  check('case4 saved', queue.getStatus() === 'saved');
}

// 5. 最新版本失败：显示保存失败，保留待保存内容，可重试，重试成功恢复已保存
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  queue.enqueue(a);
  timers.flush();
  save.rejectNext();
  await flushMicrotasks();
  check('case5 error shown', queue.getStatus() === 'error');
  check('case5 saved version stays 0', queue.getSavedVersion() === 0);
  // 重试：重新提交保留的同一快照
  queue.retry();
  check('case5 retry sends retained content', save.calls.length === 2 && save.calls[1] === a);
  check('case5 saving during retry', queue.getStatus() === 'saving');
  save.resolveNext();
  await flushMicrotasks();
  check('case5 recovered saved', queue.getStatus() === 'saved');
  check('case5 saved version after retry', queue.getSavedVersion() === 1);
}

// 6. 失败期间继续编辑：最新编辑并入待保存内容，自动重试新内容（不重试旧的）
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  const b = project('b');
  queue.enqueue(a);
  timers.flush();
  save.rejectNext();
  await flushMicrotasks();
  check('case6 error', queue.getStatus() === 'error');
  queue.enqueue(b); // 失败后继续编辑
  check('case6 saving on new edit', queue.getStatus() === 'saving');
  timers.flush();
  check('case6 retries newest only', save.calls.length === 2 && save.calls[1] === b);
  save.rejectNext(); // 网络仍未恢复
  await flushMicrotasks();
  check('case6 error again with newest kept', queue.getStatus() === 'error');
  queue.retry();
  check('case7 retry keeps newest', save.calls[2] === b);
  save.resolveNext();
  await flushMicrotasks();
  check('case6 saved after recovery', queue.getStatus() === 'saved');
}

// 7. 旧版本失败但已有更新编辑：不进入 error，继续保存最新版本，成功即 saved
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  const b = project('b');
  queue.enqueue(a);
  timers.flush();
  queue.enqueue(b);
  timers.flush();
  save.rejectNext(); // a 失败，但 b 已排队
  await flushMicrotasks();
  check('case7 auto-continues, no error', queue.getStatus() === 'saving');
  check('case7 b already sent', save.calls.length === 2 && save.calls[1] === b);
  save.resolveNext();
  await flushMicrotasks();
  check('case7 saved with latest', queue.getStatus() === 'saved');
}

// 8. 旧版本成功但保存期间又失败过的链路：最终以最新版本确认才 saved（综合乱序确认）
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  const b = project('b');
  const c = project('c');
  queue.enqueue(a);
  timers.flush();
  queue.enqueue(b);
  save.rejectNext(); // a 失败 → b 保留为待保存（此时还没 flush，enqueue 已清旧防抖并重排）
  await flushMicrotasks();
  timers.flush(); // b 发出
  queue.enqueue(c); // b 飞行中编辑 c
  save.resolveNext(); // b 成功但 c 待保存
  await flushMicrotasks();
  check('case8 not saved while c pending', queue.getStatus() === 'saving');
  check('case8 c sent', save.calls.length === 3 && save.calls[2] === c);
  save.resolveNext();
  await flushMicrotasks();
  check('case8 final saved', queue.getStatus() === 'saved');
  check('case8 final version', queue.getSavedVersion() === 3);
}

// 9. 相同引用重复入队且已是 saved：不产生多余请求
{
  const save = makeFakeSave();
  const { queue, timers } = makeQueue(save);
  const a = project('a');
  queue.enqueue(a);
  timers.flush();
  save.resolveNext();
  await flushMicrotasks();
  queue.enqueue(a); // 同一引用，无新编辑
  timers.flush();
  check('case9 no redundant save', save.calls.length === 1);
  check('case9 stays saved', queue.getStatus() === 'saved');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} save queue checks failed`);
