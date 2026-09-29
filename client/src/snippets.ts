import { CommandEdge, CommandNode, CommandSnippet, Project } from './types';

export interface ReachableSubgraph {
  /** 从根沿出边可达的全部节点 id（含根） */
  nodeIds: string[];
  /** 两个端点都在可达集合内的边（即片段内部的边） */
  edges: CommandEdge[];
}

/**
 * 收集从 rootId 沿出边可达的全部口令，以及两端都在该集合内的边。
 * 存在环依赖时 visited 集合仍能保证终止并给出全部可达节点。
 */
export function reachableSubgraph(project: Project, rootId: string): ReachableSubgraph {
  const outgoing = new Map<string, string[]>();
  for (const n of project.nodes) outgoing.set(n.id, []);
  for (const e of project.edges) {
    if (outgoing.has(e.from)) outgoing.get(e.from)!.push(e.to);
  }
  if (!outgoing.has(rootId)) return { nodeIds: [], edges: [] };

  const visited = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const to of outgoing.get(id) ?? []) {
      if (!visited.has(to)) stack.push(to);
    }
  }

  // 保持项目内的原有顺序，便于预览与存储稳定
  const nodeIds = project.nodes.map((n) => n.id).filter((id) => visited.has(id));
  const edges = project.edges.filter((e) => visited.has(e.from) && visited.has(e.to));
  return { nodeIds, edges };
}

/**
 * 以 rootId 为根，把它及沿出边可达的全部后继口令保存为命名片段快照。
 * 仅收录片段内部的边；节点 / 边做深拷贝并生成新的片段内 ID，
 * 之后修改原图不影响片段。
 */
export function buildSnippet(project: Project, rootId: string, name: string): CommandSnippet | null {
  const { nodeIds, edges } = reachableSubgraph(project, rootId);
  if (nodeIds.length === 0) return null;

  const nodeIdMap = new Map<string, string>();
  for (const id of nodeIds) nodeIdMap.set(id, crypto.randomUUID());

  // 快照节点：片段内重新分配 ID，保留名称、时长、用人数与相对坐标
  const nodes: CommandNode[] = project.nodes
    .filter((n) => nodeIdMap.has(n.id))
    .map((n) => ({
      id: nodeIdMap.get(n.id)!,
      name: n.name,
      duration: n.duration,
      crew: n.crew ?? 0,
      x: n.x,
      y: n.y,
    }));

  // 仅收录片段内部的边，端点重映射到片段内新 ID
  const snippetEdges: CommandEdge[] = edges.map((e) => ({
    id: crypto.randomUUID(),
    from: nodeIdMap.get(e.from)!,
    to: nodeIdMap.get(e.to)!,
    minDelay: e.minDelay,
  }));

  return {
    id: crypto.randomUUID(),
    name,
    rootId: nodeIdMap.get(rootId)!,
    nodes,
    edges: snippetEdges,
  };
}

export interface PlacedSnippet {
  nodes: CommandNode[];
  edges: CommandEdge[];
  /** 放置后对应原片段根口令的新节点（默认选中用） */
  rootNodeId: string;
}

/**
 * 在画布坐标 (x, y) 处放置片段副本：以原根口令为锚点整体平移，
 * 为全部复制节点与边生成新 ID 并重映射端点；
 * 保留名称、时长、用人数与等待秒数，不自动连接原图。
 * 用人数按当前班组容量兜底（容量下调后片段中超出的值被压减）。
 */
export function instantiateSnippet(
  snippet: CommandSnippet,
  x: number,
  y: number,
  crewSize: number,
): PlacedSnippet | null {
  const root = snippet.nodes.find((n) => n.id === snippet.rootId);
  if (!root) return null;
  const dx = x - root.x;
  const dy = y - root.y;

  const idMap = new Map<string, string>();
  for (const n of snippet.nodes) idMap.set(n.id, crypto.randomUUID());

  const capacity = Number.isInteger(crewSize) && crewSize >= 1 ? crewSize : 1;
  const nodes: CommandNode[] = snippet.nodes.map((n) => {
    const crew = Math.max(0, Math.min(n.crew ?? 0, capacity));
    return {
      id: idMap.get(n.id)!,
      name: n.name,
      duration: n.duration,
      crew,
      x: n.x + dx,
      y: n.y + dy,
    };
  });

  // 仅复制片段内部的边，端点重映射到新节点
  const edges: CommandEdge[] = snippet.edges
    .filter((e) => idMap.has(e.from) && idMap.has(e.to))
    .map((e) => ({
      id: crypto.randomUUID(),
      from: idMap.get(e.from)!,
      to: idMap.get(e.to)!,
      minDelay: e.minDelay,
    }));

  return { nodes, edges, rootNodeId: idMap.get(snippet.rootId)! };
}
