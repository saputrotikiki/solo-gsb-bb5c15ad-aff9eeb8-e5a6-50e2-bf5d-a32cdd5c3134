import { useState } from 'react';
import { BreakPeriod, CrewScheduleResult, CycleInfo, Project } from './types';
import { CyclePath } from './SidePanel';

interface CrewPanelProps {
  project: Project;
  /** 班组排程结果（随编辑实时重算） */
  result: CrewScheduleResult | null;
  /** 当前图的环依赖（存在时停止输出班组结果，仅展示成环路径） */
  cycle?: CycleInfo;
  onAddBreak: () => void;
  /** 仅当 0≤起点<终点（均为有限数）时提交 */
  onUpdateBreak: (id: string, patch: { start?: number; end?: number }) => void;
  onDeleteBreak: (id: string) => void;
}

/**
 * 班组排程面板：按班组人数容量约束生成的不抢占可行排程，
 * 可编辑相对零点的休息时段（半开区间，容量为 0），列出每条口令的排定起止与总工期；
 * 有环时口令排程停止输出并展示成环路径，休息时段仍可编辑。
 */
export function CrewPanel(props: CrewPanelProps) {
  const { project, result, cycle } = props;
  const [collapsed, setCollapsed] = useState(false);

  const capacity = project.crewSize ?? 1;
  const breaks = project.breaks ?? [];
  const mergedBreaks = result?.mergedBreaks ?? [];
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  // 展示按（开始时刻, 口令 ID）排序；排定顺序允许后排者填入空档
  const rows = result?.ok
    ? [...result.assignments].sort((a, b) =>
        a.start !== b.start ? a.start - b.start : a.nodeId < b.nodeId ? -1 : 1,
      )
    : [];

  return (
    <section className="crew-panel">
      <header className="crew-panel-head">
        <h2>班组排程</h2>
        <span className="crew-meta">班组人数 {capacity} 人</span>
        {result?.ok && project.nodes.length > 0 && (
          <span className="crew-meta">总工期 {round1(result.makespan)}s</span>
        )}
        {cycle && <span className="crew-meta crew-meta-cycle">存在环依赖，已停止输出</span>}
        <span className="spacer" />
        <button className="crew-toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '展开 ▾' : '收起 ▴'}
        </button>
      </header>
      {!collapsed && (
        <div className="crew-panel-body">
          <div className="breaks-section">
            <div className="breaks-head">
              <h3>休息时段（相对零点，秒；时段内班组容量为 0）</h3>
              <button className="breaks-add" onClick={props.onAddBreak}>
                ＋ 添加休息时段
              </button>
            </div>
            {breaks.length === 0 ? (
              <p className="hint">暂无休息时段；需用人的正时长口令可在任意时刻排程。</p>
            ) : (
              <table className="crew-table breaks-table">
                <thead>
                  <tr>
                    <th>起点（秒）</th>
                    <th>终点（秒）</th>
                    <th className="col-op" />
                  </tr>
                </thead>
                <tbody>
                  {breaks.map((b) => (
                    <BreakRow key={b.id} period={b} onUpdate={props.onUpdateBreak} onDelete={props.onDeleteBreak} />
                  ))}
                </tbody>
              </table>
            )}
            <p className="hint">
              合并后零容量区间（交叠或相邻自动合并）：
              {mergedBreaks.length === 0
                ? '无'
                : mergedBreaks.map((b) => `[${round1(b.start)}s, ${round1(b.end)}s)`).join('、')}
              。零时长或用人数为 0 的口令仍可在休息时段内按前置时刻执行；休息设置仅影响班组排程。
            </p>
          </div>

          {cycle ? (
            <>
              <p className="hint overrun-hint">
                当前口令图存在环依赖，口令排程已停止输出；请先解除成环约束。
              </p>
              <CyclePath project={project} cycle={cycle} />
            </>
          ) : !result || rows.length === 0 ? (
            <p className="hint">暂无可排口令，请先添加口令。</p>
          ) : (
            <>
              <table className="crew-table">
                <thead>
                  <tr>
                    <th>口令</th>
                    <th>开始</th>
                    <th>结束</th>
                    <th>用人数</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const n = nodeById.get(a.nodeId);
                    return (
                      <tr key={a.nodeId}>
                        <td>{n?.name ?? a.nodeId}</td>
                        <td>{round1(a.start)}s</td>
                        <td>{round1(a.end)}s</td>
                        <td>{n?.crew ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint">
                共 {rows.length} 条口令，总工期 {round1(result.makespan)}s
                （容量 {capacity} 人，占用按 [开始, 结束) 计算，零时长不占人，需用人的正时长口令完整避开休息时段）。
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

interface BreakRowProps {
  period: BreakPeriod;
  onUpdate: (id: string, patch: { start?: number; end?: number }) => void;
  onDelete: (id: string) => void;
}

/**
 * 单条休息时段编辑行：起止秒数用本地草稿承接输入，
 * 仅当两端均为不小于 0 的有限数且起点 < 终点时才提交，避免把非法对保存到服务端。
 */
function BreakRow(props: BreakRowProps) {
  const { period } = props;
  const [startDraft, setStartDraft] = useState(String(period.start));
  const [endDraft, setEndDraft] = useState(String(period.end));

  const startNum = Number(startDraft);
  const endNum = Number(endDraft);
  const startValid = startDraft.trim() !== '' && Number.isFinite(startNum) && startNum >= 0;
  const endValid = endDraft.trim() !== '' && Number.isFinite(endNum) && endNum >= 0;
  const pairValid = startValid && endValid && startNum < endNum;

  // 任一字段变化后，只要整体合法就把两端一并提交
  const commit = (nextStart: string, nextEnd: string) => {
    const s = Number(nextStart);
    const e = Number(nextEnd);
    if (
      nextStart.trim() !== '' &&
      nextEnd.trim() !== '' &&
      Number.isFinite(s) &&
      Number.isFinite(e) &&
      s >= 0 &&
      e >= 0 &&
      s < e
    ) {
      props.onUpdate(period.id, { start: s, end: e });
    }
  };

  return (
    <>
      <tr>
        <td>
          <input
            className={`break-input ${!startValid ? 'invalid' : ''}`}
            type="number"
            min={0}
            step={0.5}
            value={startDraft}
            onChange={(e) => {
              setStartDraft(e.target.value);
              commit(e.target.value, endDraft);
            }}
          />
        </td>
        <td>
          <input
            className={`break-input ${!endValid ? 'invalid' : ''}`}
            type="number"
            min={0}
            step={0.5}
            value={endDraft}
            onChange={(e) => {
              setEndDraft(e.target.value);
              commit(startDraft, e.target.value);
            }}
          />
        </td>
        <td className="col-op">
          <button className="break-del" onClick={() => props.onDelete(period.id)}>
            删除
          </button>
        </td>
      </tr>
      {!pairValid && (
        <tr>
          <td colSpan={3} className="break-error">
            起止须为不小于 0 的有限数，且起点严格小于终点；当前修改未保存。
          </td>
        </tr>
      )}
    </>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
