import {
  NodeRuntime,
  ReviewResult,
  ReviewRow,
  ReviewStatus,
  ScheduleSnapshot,
  SimState,
} from './types';

/**
 * 模拟时钟每拍 100ms，口令在计划时刻所在拍触发，实际开始相对计划存在一拍（0.1s）以内的量化差，
 * 该量级内视为按时；0.1s 多次累加的浮点误差一并由该容差吸收（仍远小于下一拍 0.2s）。
 */
export const ON_TIME_TOLERANCE = 0.105;

/**
 * 基于开始时冻结的排程快照与当前运行记录生成执行复盘（纯内存，只读，不写回项目）。
 *
 * - 每行给出计划起止、实际起止、开始/结束偏差与状态（按时 / 延迟 / 未执行）；
 * - 已开始口令（running / done）按实际开始时间升序排序，未执行口令排在最后
 *   （再按计划开始、口令 ID 稳定排序）；
 * - 总览：完成数、最大开始延迟、实际/计划总工期偏差。
 *   running 行的实际结束按其启动时记录的预计结束计；暂停中总工期为截至当前时刻的值。
 */
export function computeReview(
  snapshot: ScheduleSnapshot,
  runtime: Record<string, NodeRuntime>,
  state: SimState,
  time: number,
): ReviewResult {
  const rows: ReviewRow[] = snapshot.entries.map((e) => {
    const rt = runtime[e.nodeId];
    const runtimeStatus = rt?.status ?? 'pending';
    const started =
      (runtimeStatus === 'running' || runtimeStatus === 'done') &&
      typeof rt.start === 'number' &&
      Number.isFinite(rt.start);
    if (!started) {
      return {
        nodeId: e.nodeId,
        name: e.name,
        plannedStart: e.start,
        plannedEnd: e.end,
        runtimeStatus,
        status: 'not-run',
      };
    }
    const actualStart = (rt as NodeRuntime).start as number;
    const actualEnd =
      typeof rt.end === 'number' && Number.isFinite(rt.end) ? rt.end : actualStart + e.duration;
    const startDelta = actualStart - e.start;
    const status: ReviewStatus = startDelta > ON_TIME_TOLERANCE ? 'delayed' : 'on-time';
    return {
      nodeId: e.nodeId,
      name: e.name,
      plannedStart: e.start,
      plannedEnd: e.end,
      actualStart,
      actualEnd,
      startDelta,
      endDelta: actualEnd - e.end,
      runtimeStatus,
      status,
    };
  });

  rows.sort((a, b) => {
    if (a.actualStart !== undefined && b.actualStart !== undefined) {
      if (a.actualStart !== b.actualStart) return a.actualStart - b.actualStart;
    } else if (a.actualStart !== undefined) return -1;
    else if (b.actualStart !== undefined) return 1;
    if (a.plannedStart !== b.plannedStart) return a.plannedStart - b.plannedStart;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });

  let completedCount = 0;
  let maxDelay = 0;
  let actualMakespan = 0;
  for (const r of rows) {
    if (r.runtimeStatus === 'done') completedCount++;
    // 最大延迟只统计被判为“延迟”的口令（按时口令一拍内的时钟量化漂移不计）
    if (r.status === 'delayed' && r.startDelta !== undefined) {
      maxDelay = Math.max(maxDelay, r.startDelta);
    }
    if (r.actualEnd !== undefined) actualMakespan = Math.max(actualMakespan, r.actualEnd);
  }

  return {
    rows,
    completedCount,
    maxDelay,
    plannedMakespan: snapshot.makespan,
    actualMakespan,
    makespanDelta: actualMakespan - snapshot.makespan,
    state,
    time,
  };
}
