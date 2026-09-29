import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

interface CommandNode {
  id: string;
  name: string;
  duration: number;
  /** 执行该口令占用的班组人数（非负整数；可选，缺省为 0，兼容旧数据） */
  crew?: number;
  x: number;
  y: number;
}

interface CommandEdge {
  id: string;
  from: string;
  to: string;
  minDelay: number;
}

/** 休息时段：相对排程零点的半开区间 [start, end)（秒），班组容量视为零 */
interface BreakPeriod {
  id: string;
  start: number;
  end: number;
}

/**
 * 口令片段：以某条口令为根、沿出边可达的全部后继口令构成的子图快照。
 * 节点 / 边 ID 仅在片段内部唯一；放置时整体重新生成，故不与主图 ID 冲突。
 */
interface CommandSnippet {
  id: string;
  name: string;
  rootId: string;
  nodes: CommandNode[];
  edges: CommandEdge[];
}

interface Project {
  nodes: CommandNode[];
  edges: CommandEdge[];
  /** 开场截止设置（可选，兼容旧数据） */
  deadline?: { enabled: boolean; seconds: number };
  /** 班组总人数（正整数；可选，缺省为 1，兼容旧数据） */
  crewSize?: number;
  /** 休息时段列表（可选，缺省为空，兼容旧数据；仅影响班组排程） */
  breaks?: BreakPeriod[];
  /** 口令片段库（可选，缺省为空，兼容旧数据） */
  snippets?: CommandSnippet[];
}

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'project.json');
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '..', '..', 'client', 'dist');

/** 首次启动时的示例口令图（舞台换景流程）。 */
function seedProject(): Project {
  const node = (id: string, name: string, duration: number, crew: number, x: number, y: number): CommandNode =>
    ({ id, name, duration, crew, x, y });
  const edge = (id: string, from: string, to: string, minDelay: number): CommandEdge =>
    ({ id, from, to, minDelay });
  return {
    nodes: [
      node('n-curtain-down', '幕布落下', 3, 1, 60, 220),
      node('n-lights-dim', '灯光转暗', 2, 1, 60, 340),
      node('n-set-a-out', '布景A撤场', 8, 2, 300, 160),
      node('n-props-ready', '道具就位', 5, 1, 300, 340),
      node('n-set-b-in', '布景B上场', 10, 2, 540, 160),
      node('n-actors-ready', '演员就位', 4, 1, 540, 340),
      node('n-curtain-up', '幕布升起', 3, 1, 780, 240),
      node('n-lights-up', '灯光亮起', 2, 1, 780, 360),
    ],
    edges: [
      edge('e1', 'n-curtain-down', 'n-set-a-out', 1),
      edge('e2', 'n-curtain-down', 'n-props-ready', 0),
      edge('e3', 'n-lights-dim', 'n-set-a-out', 2),
      edge('e4', 'n-set-a-out', 'n-set-b-in', 2),
      edge('e5', 'n-set-b-in', 'n-actors-ready', 0),
      edge('e6', 'n-props-ready', 'n-actors-ready', 1),
      edge('e7', 'n-actors-ready', 'n-curtain-up', 1),
      edge('e8', 'n-curtain-up', 'n-lights-up', 0),
    ],
    // 示例流程最短工期为 34s，默认给出该值便于启用后直接看到关键链
    deadline: { enabled: false, seconds: 34 },
    // 示例班组 2 人：撤场/上场占满班组时会与并行口令错开
    crewSize: 2,
    // 示例休息时段（半开区间，容量为 0，仅作用于班组排程；最早排程与模拟不受影响）
    breaks: [{ id: 'b-tea', start: 12, end: 18 }],
  };
}

