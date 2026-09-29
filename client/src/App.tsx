import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadProject, saveProject } from './api';
import { BulkImportDialog } from './BulkImportDialog';
import { CrewPanel } from './CrewPanel';
import { GraphCanvas, Selection } from './GraphCanvas';
import { ReplanPanel } from './ReplanPanel';
import { computeCrewSchedule, computeReplan, computeSchedule } from './schedule';
import { computeReview } from './review';
import { SidePanel } from './SidePanel';
import { SnippetPanel } from './SnippetPanel';
import { Timeline } from './Timeline';
import { ReviewPanel } from './ReviewPanel';
import { BreakPeriod, CommandNode, CommandSnippet, Project, ScheduleResult } from './types';
import { buildSnippet, instantiateSnippet } from './snippets';
import { useSimulation } from './useSimulation';

const EMPTY: Project = { nodes: [], edges: [] };

/**
 * 兼容旧数据：班组人数缺省 1（正整数），口令用人数缺省 0（不超过班组人数的非负整数），
 * 休息时段缺省空，口令片段库缺省空。
 */
function normalizeProject(p: Project): Project {
  const raw = p.crewSize;
  const crewSize =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
  // 休息时段仅保留两端为有限数且 0≤起点<终点 的项（旧项目缺省为空）
  const breaks: BreakPeriod[] = Array.isArray(p.breaks)
    ? p.breaks
        .filter(
          (b): b is BreakPeriod =>
            !!b &&
            typeof b.start === 'number' &&
            typeof b.end === 'number' &&
            Number.isFinite(b.start) &&
            Number.isFinite(b.end) &&
            b.start >= 0 &&
            b.start < b.end,
        )
        .map((b, i) => ({
          id: typeof b.id === 'string' && b.id ? b.id : `break-${i}-${crypto.randomUUID()}`,
          start: b.start,
          end: b.end,
        }))
    : [];
  // 口令片段库：旧项目缺省为空；仅保留结构完整（根命中、边端点在片段内）的片段
  const snippets = Array.isArray(p.snippets)
    ? p.snippets.filter(isValidSnippet).map(normalizeSnippet)
    : [];
  return {
    ...p,
    crewSize,
    breaks,
    snippets,
    nodes: p.nodes.map((n) => {
      const c = n.crew;
      const crew =
        typeof c === 'number' && Number.isInteger(c) && c >= 0 ? Math.min(c, crewSize) : 0;
      return { ...n, crew };
    }),
  };
}

/** 片段结构完整性兜底（服务端已有同构校验，这里用于兼容异常的本地旧数据）。 */
function isValidSnippet(s: unknown): s is CommandSnippet {
  if (!s || typeof s !== 'object') return false;
  const sn = s as CommandSnippet;
  if (typeof sn.id !== 'string' || sn.id === '') return false;
  if (typeof sn.name !== 'string' || sn.name === '') return false;
  if (typeof sn.rootId !== 'string' || sn.rootId === '') return false;
  if (!Array.isArray(sn.nodes) || !Array.isArray(sn.edges)) return false;
  const nodeIds = new Set(sn.nodes.map((n) => n?.id).filter((id): id is string => typeof id === 'string'));
  if (!nodeIds.has(sn.rootId)) return false;
  for (const e of sn.edges) {
    if (!e || typeof e.id !== 'string' || !nodeIds.has(e.from) || !nodeIds.has(e.to)) return false;
  }
  return true;
}

