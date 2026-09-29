import { useMemo, useState } from 'react';
import { CycleInfo, Project, ScheduleResult } from './types';
import { Selection } from './GraphCanvas';
import { runWhatIf } from './schedule';

interface SidePanelProps {
  project: Project;
  schedule: ScheduleResult | null;
  selection: Selection | null;
  /** 当前图的环依赖（存在环时增量预演不可用，仅展示成环路径） */
  cycle?: CycleInfo;
  /** 班组总人数（正整数），用人数不可超过该值 */
  crewSize: number;
  onUpdateNode: (id: string, patch: { name?: string; duration?: number; crew?: number }) => void;
  onUpdateEdge: (id: string, patch: { minDelay?: number }) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}

export function SidePanel(props: SidePanelProps) {
  const { project, schedule, selection } = props;

  if (selection?.type === 'node') {
    const node = project.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    const startAt = schedule?.starts[node.id];
    const backward = schedule?.backward;
    const latestAt = backward?.latestStarts[node.id];
    const floatAt = backward?.floats[node.id];
    const isCritical = backward?.criticalNodeIds.includes(node.id) ?? false;
    return (
      <div className="side-panel">
        <h3>口令属性</h3>
        <label>
          名称
          <input
            value={node.name}
            onChange={(e) => props.onUpdateNode(node.id, { name: e.target.value })}
          />
        </label>
        <label>
          持续时长（秒）
          <input
            type="number"
            min={0}
            step={0.5}
            value={node.duration}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) props.onUpdateNode(node.id, { duration: v });
            }}
          />
        </label>
        <label>
          用人数（0–{props.crewSize} 的整数）
          <input
            type="number"
            min={0}
            max={props.crewSize}
            step={1}
            value={node.crew ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0 && v <= props.crewSize) {
                props.onUpdateNode(node.id, { crew: v });
              }
            }}
          />
        </label>
        <p className="hint">
          最早开始：{startAt !== undefined ? `${round1(startAt)}s` : '—'}
          {startAt !== undefined && `，最早完成：${round1(startAt + node.duration)}s`}
        </p>
        {backward && latestAt !== undefined && floatAt !== undefined && (
          <p className={`hint ${isCritical ? 'critical-hint' : ''}`}>
            最晚开始：{round1(latestAt)}s，浮动：{round1(floatAt)}s
            {isCritical && '（关键链）'}
          </p>
        )}
        <button className="danger" onClick={() => props.onDeleteNode(node.id)}>
          删除口令
        </button>
        <WhatIfSection
          key={`node-${node.id}-${node.duration}`}
          project={project}
          cycle={props.cycle}
          kind="node"
          targetId={node.id}
          currentValue={node.duration}
          valueLabel="试算持续时长（秒）"
          onApply={(v) => props.onUpdateNode(node.id, { duration: v })}
        />
      </div>
    );
  }

  if (selection?.type === 'edge') {
    const edge = project.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    const from = project.nodes.find((n) => n.id === edge.from);
    const to = project.nodes.find((n) => n.id === edge.to);
    return (
      <div className="side-panel">
        <h3>前置约束</h3>
        <p className="hint">
          {from?.name ?? '?'} → {to?.name ?? '?'}
        </p>
        <label>
          前置完成后至少等待（秒）
          <input
            type="number"
            min={0}
            step={0.5}
            value={edge.minDelay}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) props.onUpdateEdge(edge.id, { minDelay: v });
            }}
          />
        </label>
        <button className="danger" onClick={() => props.onDeleteEdge(edge.id)}>
          删除约束
        </button>
        {schedule?.backward?.criticalEdgeIds.includes(edge.id) && (
          <p className="hint critical-hint">该约束位于关键链上</p>
        )}
        <WhatIfSection
          key={`edge-${edge.id}-${edge.minDelay}`}
          project={project}
          cycle={props.cycle}
          kind="edge"
          targetId={edge.id}
          currentValue={edge.minDelay}
          valueLabel="试算等待秒数"
          onApply={(v) => props.onUpdateEdge(edge.id, { minDelay: v })}
        />
      </div>
    );
  }

  return (
    <div className="side-panel">
      <h3>操作说明</h3>
      <ul className="help">
        <li>点击工具栏「添加口令」新建口令节点</li>
        <li>拖动脉口令右侧圆点到另一口令，建立前置约束</li>
        <li>点击口令或约束线进行选中与编辑</li>
        <li>拖动空白处平移，滚轮缩放</li>
        <li>每次修改都会实时重算最早执行时间</li>
        <li>工具栏勾选「开场截止」后按截止秒数倒排，浮动最小的链路即关键链</li>
        <li>工具栏设置班组人数、口令侧栏设置用人数后，底部「班组排程」按容量实时重排</li>
        <li>选中口令或约束后可在侧栏「增量预演」试算，应用前不会保存</li>
      </ul>
      {schedule && (
        <p className="hint">
          当前排程总时长：{round1(schedule.makespan)}s，共 {project.nodes.length} 条口令、
          {project.edges.length} 条约束。
        </p>
      )}
      {schedule?.backward && (
        <p className={`hint ${schedule.backward.overrun > 0 ? 'overrun-hint' : ''}`}>
          开场截止：{round1(schedule.backward.deadline)}s，
          {schedule.backward.overrun > 0
            ? `超期 ${round1(schedule.backward.overrun)}s`
            : `余量 ${round1(schedule.backward.deadline - schedule.makespan)}s`}
          ，关键链 {schedule.backward.criticalNodeIds.length} 条口令。
        </p>
      )}
    </div>
  );
}