function isValidProject(p: unknown): p is Project {
  if (typeof p !== 'object' || p === null) return false;
  const proj = p as Project;
  if (!Array.isArray(proj.nodes) || !Array.isArray(proj.edges)) return false;
  // 班组人数：可选，必须为正整数（缺省按 1 处理，兼容旧数据）
  if (proj.crewSize !== undefined) {
    if (typeof proj.crewSize !== 'number' || !Number.isInteger(proj.crewSize) || proj.crewSize < 1) {
      return false;
    }
  }
  const capacity = proj.crewSize ?? 1;
  const ids = new Set<string>();
  for (const n of proj.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.name !== 'string') return false;
    if (typeof n.duration !== 'number' || !isFinite(n.duration) || n.duration < 0) return false;
    if (typeof n.x !== 'number' || typeof n.y !== 'number') return false;
    // 用人数：可选，必须为不超过班组人数的非负整数（缺省按 0 处理）
    if (n.crew !== undefined) {
      if (typeof n.crew !== 'number' || !Number.isInteger(n.crew) || n.crew < 0) return false;
      if (n.crew > capacity) return false;
    }
    if (ids.has(n.id)) return false;
    ids.add(n.id);
  }
  for (const e of proj.edges) {
    if (!e || typeof e.id !== 'string') return false;
    if (!ids.has(e.from) || !ids.has(e.to)) return false;
    if (typeof e.minDelay !== 'number' || !isFinite(e.minDelay) || e.minDelay < 0) return false;
  }
  if (proj.deadline !== undefined) {
    const d = proj.deadline;
    if (typeof d !== 'object' || d === null) return false;
    if (typeof d.enabled !== 'boolean') return false;
    if (typeof d.seconds !== 'number' || !isFinite(d.seconds) || d.seconds < 0) return false;
  }
  // 休息时段：可选，缺省为空（兼容旧数据）；
  // 每条两端必须为有限数且 0 ≤ 起点 < 终点，id 非空且不重复
  if (proj.breaks !== undefined) {
    if (!Array.isArray(proj.breaks)) return false;
    const breakIds = new Set<string>();
    for (const b of proj.breaks) {
      if (!b || typeof b.id !== 'string' || b.id === '') return false;
      if (typeof b.start !== 'number' || !isFinite(b.start) || b.start < 0) return false;
      if (typeof b.end !== 'number' || !isFinite(b.end) || b.start >= b.end) return false;
      if (breakIds.has(b.id)) return false;
      breakIds.add(b.id);
    }
  }
  // 口令片段库：可选，缺省为空（兼容旧数据）。
  // 片段 id 在库内唯一；片段内节点 / 边 id 在片段内唯一（与主图不冲突，放置时整体重新生成）；
  // 根口令必须命中片段节点；边的两个端点都必须在片段内。
  if (proj.snippets !== undefined) {
    if (!Array.isArray(proj.snippets)) return false;
    const snippetIds = new Set<string>();
    for (const s of proj.snippets) {
      if (!s || typeof s.id !== 'string' || s.id === '') return false;
      if (snippetIds.has(s.id)) return false;
      snippetIds.add(s.id);
      if (typeof s.name !== 'string' || s.name === '') return false;
      if (typeof s.rootId !== 'string' || s.rootId === '') return false;
      if (!Array.isArray(s.nodes) || !Array.isArray(s.edges)) return false;

      const nodeIds = new Set<string>();
      for (const n of s.nodes) {
        if (!n || typeof n.id !== 'string' || n.id === '') return false;
        if (typeof n.name !== 'string' || n.name === '') return false;
        if (typeof n.duration !== 'number' || !isFinite(n.duration) || n.duration < 0) return false;
        if (typeof n.x !== 'number' || !Number.isFinite(n.x)) return false;
        if (typeof n.y !== 'number' || !Number.isFinite(n.y)) return false;
        // 用人数：可选非负整数；不按当前班组容量校验（放置时按当时容量兜底）
        if (n.crew !== undefined) {
          if (typeof n.crew !== 'number' || !Number.isInteger(n.crew) || n.crew < 0) return false;
        }
        if (nodeIds.has(n.id)) return false;
        nodeIds.add(n.id);
      }
      if (!nodeIds.has(s.rootId)) return false;

      const edgeIds = new Set<string>();
      for (const e of s.edges) {
        if (!e || typeof e.id !== 'string' || e.id === '') return false;
        if (edgeIds.has(e.id)) return false;
        edgeIds.add(e.id);
        if (typeof e.from !== 'string' || typeof e.to !== 'string') return false;
        if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) return false;
        if (typeof e.minDelay !== 'number' || !isFinite(e.minDelay) || e.minDelay < 0) return false;
      }
    }
  }
  return true;
}

function ensureDataFile(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(seedProject(), null, 2), 'utf-8');
    console.log(`[server] seeded sample project at ${DATA_FILE}`);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/project', (_req: Request, res: Response) => {
  fs.readFile(DATA_FILE, 'utf-8', (err, data) => {
    if (err) {
      console.error('[server] read failed:', err.message);
      res.status(500).json({ error: 'failed to read project' });
      return;
    }
    res.type('application/json').send(data);
  });
});

app.put('/api/project', (req: Request, res: Response) => {
  if (!isValidProject(req.body)) {
    res.status(400).json({ error: 'invalid project payload' });
    return;
  }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(req.body, null, 2), 'utf-8', (err) => {
    if (err) {
      console.error('[server] write failed:', err.message);
      res.status(500).json({ error: 'failed to save project' });
      return;
    }
    fs.rename(tmp, DATA_FILE, (renameErr) => {
      if (renameErr) {
        console.error('[server] rename failed:', renameErr.message);
        res.status(500).json({ error: 'failed to save project' });
        return;
      }
      res.json({ ok: true, savedAt: new Date().toISOString() });
    });
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// 静态托管前端构建产物，其余路径回退到 index.html（SPA）。
app.use(express.static(CLIENT_DIST));
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('client not built');
    }
  });
});

ensureDataFile();
app.listen(PORT, () => {
  console.log(`[server] stage command sandbox listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] data file: ${DATA_FILE}`);
});
