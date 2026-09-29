import fs from 'fs';
import path from 'path';

/**
 * 原子落盘：write 到请求专属临时文件，fsync 后 rename 覆盖目标文件。
 *
 * 关键约束（并发保存同一项目时）：
 * - 每个请求使用各自独立的临时文件（含计数器与随机串），绝不借用其他请求
 *   的临时内容，因此并发请求之间不会互相截断或覆盖彼此的写入；
 * - 同一目标文件的落盘按到达顺序串行执行（per-file 队列），rename 只在
 *   该请求自身的写入完成后进行，响应“成功”时磁盘上已是该请求提交的内容；
 * - 写 / rename 失败时仅清理该请求自身的临时文件，并让该请求的 Promise
 *   拒绝，不影响队列中后续请求。
 */

/** 每个目标文件一条串行写队列，保证并发请求依次独立完成落盘。 */
const queues = new Map<string, Promise<unknown>>();

let tempCounter = 0;

/** 仅清理本次请求自己的临时文件（忽略“文件不存在”等清理错误）。 */
function cleanupTemp(tmp: string): void {
  fs.unlink(tmp, () => {
    /* best effort：临时文件可能已被 rename，忽略 */
  });
}

function writeFileAsync(file: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.writeFile(file, data, 'utf-8', (err) => (err ? reject(err) : resolve()));
  });
}

function renameAsync(oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 把 data 原子写入 file：请求专属临时文件 → rename 覆盖。
 * 同一 file 的并发调用按顺序依次完成，每次调用独立落盘自己的内容。
 */
export function atomicWriteFile(file: string, data: string): Promise<void> {
  const run = async (): Promise<void> => {
    // 临时文件名含 PID、进程内自增计数与随机串，确保并发请求互不共用
    const unique = `${process.pid}-${Date.now()}-${tempCounter++}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const tmp = `${file}.tmp.${unique}`;
    try {
      // 先确保目录存在（与 ensureDataFile 的行为一致）
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await writeFileAsync(tmp, data);
      await renameAsync(tmp, file);
    } catch (err) {
      cleanupTemp(tmp);
      throw err;
    }
  };

  // 同一目标文件串行：等待前一个请求落盘完成（无论成功或失败）后再执行本请求
  const prev = queues.get(file) ?? Promise.resolve();
  const result: Promise<void> = prev.then(run, run);
  // 队列中保存永不拒绝的“队列柄”，避免本请求失败且无后续请求接续时触发
  // unhandledRejection；返回给调用方的仍是可感知失败的 result。
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(file, tail);
  tail.finally(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return result;
}

/**
 * 启动时清理可能残留的临时文件：
 * 既清理早期版本共用的 project.json.tmp，也清理本模块的专属临时文件。
 */
export function cleanupStaleTempFiles(file: string): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.readdir(dir, (err, entries) => {
    if (err) return;
    for (const entry of entries) {
      if (entry === `${base}.tmp` || entry.startsWith(`${base}.tmp.`)) {
        fs.unlink(path.join(dir, entry), () => {
          /* best effort */
        });
      }
    }
  });
}
