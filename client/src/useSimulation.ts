import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeRuntime, Project, ScheduleResult, ScheduleSnapshot, SimState } from './types';

const TICK_MS = 100;

export interface Simulation {
  state: SimState;
  time: number;
  runtime: Record<string, NodeRuntime>;
  /** 模拟开始时冻结的本次排程快照（图编辑与现场续排均不改写；开始/重置时清空） */
  snapshot: ScheduleSnapshot | null;
  /** 现场续排确认后的待执行触发时间（仅本次模拟；开始/重置时清空） */
  replanStarts: Record<string, number>;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  /** 暂停中确认现场续排：仅更新待执行口令的触发时间，不写入项目 */
  applyReplan: (starts: Record<string, number>) => void;
}

/**
 * 按排程模拟执行口令。
 * - start/pause/resume/reset 控制时钟；
 * - start 时冻结本次排程快照，供结束/暂停后的执行复盘只读查看，
 *   模拟期间的图编辑、现场续排均不改写快照，reset 时清空；
 * - 排程或口令图变化时，仅同步“尚未执行”的口令的排定时间，
 *   正在执行与已完成的口令保持其实际记录不变；
 * - 排定时间被改到过去且仍未执行的口令，会在下一拍立即补发；
 * - 暂停中可通过现场续排（applyReplan）覆盖待执行口令的触发时间，
 *   仅作用于本次模拟，开始/重置时清空。
 */
export function useSimulation(project: Project, schedule: ScheduleResult | null): Simulation {
  const [state, setState] = useState<SimState>('idle');
  const [time, setTime] = useState(0);
  const [runtime, setRuntime] = useState<Record<string, NodeRuntime>>({});
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null);
  const [replanStarts, setReplanStarts] = useState<Record<string, number>>({});

  const stateRef = useRef(state);
  stateRef.current = state;
  const timeRef = useRef(time);
  timeRef.current = time;
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const projectRef = useRef(project);
  projectRef.current = project;
  const replanRef = useRef(replanStarts);
  replanRef.current = replanStarts;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // 口令图结构变化：移除已删除口令的运行记录与续排触发时间，为新增口令补登记。
  // 冻结快照中口令的运行记录即使被删除也保留，使执行复盘仍能完整呈现。
  useEffect(() => {
    if (stateRef.current === 'idle') return;
    setRuntime((prev) => {
      const next: Record<string, NodeRuntime> = {};
      for (const n of project.nodes) {
        next[n.id] = prev[n.id] ?? { status: 'pending' };
      }
      for (const entry of snapshotRef.current?.entries ?? []) {
        const rt = prev[entry.nodeId];
        if (rt) next[entry.nodeId] = rt;
      }
      return next;
    });
    setReplanStarts((prev) => {
      const ids = new Set(project.nodes.map((n) => n.id));
      const next: Record<string, number> = {};
      let changed = false;
      for (const [id, t] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = t;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [project]);

  // 时钟：仅 running 时前进。
  useEffect(() => {
    if (state !== 'running') return;
    const timer = setInterval(() => {
      const now = timeRef.current + TICK_MS / 1000;
      const sched = scheduleRef.current;
      const proj = projectRef.current;

      setRuntime((prev) => {
        const next: Record<string, NodeRuntime> = { ...prev };
        let allDone = true;
        for (const n of proj.nodes) {
          const rt = next[n.id] ?? { status: 'pending' as const };
          if (rt.status === 'pending') {
            // 续排确认过的触发时间优先于排程时间
            const scheduledStart = replanRef.current[n.id] ?? sched?.starts[n.id];
            if (scheduledStart !== undefined && scheduledStart <= now) {
              const actualStart = Math.max(scheduledStart, now);
              next[n.id] = {
                status: 'running',
                start: actualStart,
                end: actualStart + n.duration,
              };
              allDone = false;
            } else {
              next[n.id] = rt;
              allDone = false;
            }
          } else if (rt.status === 'running') {
            if (rt.end !== undefined && rt.end <= now) {
              next[n.id] = { ...rt, status: 'done' };
            } else {
              next[n.id] = rt;
              allDone = false;
            }
          }
        }
        if (allDone && proj.nodes.length > 0) {
          setState('finished');
        }
        return next;
      });
      timeRef.current = now;
      setTime(now);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [state]);

  const start = useCallback(() => {
    const proj = projectRef.current;
    const sched = scheduleRef.current;
    const initial: Record<string, NodeRuntime> = {};
    for (const n of proj.nodes) initial[n.id] = { status: 'pending' };
    setRuntime(initial);
    setReplanStarts({});
    // 开始时冻结本次排程快照：仅复制当时图结构与排程结果，之后不再被编辑/续排改写
    setSnapshot(
      sched?.ok
        ? {
            frozenAt: 0,
            makespan: sched.makespan,
            entries: proj.nodes.map((n) => {
              const start = sched.starts[n.id] ?? 0;
              return {
                nodeId: n.id,
                name: n.name,
                duration: n.duration,
                start,
                end: start + n.duration,
              };
            }),
          }
        : null,
    );
    timeRef.current = 0;
    setTime(0);
    setState('running');
  }, []);

  const pause = useCallback(() => {
    if (stateRef.current === 'running') setState('paused');
  }, []);

  const resume = useCallback(() => {
    if (stateRef.current === 'paused') setState('running');
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    timeRef.current = 0;
    setTime(0);
    setRuntime({});
    setReplanStarts({});
    setSnapshot(null);
  }, []);

  // 现场续排：仅暂停中可确认；整体替换待执行口令的触发时间（仅本次模拟）
  const applyReplan = useCallback((starts: Record<string, number>) => {
    if (stateRef.current !== 'paused') return;
    setReplanStarts(starts);
  }, []);

  return { state, time, runtime, snapshot, replanStarts, start, pause, resume, reset, applyReplan };
}
