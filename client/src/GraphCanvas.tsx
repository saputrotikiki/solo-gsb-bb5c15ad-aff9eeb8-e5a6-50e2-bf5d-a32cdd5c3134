import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandNode, CommandSnippet, CycleInfo, NodeRuntime, Project, ScheduleResult } from './types';

export const NODE_W = 132;
export const NODE_H = 54;

export type Selection = { type: 'node' | 'edge'; id: string };

interface GraphCanvasProps {
  project: Project;
  schedule: ScheduleResult | null;
  cycle?: CycleInfo;
  runtime: Record<string, NodeRuntime>;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddEdge: (from: string, to: string) => void;
  /** 非 null 时进入片段放置模式：节点 / 边不可交互，点击空白处以锚点放置 */
  placingSnippet?: CommandSnippet | null;
  /** 在画布世界坐标 (x, y) 处放置当前片段 */
  onPlaceSnippet?: (x: number, y: number) => void;
  /** 取消放置模式（Esc 等） */
  onCancelPlacing?: () => void;
}

type DragState =
  | { kind: 'node'; id: string; dx: number; dy: number }
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'edge'; from: string; wx: number; wy: number }
  | null;

export function GraphCanvas(props: GraphCanvasProps) {
  const { project, schedule, cycle, runtime, selection } = props;
  const placing = props.placingSnippet ?? null;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  dragRef.current = drag;
  // 放置模式下指针所在的世界坐标（片段根锚点会对齐到该位置）；null 表示尚未定位
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.zoom,
        y: (clientY - rect.top - view.y) / view.zoom,
      };
    },
    [view],
  );

  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  const cycleNodes = new Set(cycle?.nodeIds ?? []);
  const cycleEdges = new Set(cycle?.edgeIds ?? []);
  const backward = schedule?.backward;
  const criticalNodes = new Set(backward?.criticalNodeIds ?? []);
  const criticalEdges = new Set(backward?.criticalEdgeIds ?? []);
  // 启用倒排时节点加高一行，容纳最晚开始与浮动
  const nodeH = backward ? NODE_H + 14 : NODE_H;

  const handleNodePointerDown = (e: React.PointerEvent, n: CommandNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    props.onSelect({ type: 'node', id: n.id });
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ kind: 'node', id: n.id, dx: w.x - n.x, dy: w.y - n.y });
  };

  const handlePortPointerDown = (e: React.PointerEvent, n: CommandNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ kind: 'edge', from: n.id, wx: w.x, wy: w.y });
  };

  const handleBackgroundPointerDown = (e: React.PointerEvent) => {
    if (placing) {
      // 放置模式：拦截画布交互，不开始平移、不改选中，pointerup 时落放
      e.stopPropagation();
      return;
    }
    props.onSelect(null);
    setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y });
  };

  // 放置模式：移动指针更新片段虚影；点击空白处（pointerup）以锚点落放
  const handlePlacingMove = (e: React.PointerEvent) => {
    if (!placing) return;
    const w = toWorld(e.clientX, e.clientY);
    setGhost(w);
  };

  const handlePlacingUp = (e: React.PointerEvent) => {
    if (!placing) return;
    const w = toWorld(e.clientX, e.clientY);
    props.onPlaceSnippet?.(w.x, w.y);
  };

  // Esc 取消放置
  useEffect(() => {
    if (!placing) {
      setGhost(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onCancelPlacing?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing?.id]);

  // 进入放置模式时把虚影先放到视口中心，避免移动指针前虚影缺失
  useEffect(() => {
    if (!placing || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setGhost(toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing?.id]);

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'node') {
      const w = toWorld(e.clientX, e.clientY);
      props.onMoveNode(d.id, Math.round(w.x - d.dx), Math.round(w.y - d.dy));
    } else if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
    } else {
      const w = toWorld(e.clientX, e.clientY);
      setDrag({ ...d, wx: w.x, wy: w.y });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d?.kind === 'edge') {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const nodeEl = el?.closest?.('[data-node-id]');
      const targetId = nodeEl?.getAttribute('data-node-id');
      if (targetId) props.onAddEdge(d.from, targetId);
    }
    setDrag(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const zoom = Math.min(2, Math.max(0.4, v.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      const k = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  const draft = drag?.kind === 'edge' ? drag : null;
  const draftFrom = draft ? nodeById.get(draft.from) : undefined;

  // 放置虚影：以片段根口令为锚点整体平移到 ghost 坐标
  const ghostRoot = placing ? placing.nodes.find((n) => n.id === placing.rootId) : undefined;
  const ghostOffset =
    placing && ghostRoot && ghost ? { dx: ghost.x - ghostRoot.x, dy: ghost.y - ghostRoot.y } : null;

  return (
    <svg
      ref={svgRef}
      className={`graph-canvas ${placing ? 'placing' : ''}`}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={(e) => {
        if (placing) handlePlacingMove(e);
        else handlePointerMove(e);
      }}
      onPointerUp={(e) => {
        if (placing) handlePlacingUp(e);
        else handlePointerUp(e);
      }}
      onWheel={placing ? undefined : handleWheel}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#8b93a7" />
        </marker>
        <marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#ff5d6c" />
        </marker>
        <marker id="arrow-critical" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#ffd166" />
        </marker>
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>
        {project.edges.map((e) => {
          const a = nodeById.get(e.from);
          const b = nodeById.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + nodeH / 2;
          const x2 = b.x;
          const y2 = b.y + nodeH / 2;
          const self = e.from === e.to;
          const isCycle = cycleEdges.has(e.id);
          const isCritical = criticalEdges.has(e.id);
          const isSel = selection?.type === 'edge' && selection.id === e.id;
          const cls = `edge ${isCycle ? 'cycle' : ''} ${isCritical ? 'critical' : ''} ${isSel ? 'selected' : ''}`;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2 - 8;
          const d = self
            ? `M ${x1 - 20} ${y1} C ${x1 + 60} ${y1 - 70}, ${x1 + 90} ${y1 + 40}, ${x1 + 10} ${y1 + 26}`
            : `M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}`;
          const labelX = self ? x1 + 72 : midX;
          const labelY = self ? y1 - 34 : midY;
          const marker = isCycle ? 'arrow-cycle' : isCritical ? 'arrow-critical' : 'arrow';
          return (
            <g key={e.id} className={cls} onPointerDown={(ev) => { ev.stopPropagation(); props.onSelect({ type: 'edge', id: e.id }); }}>
              <path d={d} className="edge-hit" fill="none" />
              <path d={d} className="edge-line" fill="none" markerEnd={`url(#${marker})`} />
              <g className="edge-label" transform={`translate(${labelX},${labelY})`}>
                <rect x={-22} y={-10} width={44} height={18} rx={9} />
                <text textAnchor="middle" dominantBaseline="central">+{e.minDelay}s</text>
              </g>
            </g>
          );
        })}

        {draft && draftFrom && (
          <line
            className="edge-draft"
            x1={draftFrom.x + NODE_W}
            y1={draftFrom.y + nodeH / 2}
            x2={draft.wx}
            y2={draft.wy}
          />
        )}

        {project.nodes.map((n) => {
          const rt = runtime[n.id];
          const status = rt?.status ?? 'pending';
          const isCycle = cycleNodes.has(n.id);
          const isCritical = criticalNodes.has(n.id);
          const isSel = selection?.type === 'node' && selection.id === n.id;
          const startAt = schedule?.starts[n.id];
          const latestAt = backward?.latestStarts[n.id];
          const floatAt = backward?.floats[n.id];
          return (
            <g
              key={n.id}
              data-node-id={n.id}
              className={`node status-${status} ${isCycle ? 'cycle' : ''} ${isCritical ? 'critical' : ''} ${isSel ? 'selected' : ''}`}
              transform={`translate(${n.x},${n.y})`}
              onPointerDown={(e) => handleNodePointerDown(e, n)}
            >
              <rect className="node-body" width={NODE_W} height={nodeH} rx={8} />
              <text className="node-name" x={10} y={21}>{n.name}</text>
              <text className="node-meta" x={10} y={40}>
                时长 {n.duration}s{startAt !== undefined ? ` · 最早 ${round1(startAt)}s` : ''}
              </text>
              {backward && latestAt !== undefined && floatAt !== undefined && (
                <text className={`node-meta ${isCritical ? 'critical' : ''}`} x={10} y={56}>
                  最晚 {round1(latestAt)}s · 浮动 {round1(floatAt)}s
                </text>
              )}
              {status !== 'pending' && (
                <text className="node-badge" x={NODE_W - 10} y={21} textAnchor="end">
                  {status === 'running' ? '执行中' : '已完成'}
                </text>
              )}
              <circle
                className="node-port"
                cx={NODE_W}
                cy={nodeH / 2}
                r={6}
                onPointerDown={(e) => handlePortPointerDown(e, n)}
              />
            </g>
          );
        })}

        {placing && ghostOffset && (
          <g className="snippet-ghost" transform={`translate(${ghostOffset.dx},${ghostOffset.dy})`}>
            {placing.edges.map((e) => {
              const a = placing.nodes.find((n) => n.id === e.from);
              const b = placing.nodes.find((n) => n.id === e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const d = `M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2 - 50} ${y2}, ${x2} ${y2}`;
              return <path key={e.id} d={d} className="snippet-ghost-edge" fill="none" />;
            })}
            {placing.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                <rect
                  className="snippet-ghost-node"
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                />
                <text className="snippet-ghost-name" x={10} y={21}>{n.name}</text>
                <text className="snippet-ghost-meta" x={10} y={40}>时长 {n.duration}s</text>
              </g>
            ))}
          </g>
        )}
      </g>

      {placing && <rect className="placing-overlay" x={0} y={0} width="100%" height="100%" />}
    </svg>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
