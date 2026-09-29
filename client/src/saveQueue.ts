import { Project } from './types';

export type SaveStatus = 'saved' | 'saving' | 'error';

export interface SaveQueueOptions {
  save: (project: Project) => Promise<void>;
  onStatusChange: (status: SaveStatus) => void;
  /** 防抖延时（毫秒），默认 400ms；测试可调小 */
  delay?: number;
  /** 注入计时器，默认使用 window.setTimeout */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * 单页面编辑保存链（防抖 + 串行落盘 + 版本归属）。
 *
 * 规则：
 * - 连续编辑先经防抖合并；上一次请求飞行期间产生的新版本不会丢失，而是记为
 *   pending，待在飞版本结束后再发起保存——成功保存的永远是“最后一次编辑”的
 *   完整项目快照；
 * - 同一时刻只有一个保存请求，且每个请求独立携带自己的 Project 快照，不借用
 *   其他请求的内容；
 * - 仅当“最新版本”成功落盘并收到确认时才回到 saved；最新版本完成之前始终为
 *   saving，旧版本成功不提前显示“已保存”；
 * - 最新版本失败时进入 error，待保存内容（最新 Project）原样保留，可 retry()；
 *   重试成功后恢复 saved。失败期间继续编辑会把最新编辑并入待保存内容并自动
 *   重新排起重试。
 */
export class SaveQueue {
  private readonly save: (project: Project) => Promise<void>;
  private readonly onStatusChange: (status: SaveStatus) => void;
  private readonly delay: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: { version: number; project: Project } | null = null;
  private pendingProject: Project | null = null;
  private pendingVersion = 0;
  private lastProject: Project | null = null;
  private status: SaveStatus = 'saved';
  private disposed = false;

  /** 单调递增的版本号：每次编辑入队 +1，便于断言“成功的是最后一次编辑”。 */
  private version = 0;
  /** 已成功确认落盘的最新版本号（测试用）。 */
  private savedVersion = 0;

  constructor(opts: SaveQueueOptions) {
    this.save = opts.save;
    this.onStatusChange = opts.onStatusChange;
    this.delay = opts.delay ?? 400;
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  getStatus(): SaveStatus {
    return this.status;
  }

  getSavedVersion(): number {
    return this.savedVersion;
  }

  /** 一次编辑：以该编辑产出的完整项目快照排起一次保存（防抖合并连续编辑）。 */
  enqueue(project: Project): void {
    if (this.disposed) return;
    // 内容未变化（同一引用）则不重复排起，避免无意义的写入
    if (project === this.lastProject && this.status === 'saved') return;
    this.lastProject = project;
    this.pendingProject = project;
    this.pendingVersion = ++this.version;
    if (this.timer) this.clearTimer(this.timer);
    this.setStatus('saving');
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.kick();
    }, this.delay);
  }

  /** 失败后手动重试：立即保存当前保留的待保存内容。 */
  retry(): void {
    if (this.disposed) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.kick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 发起下一次保存（若当前空闲且有待保存内容）。 */
  private kick(): void {
    if (this.inFlight || !this.pendingProject) return;
    const job = { version: this.pendingVersion, project: this.pendingProject };
    this.inFlight = job;
    this.pendingProject = null;
    this.pendingVersion = 0;
    this.setStatus('saving');

    this.save(job.project)
      .then(() => {
        // 只承认归属版本：若保存期间又出现更新的编辑，旧版本成功不改变状态
        if (job.version > this.savedVersion) this.savedVersion = job.version;
        this.inFlight = null;
        if (this.pendingProject) {
          // 有更新的版本等待落盘：保持 saving 并继续保存链
          this.kick();
        } else if (job.version === this.version) {
          // 本请求就是最新版本且已确认：才允许显示“已保存”
          this.setStatus('saved');
        }
        // 否则（理论上不会到达：pendingProject 为 null 且版本落后）保持 saving
      })
      .catch(() => {
        this.inFlight = null;
        // 保存期间又产生了更新编辑：以最新内容自动重试，不进入失败态
        if (this.pendingProject) {
          this.kick();
          return;
        }
        // 最新版本落盘失败：保留待保存内容并显示“保存失败”，等待 retry / 新编辑
        this.pendingProject = job.project;
        this.pendingVersion = job.version;
        this.setStatus('error');
      });
  }

  private setStatus(next: SaveStatus): void {
    if (next !== this.status) {
      this.status = next;
      this.onStatusChange(next);
    }
  }
}
