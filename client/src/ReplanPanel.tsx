import { CycleInfo, Project, ReplanResult } from './types';
import { CyclePath } from './SidePanel';

interface ReplanPanelProps {
  project: Project;
  /** 暂停时刻的续排试算（锁定口令 + 待执行新起止） */
  result: ReplanResult | null;
  /** 当前图的环依赖（存在时禁用续排并展示成环路径） */
  cycle?: CycleInfo;
  /** 待执行口令的现行触发时间（含上次续排结果，用于计算差值） */
  currentStarts: Record<string, number>;
  /** 暂停时的模拟时刻（秒） */
  now: number;
  onConfirm: (starts: Record<string, number>) => void;
  onClose: () => void;
}

/**
 * 现场续排确认对话框：展示锁定口令数量与每条待执行口令的新起止、
 * 与原计划的差值；确认后仅更新本次模拟的待执行触发时间（不写入项目）。
 * 图存在环依赖时禁用续排并展示成环路径。
 */
export function ReplanPanel(props: ReplanPanelProps) {
  const { project, result, cycle, currentStarts, now } = props;
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  const activeCycle = cycle ?? (result && !result.ok ? result.cycle : undefined);

  const locked = result?.locked ?? [];
  const runningCount = locked.filter((l) => l.status === 'running').length;
  const doneCount = locked.length - runningCount;

  // 展示按（新开始时刻, 口令 ID）排序
  const rows = result?.ok
    ? [...result.assignments].sort((a, b) =>
        a.start !== b.start ? a.start - b.start : a.nodeId < b.nodeId ? -1 : 1,
      )
    : [];

  // 现行计划总工期：锁定口令取实际结束，待执行取现行触发时刻 + 时长
  let currentMakespan = 0;
  if (result?.ok) {
    const lockedEnd = new Map(locked.map((l) => [l.nodeId, l.end]));
    for (const n of project.nodes) {
      const end = lockedEnd.get(n.id) ?? (currentStarts[n.id] ?? 0) + n.duration;
      if (end > currentMakespan) currentMakespan = end;
    }
  }

  const confirm = () => {
    if (!result?.ok || rows.length === 0) return;
    const starts: Record<string, number> = {};
    for (const a of result.assignments) starts[a.nodeId] = a.start;
    props.onConfirm(starts);
  };

  return (
    <div className="replan-overlay" onPointerDown={props.onClose}>
      <div className="replan-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>现场续排</h3>
        <p className="hint">
          暂停于 t = {round1(now)}s：以当前模拟时刻为待执行口令的最早起点，锁定 {locked.length} 条口令
          （执行中 {runningCount} · 已完成 {doneCount}）的实际起止；按前置等待、锁定口令的人手占用、
          班组容量与合并后的休息时段，为待执行口令寻找最早可行空档。
        </p>
        {activeCycle ? (
          <>
            <p className="hint overrun-hint">
              当前口令图存在环依赖，现场续排已禁用；请先解除成环约束。
            </p>
            <CyclePath project={project} cycle={activeCycle} />
          </>
        ) : !result ? null : rows.length === 0 ? (
          <p className="hint">没有待执行口令：全部口令均已完成或正在执行，无需续排。</p>
        ) : (
          <>
            <table className="replan-table">
              <thead>
                <tr>
                  <th>口令</th>
                  <th>原计划起止</th>
                  <th>新起止</th>
                  <th>开始差值</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const n = nodeById.get(a.nodeId);
                  const cur = currentStarts[a.nodeId];
                  const delta = cur === undefined ? 0 : a.start - cur;
                  return (
                    <tr key={a.nodeId}>
                      <td>{n?.name ?? a.nodeId}</td>
                      <td>
                        {cur === undefined
                          ? '—'
                          : `${round1(cur)}s → ${round1(cur + (n?.duration ?? 0))}s`}
                      </td>
                      <td>
                        {round1(a.start)}s → {round1(a.end)}s
                      </td>
                      <td>
                        <Delta value={delta} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="hint">
              总工期：现行 {round1(currentMakespan)}s → 续排 {round1(result.makespan)}s（
              <Delta value={result.makespan - currentMakespan} />
              ）；共 {rows.length} 条待执行口令。
            </p>
          </>
        )}
        <div className="replan-actions">
          <button onClick={props.onClose}>取消</button>
          <button className="primary" disabled={!result?.ok || rows.length === 0} onClick={confirm}>
            确认续排
          </button>
        </div>
        <p className="hint">
          确认后仅更新本次模拟中待执行口令的触发时间，不写入项目；按「继续」执行新计划，「重置」清空续排结果。
        </p>
      </div>
    </div>
  );
}

function Delta({ value }: { value: number }) {
  if (Math.abs(value) < 1e-9) return <span className="delta-zero">不变</span>;
  return (
    <span className={value > 0 ? 'delta-up' : 'delta-down'}>
      {value > 0 ? '+' : '−'}
      {round1(Math.abs(value))}s
    </span>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