/** 片段内字段兜底：用人数缺省 0，名称 / 时长 / 等待秒数非法时给安全默认值。 */
function normalizeSnippet(s: CommandSnippet): CommandSnippet {
  return {
    ...s,
    nodes: s.nodes.map((n) => ({
      ...n,
      name: typeof n.name === 'string' ? n.name : '未命名口令',
      duration:
        typeof n.duration === 'number' && Number.isFinite(n.duration) && n.duration >= 0
          ? n.duration
          : 0,
      crew:
        typeof n.crew === 'number' && Number.isInteger(n.crew) && n.crew >= 0 ? n.crew : 0,
      x: typeof n.x === 'number' && Number.isFinite(n.x) ? n.x : 0,
      y: typeof n.y === 'number' && Number.isFinite(n.y) ? n.y : 0,
    })),
    edges: s.edges.map((e) => ({
      ...e,
      minDelay:
        typeof e.minDelay === 'number' && Number.isFinite(e.minDelay) && e.minDelay >= 0
          ? e.minDelay
          : 0,
    })),
  };
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [selection, setSelection] = useState<Selection | null>(null);

  // 初始加载
  useEffect(() => {
    loadProject()
      .then((p) => setProject(normalizeProject(p)))
      .catch((e) => setLoadError(String(e?.message ?? e)));
  }, []);

  // 实时重算最早执行时间
  const schedule: ScheduleResult | null = useMemo(
    () => (project ? computeSchedule(project) : null),
    [project],
  );

  // 班组排程随编辑实时重算（有环时仅保留成环路径）
  const crewSchedule = useMemo(
    () => (project ? computeCrewSchedule(project) : null),
    [project],
  );

  // 出现环依赖时保留上次有效排程
  const [lastValid, setLastValid] = useState<ScheduleResult | null>(null);
  useEffect(() => {
    if (schedule?.ok) setLastValid(schedule);
  }, [schedule]);
  const effectiveSchedule = schedule?.ok ? schedule : lastValid;
  const cycle = schedule && !schedule.ok ? schedule.cycle : undefined;

  const sim = useSimulation(project ?? EMPTY, effectiveSchedule);

  // 现场续排：仅在暂停时打开；离开暂停（继续/重置）自动关闭
  const [replanOpen, setReplanOpen] = useState(false);
  useEffect(() => {
    if (sim.state !== 'paused') setReplanOpen(false);
  }, [sim.state]);

  // 执行复盘：结束或暂停时可查看；模拟进行中或重置后（无快照）自动关闭
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => {
    if (sim.state === 'running' || sim.state === 'idle') setReviewOpen(false);
  }, [sim.state]);

  // 复盘只读：基于开始时冻结的快照与当前运行记录即时计算，不写回项目
  const review = useMemo(
    () =>
      reviewOpen && sim.snapshot
        ? computeReview(sim.snapshot, sim.runtime, sim.state, sim.time)
        : null,
    [reviewOpen, sim.snapshot, sim.runtime, sim.state, sim.time],
  );

  // 暂停时刻的续排试算（纯内存，复用现有排程与模拟状态，不写入项目）
  const replan = useMemo(
    () => (replanOpen ? computeReplan(project ?? EMPTY, sim.runtime, sim.time) : null),
    [replanOpen, project, sim.runtime, sim.time],
  );

  // 待执行口令的现行触发时间：已确认的续排结果优先，否则取最早排程
  const currentTriggerStarts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!project) return out;
    for (const n of project.nodes) {
      const t = sim.replanStarts[n.id] ?? effectiveSchedule?.starts[n.id];
      if (t !== undefined) out[n.id] = t;
    }
    return out;
  }, [project, sim.replanStarts, effectiveSchedule]);

  // ---- 保存链（防抖 + 单请求在途 + 最新版本为准）----
  // 待保存的最新项目快照：编辑只更新此引用；保存成功且期间无更新才清空，
  // 保存失败时保留（引用比较即可判断是否有更新的编辑），供重试或自动续存。
  const pendingProjectRef = useRef<Project | null>(null);
  // 是否有保存请求在途：同一时刻只允许一个请求独立完成落盘，
  // 避免旧请求后返回时把状态错误地置为「已保存」，并保证最后一次编辑最后落盘。
  const saveInFlightRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 片段落放 / 保存需要在状态更新函数外取最新项目（StrictMode 下更新函数可能重复执行）
  const projectRef = useRef<Project | null>(null);

  /**
   * 保存泵：同一时刻只跑一个保存请求，每次取最新待保存快照独立落盘。
   * - 成功后若期间没有更新编辑（引用未变）才置「已保存」；否则立即续存最新快照（仍显示「保存中」）。
   * - 失败后若期间没有更新编辑，置「保存失败」并保留待保存内容（可点击重试）；否则续存最新快照。
   */
  const pumpSave = useCallback(async () => {
    if (saveInFlightRef.current) return;
    const snapshot = pendingProjectRef.current;
    if (!snapshot) return;
    saveInFlightRef.current = true;
    setSaveState('saving');
    let continueWithNewer = false;
    try {
      await saveProject(snapshot);
      if (pendingProjectRef.current === snapshot) {
        // 期间无更新编辑：本次即最新版本，已成功落盘并收到确认
        pendingProjectRef.current = null;
        setSaveState('saved');
      } else {
        // 期间又有编辑：旧请求的成功不作为「已保存」，续存最新快照
        continueWithNewer = true;
      }
    } catch {
      if (pendingProjectRef.current === snapshot) {
        // 最新版本失败：保留待保存内容，等待重试（不切回「已保存」）
        setSaveState('error');
      } else {
        // 期间又有编辑：续存最新快照
        continueWithNewer = true;
      }
    } finally {
      saveInFlightRef.current = false;
    }
    if (continueWithNewer) {
      void pumpSave();
    }
  }, []);

  /** 编辑后安排保存：记录最新快照并置「保存中」；防抖 400ms 后落盘。已有请求在途时由其完成后续存。 */
  const persist = useCallback(
    (next: Project) => {
      pendingProjectRef.current = next;
      setSaveState('saving');
      if (saveInFlightRef.current) return; // 在途请求完成后会自动续存最新快照
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void pumpSave();
      }, 400);
    },
    [pumpSave],
  );

  /** 保存失败后手动重试（之后新的编辑也会自动触发续存）。 */
  const retrySave = useCallback(() => {
    if (saveInFlightRef.current) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void pumpSave();
  }, [pumpSave]);

  const update = useCallback(
    (fn: (p: Project) => Project) => {
      const prev = projectRef.current;
      if (!prev) return;
      const next = fn(prev);
      projectRef.current = next;
      setProject(next);
      persist(next);
    },
    [persist],
  );

  const addNode = useCallback(() => {
    const id = crypto.randomUUID();
    update((p) => ({
      ...p,
      nodes: [
        ...p.nodes,
        { id, name: `口令${p.nodes.length + 1}`, duration: 3, crew: 0, x: 120 + p.nodes.length * 30, y: 120 + p.nodes.length * 24 },
      ],
    }));
    setSelection({ type: 'node', id });
  }, [update]);

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }));
    },
    [update],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<Pick<CommandNode, 'name' | 'duration' | 'crew'>>) => {
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
    },
    [update],
  );

  const deleteNode = useCallback(
    (id: string) => {
      update((p) => ({
        nodes: p.nodes.filter((n) => n.id !== id),
        edges: p.edges.filter((e) => e.from !== id && e.to !== id),
      }));
      setSelection(null);
    },
    [update],
  );

  const addEdge = useCallback(
    (from: string, to: string) => {
      update((p) => {
        if (p.edges.some((e) => e.from === from && e.to === to)) return p;
        return { ...p, edges: [...p.edges, { id: crypto.randomUUID(), from, to, minDelay: 0 }] };
      });
    },
    [update],
  );

  const updateEdge = useCallback(
    (id: string, patch: { minDelay?: number }) => {
      update((p) => ({ ...p, edges: p.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
    },
    [update],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      update((p) => ({ ...p, edges: p.edges.filter((e) => e.id !== id) }));
      setSelection(null);
    },
    [update],
  );

  const setDeadlineEnabled = useCallback(
    (enabled: boolean) => {
      update((p) => ({
        ...p,
        deadline: {
          enabled,
          // 首次启用时默认取当前最短工期，便于直接看到关键链
          seconds: p.deadline?.seconds ?? Math.ceil(effectiveSchedule?.makespan ?? 30),
        },
      }));
    },
    [update, effectiveSchedule],
  );

  const setDeadlineSeconds = useCallback(
    (seconds: number) => {
      update((p) => ({ ...p, deadline: { enabled: p.deadline?.enabled ?? true, seconds } }));
    },
    [update],
  );

  // 班组人数为正整数；下调时同步压减各口令用人数，保持“用人数 ≤ 班组人数”
  const setCrewSize = useCallback(
    (crewSize: number) => {
      update((p) => ({
        ...p,
        crewSize,
        nodes: p.nodes.map((n) => ({ ...n, crew: Math.min(n.crew ?? 0, crewSize) })),
      }));
    },
    [update],
  );

  const addBreak = useCallback(() => {
    update((p) => ({
      ...p,
      breaks: [...(p.breaks ?? []), { id: crypto.randomUUID(), start: 0, end: 1 }],
    }));
  }, [update]);

  const updateBreak = useCallback(
    (id: string, patch: Partial<Pick<BreakPeriod, 'start' | 'end'>>) => {
      update((p) => ({
        ...p,
        breaks: (p.breaks ?? []).map((b) => (b.id === id ? { ...b, ...patch } : b)),
      }));
    },
    [update],
  );

  const deleteBreak = useCallback(
    (id: string) => {
      update((p) => ({ ...p, breaks: (p.breaks ?? []).filter((b) => b.id !== id) }));
    },
    [update],
  );

  // 当前处于“放置模式”的片段 id（选中片段后点击画布空白处放置）
  const [placingSnippetId, setPlacingSnippetId] = useState<string | null>(null);

  // projectRef 声明于上方保存链区域；此处随渲染同步最新项目，供状态更新函数外的逻辑取最新值
  projectRef.current = project;

  const saveSnippet = useCallback(
    (rootId: string, name: string) => {
      const current = projectRef.current;
      if (!current) return;
      const snippet = buildSnippet(current, rootId, name);
      if (!snippet) return;
      update((p) =>
        p.nodes.some((n) => n.id === rootId)
          ? { ...p, snippets: [...(p.snippets ?? []), snippet] }
          : p,
      );
    },
    [update],
  );

  const deleteSnippet = useCallback(
    (id: string) => {
      update((p) => ({ ...p, snippets: (p.snippets ?? []).filter((s) => s.id !== id) }));
      setPlacingSnippetId((cur) => (cur === id ? null : cur));
    },
    [update],
  );

  /**
   * 在画布世界坐标 (x, y) 放置片段副本：以原根口令为锚点整体平移，
   * 复制节点与边全部生成新 ID 并重映射端点；不自动连接原图，
   * 副本与片段、原图彼此独立。放置后退出放置模式并选中新的根口令。
   */
  const placeSnippet = useCallback(
    (snippetId: string, x: number, y: number) => {
      const current = projectRef.current;
      if (!current) return;
      const snippet = (current.snippets ?? []).find((s) => s.id === snippetId);
      if (!snippet) {
        setPlacingSnippetId(null);
        return;
      }
      const placed = instantiateSnippet(snippet, x, y, current.crewSize ?? 1);
      if (!placed) return;
      update((p) => ({
        ...p,
        nodes: [...p.nodes, ...placed.nodes],
        edges: [...p.edges, ...placed.edges],
      }));
      setPlacingSnippetId(null);
      setSelection({ type: 'node', id: placed.rootNodeId });
    },
    [update],
  );

  // 多行口令批量导入：确认时沿现有编辑链整批写入（防抖保存、实时重算排程）
  const [bulkOpen, setBulkOpen] = useState(false);
  const commitBulkImport = useCallback(
    (newNodes: Project['nodes'], newEdges: Project['edges']) => {
      update((p) => ({
        ...p,
        nodes: [...p.nodes, ...newNodes],
        edges: [...p.edges, ...newEdges],
      }));
      setBulkOpen(false);
      setSelection(newNodes.length > 0 ? { type: 'node', id: newNodes[0].id } : null);
    },
    [update],
  );

  if (loadError) {
    return <div className="boot-message">加载失败：{loadError}</div>;
  }
  if (!project) {
    return <div className="boot-message">正在加载口令沙盘…</div>;
  }

  const simActive = sim.state === 'running' || sim.state === 'paused';
  const canStart = project.nodes.length > 0 && sim.state !== 'running' && sim.state !== 'paused';
  // 结束或暂停时可复盘（且开始时冻结过快照）；运行中禁用，未开始 / 重置后不可用
  const canReview =
    (sim.state === 'paused' || sim.state === 'finished') && sim.snapshot !== null;
  const deadline = project.deadline;
  const backward = effectiveSchedule?.backward;
  // 放置模式：选中的片段对象（删除片段后自动退出）
  const placingSnippet = placingSnippetId
    ? (project.snippets ?? []).find((s) => s.id === placingSnippetId) ?? null
    : null;
  // 已确认续排且仍在待执行的口令数（用于工具栏提示）
  const replanPending = Object.keys(sim.replanStarts).filter(
    (id) => (sim.runtime[id]?.status ?? 'pending') === 'pending',
  ).length;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>舞台换景口令沙盘</h1>
        <button onClick={addNode}>＋ 添加口令</button>
        <button
          title="粘贴多行清单批量导入口令与前置约束；先预览生成结果与总工期变化，确认后整批写入"
          onClick={() => setBulkOpen(true)}
        >
          ⧉ 批量导入
        </button>
        <span className="sep" />
        {sim.state === 'idle' || sim.state === 'finished' ? (
          <button className="primary" disabled={!canStart} onClick={sim.start}>
            ▶ 开始模拟
          </button>
        ) : sim.state === 'running' ? (
          <button className="primary" onClick={sim.pause}>⏸ 暂停</button>
        ) : (
          <button className="primary" onClick={sim.resume}>⏵ 继续</button>
        )}
        <button disabled={sim.state === 'idle'} onClick={sim.reset}>⟲ 重置</button>
        {sim.state === 'paused' && (
          <button
            title="以当前模拟时刻为待执行口令的最早起点，按前置等待、锁定口令的人手占用、班组容量与休息时段重排最早可行空档"
            onClick={() => setReplanOpen(true)}
          >
            ⚙ 现场续排
          </button>
        )}
        <button
          title="查看开始时冻结的排程快照与每条口令的实际执行对比（只读，不写回项目）"
          disabled={!canReview && sim.state === 'running'}
          onClick={() => setReviewOpen(true)}
        >
          📋 执行复盘
        </button>
        <span className="sim-clock">
          {sim.state !== 'idle' && `t = ${sim.time.toFixed(1)}s`}
          {sim.state === 'finished' && ' · 全部完成'}
        </span>
        {replanPending > 0 && <span className="replan-flag">已续排 {replanPending} 条</span>}
        <span className="sep" />
        <label className="deadline-toggle" title="按全部后继约束反向计算最晚开始与浮动">
          <input
            type="checkbox"
            checked={deadline?.enabled ?? false}
            onChange={(e) => setDeadlineEnabled(e.target.checked)}
          />
          开场截止
        </label>
        {deadline?.enabled && (
          <span className="deadline-ctrl">
            <input
              type="number"
              min={0}
              step={0.5}
              value={deadline.seconds}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) setDeadlineSeconds(v);
              }}
            />
            <span className="deadline-unit">s</span>
            {backward && backward.overrun > 0 && (
              <span className="overrun">超期 {round1(backward.overrun)}s</span>
            )}
          </span>
        )}
        <span className="sep" />
        <label className="crew-ctrl" title="班组总人数（正整数）；班组排程中同一时刻总用人数不超过该值">
          班组人数
          <input
            type="number"
            min={1}
            step={1}
            value={project.crewSize ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 1) setCrewSize(v);
            }}
          />
          <span className="deadline-unit">人</span>
        </label>
        <span className="spacer" />
        <button
          type="button"
          className={`save-state save-state-${saveState}`}
          onClick={saveState === 'error' ? retrySave : undefined}
          title={
            saveState === 'saved'
              ? '所有修改已保存到服务器'
              : saveState === 'saving'
                ? '正在把最新修改写入服务器；最新版本落盘并收到确认前不会显示「已保存」'
                : '保存失败：点击重试，待保存内容不会丢失'
          }
        >
          {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败（点击重试）'}
        </button>
      </header>

      {cycle && (
        <div className="cycle-banner">
          ⚠ 检测到环依赖（{cycle.nodeIds.length} 条口令成环），已保留上次有效排程；成环路径已红色高亮。
        </div>
      )}

      <div className="main">
        <div className="canvas-wrap">
          <GraphCanvas
            project={project}
            schedule={effectiveSchedule}
            cycle={cycle}
            runtime={sim.runtime}
            selection={selection}
            onSelect={setSelection}
            onMoveNode={moveNode}
            onAddEdge={addEdge}
            placingSnippet={placingSnippet}
            onPlaceSnippet={(x, y) => placingSnippet && placeSnippet(placingSnippet.id, x, y)}
            onCancelPlacing={() => setPlacingSnippetId(null)}
          />
          <SnippetPanel
            project={project}
            selection={selection}
            placingSnippetId={placingSnippetId}
            onSaveSnippet={saveSnippet}
            onDeleteSnippet={deleteSnippet}
            onSelectForPlacing={(id) =>
              setPlacingSnippetId((cur) => (cur === id ? null : id))
            }
          />
          {placingSnippet && (
            <div className="snippet-placement-hint">
              放置片段「{placingSnippet.name}」：点击画布空白处以原根口令为锚点放置（Esc 或再次点选取消）
            </div>
          )}
        </div>
        <SidePanel
          project={project}
          schedule={effectiveSchedule}
          selection={selection}
          cycle={cycle}
          crewSize={project.crewSize ?? 1}
          onUpdateNode={updateNode}
          onUpdateEdge={updateEdge}
          onDeleteNode={deleteNode}
          onDeleteEdge={deleteEdge}
        />
      </div>

      <CrewPanel
        project={project}
        result={crewSchedule}
        cycle={cycle}
        onAddBreak={addBreak}
        onUpdateBreak={updateBreak}
        onDeleteBreak={deleteBreak}
      />

      <Timeline
        project={project}
        schedule={effectiveSchedule}
        cycle={cycle}
        runtime={sim.runtime}
        simTime={sim.time}
        simActive={simActive || sim.state === 'finished'}
        replanStarts={sim.replanStarts}
      />

      {replanOpen && (
        <ReplanPanel
          project={project}
          result={replan}
          cycle={cycle}
          currentStarts={currentTriggerStarts}
          now={sim.time}
          onConfirm={(starts) => {
            // 仅更新本次模拟的待执行触发时间，不写入项目
            sim.applyReplan(starts);
            setReplanOpen(false);
          }}
          onClose={() => setReplanOpen(false)}
        />
      )}

      {reviewOpen && (
        <ReviewPanel
          project={project}
          snapshot={sim.snapshot !== null}
          // 图有环时复盘不可用并展示成环路径（冻结快照不被改写，环解除后可再查看）
          result={cycle ? null : review}
          cycle={cycle}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {bulkOpen && (
        <BulkImportDialog
          project={project}
          onConfirm={commitBulkImport}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </div>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