// ---------------- 增量预演 ----------------

interface WhatIfSectionProps {
  project: Project;
  cycle?: CycleInfo;
  kind: 'node' | 'edge';
  targetId: string;
  currentValue: number;
  valueLabel: string;
  onApply: (value: number) => void;
}

/**
 * 增量预演：在内存克隆的口令图上把单项数值改为“不小于当前值”的输入后试算，
 * 不触发编辑与保存链；只有点击「应用」才写入，「取消」丢弃试算。
 */
function WhatIfSection(props: WhatIfSectionProps) {
  const { project, cycle, kind, targetId, currentValue } = props;
  const [draft, setDraft] = useState(String(currentValue));

  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed + 1e-9 >= currentValue;
  const sameValue = valid && Math.abs(parsed - currentValue) < 1e-9;

  const result = useMemo(
    () =>
      valid
        ? runWhatIf(project, { kind, id: targetId, value: parsed })
        : null,
    // parsed 在 valid 时参与计算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, kind, targetId, valid ? parsed : null],
  );

  const apply = () => {
    if (!valid || sameValue) return;
    props.onApply(parsed);
    setDraft(String(parsed));
  };
  const cancel = () => setDraft(String(currentValue));

  return (
    <div className="whatif">
      <h4>增量预演</h4>
      {cycle ? (
        <div className="whatif-cycle">
          <p className="hint overrun-hint">当前图存在环依赖，无法试算；请先解除成环约束。</p>
          <CyclePath project={project} cycle={cycle} />
        </div>
      ) : (
        <>
          <label>
            {props.valueLabel}
            <span className="whatif-current">（当前 {round1(currentValue)}s，试算值不可更小）</span>
            <input
              type="number"
              min={currentValue}
              step={0.5}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          {!valid && (
            <p className="hint overrun-hint">请输入不小于 {round1(currentValue)}s 的数字。</p>
          )}
          {valid && result?.ok && result.current && result.trial && (
            <WhatIfOutcome
              project={project}
              kind={kind}
              targetId={targetId}
              trialValue={parsed}
              currentSchedule={result.current}
              trialSchedule={result.trial}
              delayed={result.delayed ?? []}
              sameValue={sameValue}
            />
          )}
          {valid && result && !result.ok && result.cycle && (
            <div className="whatif-cycle">
              <p className="hint overrun-hint">试算图出现环依赖，无法完成试算。</p>
              <CyclePath project={project} cycle={result.cycle} />
            </div>
          )}
          <div className="whatif-actions">
            <button className="primary" disabled={!valid || sameValue} onClick={apply}>
              应用
            </button>
            <button disabled={sameValue} onClick={cancel}>
              取消
            </button>
          </div>
          <p className="hint whatif-note">试算仅在内存中进行，不会保存；模拟中的已执行记录保持不变。</p>
        </>
      )}
    </div>
  );
}

interface OutcomeProps {
  project: Project;
  kind: 'node' | 'edge';
  targetId: string;
  trialValue: number;
  currentSchedule: ScheduleResult;
  trialSchedule: ScheduleResult;
  delayed: { nodeId: string; delay: number; pathNodeIds: string[]; pathEdgeIds: string[] }[];
  sameValue: boolean;
}

