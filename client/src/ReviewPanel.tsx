import { CycleInfo, Project, ReviewResult } from './types';
import { CyclePath } from './SidePanel';

interface ReviewPanelProps {
  /** 冻结的排程快照（null 表示本次模拟未冻结，复盘不可用） */
  snapshot: boolean;
  /** 复盘计算结果（不可用时为 null） */
  result: ReviewResult | null;
  /** 当前图的环依赖：未开始模拟且存在环时复盘不可用并展示成环路径 */
  cycle?: CycleInfo;
  project: Project;
  onClose: () => void;
}

/**
 * 执行复盘对话框（只读，不写回项目）。
 * - 结束或暂停时查看每条口令的计划起止、实际起止、开始/结束偏差与状态，
 *   行按实际开始时间排序；总览显示完成数、最大延迟与总工期偏差。
 * - 图有环或尚未开始模拟时显示不可用；重置后快照清空，复盘随之不可用。
 */
export function ReviewPanel(props: ReviewPanelProps) {
  const { result, cycle } = props;
  const paused = result?.state === 'paused';
  const finished = result?.state === 'finished';

  return (
    <div className="review-overlay" onPointerDown={props.onClose}>
      <div className="review-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3>执行复盘</h3>
        {!result ? (
          <>
            <p className="hint overrun-hint">
              {!props.snapshot
                ? cycle
                  ? '当前口令图存在环依赖，且尚未开始模拟；执行复盘不可用，请先解除成环约束后开始模拟。'
                  : '尚未开始模拟，执行复盘不可用；点击「开始模拟」冻结本次排程快照后，暂停或结束时即可复盘。'
                : '执行复盘暂不可用。'}
            </p>
            {!props.snapshot && cycle && <CyclePath project={props.project} cycle={cycle} />}
          </>
        ) : (
          <>
            <p className="hint">
              {finished
                ? `模拟已全部完成（t = ${round1(result.time)}s）：`
                : `模拟暂停于 t = ${round1(result.time)}s（数据截至当前时刻）：`}
              快照在开始时冻结，模拟期间的图编辑与现场续排均不改写。
            </p>
            <div className="review-summary">
              <span className="review-stat">
                完成 <b>{result.completedCount}</b> / {result.rows.length} 条
              </span>
              <span className="review-stat">
                最大延迟 <b className={result.maxDelay > 0 ? 'delta-up' : 'delta-zero'}>
                  {round1(result.maxDelay)}s
                </b>
              </span>
              <span className="review-stat">
                总工期 {round1(result.actualMakespan)}s / 计划 {round1(result.plannedMakespan)}s（
                <Delta value={result.makespanDelta} />
                {paused ? '，截至当前' : ''}）
              </span>
            </div>
            <table className="review-table">
              <thead>
                <tr>
                  <th>口令</th>
                  <th>计划起止</th>
                  <th>实际起止</th>
                  <th>开始偏差</th>
                  <th>结束偏差</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.nodeId}>
                    <td>{r.name}</td>
                    <td>
                      {round1(r.plannedStart)}s → {round1(r.plannedEnd)}s
                    </td>
                    <td>
                      {r.actualStart === undefined || r.actualEnd === undefined
                        ? '—'
                        : `${round1(r.actualStart)}s → ${round1(r.actualEnd)}s`}
                    </td>
                    <td>
                      {r.startDelta === undefined ? '—' : <Delta value={r.startDelta} />}
                    </td>
                    <td>{r.endDelta === undefined ? '—' : <Delta value={r.endDelta} />}</td>
                    <td>
                      <StatusBadge status={r.status} running={r.runtimeStatus === 'running'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              复盘只读：不写回项目，也不影响模拟；按「重置」清空本次快照与复盘。
            </p>
          </>
        )}
        <div className="review-actions">
          <button className="primary" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, running }: { status: ReviewResult['rows'][number]['status']; running: boolean }) {
  if (status === 'not-run') return <span className="review-status status-not-run">未执行</span>;
  return (
    <span className={`review-status ${status === 'delayed' ? 'status-delayed' : 'status-on-time'}`}>
      {status === 'delayed' ? '延迟' : '按时'}
      {running && ' · 进行中'}
    </span>
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
