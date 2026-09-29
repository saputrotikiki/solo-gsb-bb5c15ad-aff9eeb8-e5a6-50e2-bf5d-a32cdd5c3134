import { useMemo, useState } from 'react';
import { Project } from './types';
import { planBulkImport } from './bulkImport';
import { CyclePath } from './SidePanel';

interface BulkImportDialogProps {
  project: Project;
  /** 确认写入：传入已分配 ID 的新节点与新约束，由上层沿编辑链整批写入 */
  onConfirm: (nodes: Project['nodes'], edges: Project['edges']) => void;
  onClose: () => void;
}

const PLACEHOLDER = `# 行号 名称 时长(秒) 用人数 [前置:最少等待秒数 …]
# 纯数字前置引用本批行号（可引用后面的行），其余按现有口令 ID 引用
1 "幕布落下" 3 1
2 布景A撤场 8 2 1:1
3 布景B上场 10 2 2:2 n-lights-dim:0
4 演员就位 4 1 3:0`;

/**
 * 导演多行口令批量导入对话框：
 * 粘贴多行清单后实时解析（允许引用后面的行），先预览将生成的口令、约束及
 * 总工期变化；任何一行非法（重复行号 / 缺失引用 / 数值非法）或合并后成环，
 * 均按物理行号指出原因且不可确认。取消不保存；确认后整批写入当前项目。
 */
export function BulkImportDialog({ project, onConfirm, onClose }: BulkImportDialogProps) {
  const [text, setText] = useState('');

  const plan = useMemo(() => planBulkImport(text, project), [text, project]);

  const errorLines = plan.lines.filter((l) => l.errors.length > 0);
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));

  const fmtPrereq = (raw: string): { text: string; title?: string } => {
    // 预览中把现有口令 ID 替换为「名称(ID)」便于核对；本批行号引用原样展示
    const cut = raw.lastIndexOf(':');
    if (cut <= 0) return { text: raw };
    const ref = raw.slice(0, cut);
    const wait = raw.slice(cut + 1);
    if (/^\d+$/.test(ref)) return { text: `行${ref} 等待${wait}s` };
    const n = nodeById.get(ref);
    return n
      ? { text: `${n.name} 等待${wait}s`, title: ref }
      : { text: raw };
  };

  return (
    <div className="replan-overlay" onPointerDown={onClose}>
      <div
        className="replan-dialog bulk-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h3>批量导入口令</h3>
        <p className="hint">
          每行一条：<code>行号 名称 时长(秒) 用人数</code>，后续可跟若干
          <code> 前置:最少等待秒数</code>。纯数字引用本批行号（<strong>允许引用后面的行</strong>），
          其余文本按现有口令 ID 引用；名称含空格时用英文双引号包裹。空行与「#」开头的注释行会忽略。
          时长与等待秒数须为有限非负数，用人数须为不超过班组人数（{project.crewSize ?? 1}）的非负整数。
        </p>
        <textarea
          className="bulk-textarea"
          autoFocus
          spellCheck={false}
          rows={9}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {plan.globalErrors.map((msg, i) => (
          <p key={`g${i}`} className="hint overrun-hint">
            {msg}
          </p>
        ))}
        {plan.cycle && (
          <CyclePath
            project={project}
            cycle={plan.cycle}
            nodes={[...project.nodes, ...plan.nodes]}
            edges={[...project.edges, ...plan.edges]}
          />
        )}

        {plan.lineCount > 0 && (
          <>
            <table className="replan-table bulk-table">
              <thead>
                <tr>
                  <th>文本行</th>
                  <th>行号</th>
                  <th>名称</th>
                  <th>时长</th>
                  <th>用人</th>
                  <th>前置（等待秒数）</th>
                  <th>合并后开始</th>
                  <th>问题</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => {
                  const bad = l.errors.length > 0;
                  const start = l.newNodeId ? plan.mergedSchedule?.starts[l.newNodeId] : undefined;
                  return (
                    <tr key={l.sourceLine} className={bad ? 'bulk-row-err' : ''}>
                      <td>{l.sourceLine}</td>
                      <td>{l.lineNo ?? '—'}</td>
                      <td>{l.name ?? '—'}</td>
                      <td>{l.duration !== undefined ? `${l.duration}s` : '—'}</td>
                      <td>{l.crew ?? '—'}</td>
                      <td>
                        {l.prereqs.length === 0
                          ? '—'
                          : l.prereqs.map((p, pi) => {
                              const f = fmtPrereq(p.raw);
                              const missing =
                                p.ref !== '' && p.resolvedFrom === undefined;
                              return (
                                <span
                                  key={`${pi}-${p.raw}`}
                                  className={`bulk-prereq ${missing ? 'bulk-prereq-miss' : ''}`}
                                  title={f.title}
                                >
                                  {missing ? `⚠ ${f.text}` : f.text}
                                </span>
                              );
                            })}
                      </td>
                      <td>{start !== undefined ? `${fmt1(start)}s` : '—'}</td>
                      <td className="bulk-err-cell">{bad ? l.errors.join('；') : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="hint">
              将新增 <strong>{plan.ok ? plan.nodes.length : 0}</strong> 条口令、
              <strong>{plan.ok ? plan.edges.length : 0}</strong> 条约束；
              总工期：{fmt1(plan.currentMakespan)}s →{' '}
              {plan.ok ? `${fmt1(plan.mergedMakespan)}s` : '—'}
              {plan.ok && (
                <>
                  （
                  <Delta value={plan.mergedMakespan - plan.currentMakespan} />
                  ）
                </>
              )}
              ；错误行 {errorLines.length} 行。
            </p>
          </>
        )}

        <div className="replan-actions">
          <button onClick={onClose}>取消预览</button>
          <button
            className="primary"
            disabled={!plan.ok}
            title={plan.ok ? '整批写入当前项目并重算排程' : '存在按行错误或合并后成环，整批不会写入'}
            onClick={() => plan.ok && onConfirm(plan.nodes, plan.edges)}
          >
            确认整批写入
          </button>
        </div>
        <p className="hint">取消预览不保存；确认后沿现有编辑链重算排程并持久化。</p>
      </div>
    </div>
  );
}

function Delta({ value }: { value: number }) {
  if (Math.abs(value) < 1e-9) return <span className="delta-zero">不变</span>;
  return (
    <span className={value > 0 ? 'delta-up' : 'delta-down'}>
      {value > 0 ? '+' : '−'}
      {fmt1(Math.abs(value))}s
    </span>
  );
}

function fmt1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