function WhatIfOutcome(props: OutcomeProps) {
  const { project, kind, targetId, trialValue, currentSchedule, trialSchedule, delayed, sameValue } =
    props;
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(project.edges.map((e) => [e.id, e]));

  const makespanDelta = trialSchedule.makespan - currentSchedule.makespan;
  const deadlineEnabled = !!project.deadline?.enabled;
  const curOverrun = currentSchedule.backward?.overrun ?? 0;
  const trialOverrun = trialSchedule.backward?.overrun ?? 0;
  const overrunDelta = trialOverrun - curOverrun;

  return (
    <div className="whatif-outcome">
      <table className="whatif-table">
        <thead>
          <tr>
            <th></th>
            <th>现行</th>
            <th>试算</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>总工期</td>
            <td>{round1(currentSchedule.makespan)}s</td>
            <td>
              {round1(trialSchedule.makespan)}s
              <Delta value={makespanDelta} />
            </td>
          </tr>
          <tr>
            <td>开场截止超期量</td>
            {deadlineEnabled ? (
              <>
                <td className={curOverrun > 0 ? 'num-overrun' : ''}>{round1(curOverrun)}s</td>
                <td className={trialOverrun > 0 ? 'num-overrun' : ''}>
                  {round1(trialOverrun)}s
                  <Delta value={overrunDelta} />
                </td>
              </>
            ) : (
              <td colSpan={2} className="num-muted">未启用开场截止</td>
            )}
          </tr>
        </tbody>
      </table>

      {sameValue ? (
        <p className="hint">试算值与当前值一致，排程无变化。</p>
      ) : delayed.length === 0 ? (
        <p className="hint">没有口令的开始时刻被推迟：浮动余量已吸收本次改动。</p>
      ) : (
        <ul className="whatif-delayed">
          {delayed.map((d) => {
            const node = nodeById.get(d.nodeId);
            // 路径在结果中按“被推迟口令 → 改动点”排列，展示时反转
            const nodes = [...d.pathNodeIds].reverse();
            const edges = [...d.pathEdgeIds].reverse();
            return (
              <li key={d.nodeId}>
                <p className="whatif-delay-line">
                  <span className="whatif-delay-name">{node?.name ?? d.nodeId}</span>
                  <span className="delta-up">实际推迟 +{round1(d.delay)}s</span>
                </p>
                <p className="whatif-path">
                  {nodes.map((nid, i) => {
                    const n = nodeById.get(nid);
                    // 路径已反转为“改动点 → 被推迟口令”：节点 i 之前的边是 edges[i-1]
                    const before = i > 0 ? edgeById.get(edges[i - 1]) : undefined;
                    const isNodeChange = kind === 'node' && nid === targetId;
                    const isEnd = nid === d.nodeId;
                    return (
                      <span key={`${nid}-${i}`} className="whatif-hop">
                        {before && (
                          <span
                            className={`whatif-hop-edge ${
                              kind === 'edge' && before.id === targetId ? 'hop-edge-change' : ''
                            }`}
                          >
                            {' —+'}
                            {round1(before.id === targetId ? trialValue : before.minDelay)}s→
                          </span>
                        )}
                        <span
                          className={`whatif-hop-node ${isNodeChange ? 'hop-change' : ''} ${
                            isEnd ? 'hop-end' : ''
                          }`}
                        >
                          {n?.name ?? nid}
                        </span>
                      </span>
                    );
                  })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Delta({ value }: { value: number }) {
  if (Math.abs(value) < 1e-9) return <span className="delta-zero"> （不变）</span>;
  return <span className="delta-up"> （{value > 0 ? '+' : '−'}{round1(Math.abs(value))}s）</span>;
}

/** 成环路径：沿环上的边从首个节点开始走完一环。 */
export function CyclePath({
  project,
  cycle,
  nodes,
  edges,
}: {
  project: Project;
  cycle: CycleInfo;
  /** 可选覆盖集合（如批量导入合并后的内存图）：优先用于名称与边解析 */
  nodes?: Project['nodes'];
  edges?: Project['edges'];
}) {
  const nodeById = new Map((nodes ?? project.nodes).map((n) => [n.id, n]));
  const allEdges = edges ?? project.edges;
  const edgeSet = new Set(cycle.edgeIds);
  const name = (id: string) => nodeById.get(id)?.name ?? id;

  const chain: string[] = [];
  const start = cycle.nodeIds[0];
  if (start) {
    chain.push(start);
    let cur = start;
    for (let i = 0; i < cycle.edgeIds.length; i++) {
      const e = allEdges.find((ed) => edgeSet.has(ed.id) && ed.from === cur);
      if (!e) break;
      chain.push(e.to);
      cur = e.to;
    }
  }

  return (
    <div className="cycle-path">
      <p className="hint">成环路径（{cycle.nodeIds.length} 条口令）：</p>
      <p className="cycle-path-line">
        {chain.map((id, i) => (
          <span key={`${id}-${i}`} className="whatif-hop">
            {i > 0 && <span className="whatif-hop-edge"> → </span>}
            <span className="whatif-hop-node hop-cycle">{name(id)}</span>
          </span>
        ))}
      </p>
    </div>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
