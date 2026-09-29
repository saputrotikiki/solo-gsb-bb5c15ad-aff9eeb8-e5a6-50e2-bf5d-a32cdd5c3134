import { useMemo, useState } from 'react';
import { CommandSnippet, Project } from './types';
import { Selection } from './GraphCanvas';
import { reachableSubgraph } from './snippets';

interface SnippetPanelProps {
  project: Project;
  selection: Selection | null;
  /** 当前处于放置模式的片段 id */
  placingSnippetId: string | null;
  onSaveSnippet: (rootId: string, name: string) => void;
  onDeleteSnippet: (id: string) => void;
  onSelectForPlacing: (id: string) => void;
}

/**
 * 口令片段库（画布左上角浮动面板）：
 * - 选中口令后可把它及沿出边可达的全部后继口令保存为命名片段，
 *   保存前预览将收录的节点数与（片段内部）边数；
 * - 片段随项目持久化，可删除；
 * - 选中片段即进入放置模式，随后在画布空白处点击放置。
 */
export function SnippetPanel(props: SnippetPanelProps) {
  const { project, selection } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');

  const snippets = project.snippets ?? [];
  const selectedNode =
    selection?.type === 'node'
      ? project.nodes.find((n) => n.id === selection.id)
      : undefined;

  // 保存预览：从选中口令沿出边可达的节点数与片段内部边数
  const preview = useMemo(
    () => (selectedNode ? reachableSubgraph(project, selectedNode.id) : null),
    [project, selectedNode],
  );

  const trimmed = name.trim();
  const canSave = !!selectedNode && !!preview && preview.nodeIds.length > 0 && trimmed !== '';

  const confirmSave = () => {
    if (!canSave || !selectedNode) return;
    props.onSaveSnippet(selectedNode.id, trimmed);
    setName('');
    setSaving(false);
  };

  return (
    <div className={`snippet-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="snippet-head" onClick={() => setCollapsed((v) => !v)}>
        <span className="snippet-title">🧩 口令片段库</span>
        <span className="snippet-count">{snippets.length}</span>
        <button
          className="snippet-collapse"
          title={collapsed ? '展开' : '收起'}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((v) => !v);
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && (
        <div className="snippet-body">
          {saving && selectedNode && preview ? (
            <div className="snippet-create">
              <p className="snippet-preview">
                根口令：<strong>{selectedNode.name}</strong>
                <br />
                将收录 {preview.nodeIds.length} 条口令、{preview.edges.length} 条内部约束
              </p>
              <input
                autoFocus
                placeholder="片段名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmSave();
                  if (e.key === 'Escape') {
                    setSaving(false);
                    setName('');
                  }
                }}
              />
              <div className="snippet-create-actions">
                <button className="primary" disabled={!canSave} onClick={confirmSave}>
                  保存片段
                </button>
                <button
                  onClick={() => {
                    setSaving(false);
                    setName('');
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              className="snippet-add"
              disabled={!selectedNode}
              title={selectedNode ? '把选中口令及其全部后继口令保存为片段' : '请先在画布上选中一条口令'}
              onClick={() => {
                setName(selectedNode ? `${selectedNode.name}片段` : '');
                setSaving(true);
              }}
            >
              ＋ 从选中口令保存片段
            </button>
          )}
          {!saving && !selectedNode && (
            <p className="snippet-hint">选中一条口令后，可将它及全部后继口令保存为片段。</p>
          )}
          {!saving && selectedNode && preview && (
            <p className="snippet-hint">
              预览：{preview.nodeIds.length} 条口令、{preview.edges.length} 条内部约束（仅收录片段内部的边）。
            </p>
          )}

          {snippets.length > 0 && (
            <ul className="snippet-list">
              {snippets.map((s) => (
                <SnippetItem
                  key={s.id}
                  snippet={s}
                  active={props.placingSnippetId === s.id}
                  onPlace={() => props.onSelectForPlacing(s.id)}
                  onDelete={() => props.onDeleteSnippet(s.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SnippetItem(props: {
  snippet: CommandSnippet;
  active: boolean;
  onPlace: () => void;
  onDelete: () => void;
}) {
  const { snippet, active } = props;
  return (
    <li className={`snippet-item ${active ? 'active' : ''}`}>
      <button
        className="snippet-pick"
        title={active ? '取消放置' : '选中后点击画布空白处放置'}
        onClick={props.onPlace}
      >
        <span className="snippet-name">{snippet.name}</span>
        <span className="snippet-meta">
          {snippet.nodes.length} 节点 · {snippet.edges.length} 边
        </span>
      </button>
      <button className="snippet-del" title="删除片段（不影响画布）" onClick={props.onDelete}>
        删除
      </button>
    </li>
  );
}
