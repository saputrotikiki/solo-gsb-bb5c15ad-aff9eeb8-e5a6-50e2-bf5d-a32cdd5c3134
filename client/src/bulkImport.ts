import { CommandEdge, CommandNode, Project } from './types';
import { computeSchedule } from './schedule';

/**
 * 多行口令批量导入。
 *
 * 每行（空行与以 # 开头的注释行除外）：
 *   行号 名称 时长(秒) 用人数 [前置:最少等待秒数 ...]
 * - 行号：本批内唯一的正整数；允许引用后面的行；
 * - 名称：不含空格的单个记号，或用英文双引号包裹的任意文本（""内可含空格）；
 * - 时长 / 等待秒数：有限非负数；用人数：不超过班组人数的非负整数；
 * - 前置引用：纯数字引用本批行号（如 2），其余按现有口令 ID 精确匹配；
 *   形如 引用:等待秒数，等待秒数为有限非负数。
 *
 * 在合并后的图（现有口令 + 本批口令、两类前置边）上做引用解析与成环检测；
 * 任何一行非法或合并后成环，plan.ok 均为 false 且整批不应写入。
 * 确认前即为每条新口令与每条新约束分配好 ID。
 */

/** 一条前置引用的解析结果 */
export interface ParsedPrereq {
  /** 原始记号，如 "2:5" / "n-curtain-down:0" */
  raw: string;
  /** 引用部分（冒号前），如 "2" / "n-curtain-down" */
  ref: string;
  /** 等待秒数（冒号后） */
  wait: number;
  /** 解析到的前置节点 id（本批新 id 或现有口令 id）；未解析为 undefined */
  resolvedFrom?: string;
  /** 引用的本批行号（纯数字引用时） */
  lineRef?: number;
  /** 是否引用本批行号（含引用了不存在的行号） */
  isLineRef: boolean;
}

/** 一行清单的解析结果 */
export interface ParsedLine {
  /** 在粘贴文本中的物理行号（从 1 开始，用于按行报错） */
  sourceLine: number;
  /** 原始文本（去首尾空白后） */
  raw: string;
  /** 声明的本批行号 */
  lineNo?: number;
  name?: string;
  duration?: number;
  crew?: number;
  prereqs: ParsedPrereq[];
  /** 确认前预先分配的新口令 id */
  newNodeId?: string;
  /** 该行的错误原因（可多条） */
  errors: string[];
}

/** 一次批量导入的完整试算结果 */
export interface BulkImportPlan {
  lines: ParsedLine[];
  /** 无任何错误（含合并后无环）时为 true */
  ok: boolean;
  /** 本批有效行数（不含空行 / 注释行） */
  lineCount: number;
  /** 将新增的口令（已分配 ID 与坐标，保留名称 / 时长 / 用人数） */
  nodes: CommandNode[];
  /** 将新增的约束（两类前置均已连接到具体节点 id，已分配边 ID） */
  edges: CommandEdge[];
  /** 合并后图的最早排程（ok 时存在） */
  mergedSchedule?: ReturnType<typeof computeSchedule>;
  /** 合并前现有图的总工期（秒） */
  currentMakespan: number;
  /** 合并后总工期（秒，环时为 0） */
  mergedMakespan: number;
  /** 不属于任何具体行的整体性错误（如现有图已存在环） */
  globalErrors: string[];
  /** 合并后成环的路径（透传 schedule.cycle） */
  cycle?: import('./types').CycleInfo;
}

const NUM_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** 有限非负数（拒绝 NaN / Infinity / 负数）；无法解析返回 undefined */
function parseNonNeg(s: string): number | undefined {
  if (!NUM_RE.test(s)) return undefined;
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v;
}

/**
 * 把一行按空白拆成记号，支持英文双引号包裹的名称（第二个记号）内含空格。
 * 形如：1 "灯光 转暗" 3 0 → ["1", "灯光 转暗", "3", "0"]
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[0]);
  }
  return tokens;
}

/**
 * 解析多行清单并在合并图上试算。纯函数：不修改 project，不写任何状态；
 * 每次调用都会重新分配 ID，因此调用方应在确认时使用同一份 plan 中的节点 / 边。
 */
export function planBulkImport(text: string, project: Project): BulkImportPlan {
  const capacity =
    typeof project.crewSize === 'number' &&
    Number.isInteger(project.crewSize) &&
    project.crewSize >= 1
      ? project.crewSize
      : 1;
  const existingIds = new Set(project.nodes.map((n) => n.id));

  const lines: ParsedLine[] = [];
  let lineCount = 0;

  text.split(/\r?\n/).forEach((rawText, idx) => {
    const sourceLine = idx + 1;
    const raw = rawText.trim();
    if (raw === '' || raw.startsWith('#')) return; // 空行 / 注释行跳过
    lineCount++;

    const line: ParsedLine = { sourceLine, raw, prereqs: [], errors: [] };
    const tokens = tokenize(raw);
    if (tokens.length < 4) {
      line.errors.push(
        `字段不足：应为「行号 名称 时长 用人数 [前置:等待秒数 …]」，实得 ${tokens.length} 个字段`,
      );
    }

    // 行号：正整数（重复检测在全部行解析完后统一进行）
    const lineNoTok = tokens[0];
    if (lineNoTok !== undefined) {
      if (!/^\d+$/.test(lineNoTok) || Number(lineNoTok) < 1) {
        line.errors.push(`行号非法：「${lineNoTok}」须为正整数`);
      } else {
        line.lineNo = Number(lineNoTok);
      }
    }

    // 名称：非空
    const nameTok = tokens[1];
    if (nameTok !== undefined) {
      if (nameTok === '') line.errors.push('名称不能为空（引号内无内容）');
      else line.name = nameTok;
    }

    // 时长：有限非负数
    const durTok = tokens[2];
    if (durTok !== undefined) {
      const d = parseNonNeg(durTok);
      if (d === undefined) line.errors.push(`时长非法：「${durTok}」须为有限非负数`);
      else line.duration = d;
    }

    // 用人数：非负整数且不超过班组人数
    const crewTok = tokens[3];
    if (crewTok !== undefined) {
      if (!/^\d+$/.test(crewTok)) {
        line.errors.push(`用人数非法：「${crewTok}」须为非负整数`);
      } else {
        const c = Number(crewTok);
        if (c > capacity) line.errors.push(`用人数非法：${c} 超过班组人数 ${capacity}`);
        else line.crew = c;
      }
    }

    // 前置引用：引用:等待秒数（第 5 个字段起，可多个）
    const seenRefs = new Set<string>();
    for (const tok of tokens.slice(4)) {
      const p: ParsedPrereq = { raw: tok, ref: '', wait: 0, isLineRef: false };
      const cut = tok.lastIndexOf(':');
      if (cut <= 0) {
        // 无冒号或以冒号开头：引用为空或缺少 引用:等待秒数 结构
        line.errors.push(`前置「${tok}」格式非法：应为 引用:等待秒数`);
      } else {
        const ref = tok.slice(0, cut);
        const waitTok = tok.slice(cut + 1);
        p.ref = ref;
        const w = parseNonNeg(waitTok);
        if (w === undefined) {
          line.errors.push(`前置「${tok}」的等待秒数非法：「${waitTok}」须为有限非负数`);
        } else {
          p.wait = w;
        }
        if (/^\d+$/.test(ref)) {
          p.isLineRef = true;
          p.lineRef = Number(ref);
        }
        if (seenRefs.has(ref)) line.errors.push(`前置引用「${ref}」在本行重复`);
        else seenRefs.add(ref);
      }
      line.prereqs.push(p);
    }

    lines.push(line);
  });

  // 统一进行重复行号检测：同一行号的每个出现行都标注，首次出现行给出其他位置
  const occurrences = new Map<number, ParsedLine[]>();
  for (const line of lines) {
    if (line.lineNo === undefined) continue;
    const arr = occurrences.get(line.lineNo) ?? [];
    arr.push(line);
    occurrences.set(line.lineNo, arr);
  }
  for (const [no, arr] of occurrences) {
    if (arr.length < 2) continue;
    const firstAt = arr[0].sourceLine;
    arr.forEach((line, i) => {
      const others = arr
        .map((l) => l.sourceLine)
        .filter((n) => n !== line.sourceLine)
        .join('、');
      line.errors.push(
        i === 0
          ? `行号 ${no} 重复（另见于第 ${others} 行）`
          : `行号 ${no} 重复（首次出现于第 ${firstAt} 行）`,
      );
    });
  }

  // 行号唯一且核心字段齐备的行才分配新 ID、进入行号映射并可被引用
  const uniqueLineByNo = new Map<number, ParsedLine>();
  for (const line of lines) {
    if (
      line.lineNo !== undefined &&
      line.errors.length === 0 &&
      line.name !== undefined &&
      line.duration !== undefined &&
      line.crew !== undefined
    ) {
      line.newNodeId = crypto.randomUUID();
      uniqueLineByNo.set(line.lineNo, line);
    }
  }

  // 引用解析：本批行号 -> 新 id；其余必须命中现有口令 ID（允许引用后面的行）
  for (const line of lines) {
    for (const p of line.prereqs) {
      if (p.ref === '') continue;
      if (p.isLineRef) {
        const target = uniqueLineByNo.get(p.lineRef!);
        if (!target) {
          line.errors.push(
            `前置引用缺失：本批不存在行号 ${p.lineRef}（或该行号重复 / 该行非法）`,
          );
          continue;
        }
        p.resolvedFrom = target.newNodeId;
      } else if (existingIds.has(p.ref)) {
        p.resolvedFrom = p.ref;
      } else {
        line.errors.push(`前置引用缺失：现有口令中不存在 ID「${p.ref}」`);
      }
    }
  }

  const globalErrors: string[] = [];

  // 现有图自身的排程（其总工期用于对比；现有图有环时整批拒绝）
  const current = computeSchedule(project);
  let currentMakespan = 0;
  if (!current.ok) {
    globalErrors.push('当前项目的口令图已存在环依赖，请先解除后再批量导入。');
  } else {
    currentMakespan = current.makespan;
  }

  // 组装将写入的节点 / 边（只收录自身无错误的行，按行号顺序）
  const usable = lines.filter(
    (l) =>
      l.errors.length === 0 &&
      l.newNodeId !== undefined &&
      l.name !== undefined &&
      l.duration !== undefined &&
      l.crew !== undefined,
  );
  const usableIds = new Set(usable.map((l) => l.newNodeId!));

  // 新节点放在现有节点下方，按本批行号顺序网格排列
  const baseX = 60;
  const maxY = project.nodes.reduce((m, n) => Math.max(m, n.y), 80);
  const originY = maxY + 140;
  const COL_W = 150;
  const ROW_H = 110;
  const COLS = 8;
  const nodes: CommandNode[] = usable
    .slice()
    .sort((a, b) => a.lineNo! - b.lineNo!)
    .map((l, i) => ({
      id: l.newNodeId!,
      name: l.name!,
      duration: l.duration!,
      crew: l.crew!,
      x: baseX + (i % COLS) * COL_W,
      y: originY + Math.floor(i / COLS) * ROW_H,
    }));

  const edges: CommandEdge[] = [];
  for (const l of usable) {
    for (const p of l.prereqs) {
      const from = p.resolvedFrom;
      // 现有口令 -> 新口令、新口令 -> 新口令两类前置在此连接
      if (!from || !(existingIds.has(from) || usableIds.has(from))) continue;
      edges.push({ id: crypto.randomUUID(), from, to: l.newNodeId!, minDelay: p.wait });
    }
  }

  // 合并图试算排程与成环检测
  let mergedSchedule: BulkImportPlan['mergedSchedule'];
  let mergedMakespan = 0;
  const anyLineError = lines.some((l) => l.errors.length > 0);
  if (!anyLineError && current.ok) {
    const merged: Project = {
      ...project,
      nodes: [...project.nodes, ...nodes],
      edges: [...project.edges, ...edges],
    };
    mergedSchedule = computeSchedule(merged);
    if (!mergedSchedule.ok) {
      // 合并后成环：把环上属于本批的行按行指出
      const cycleNodeIds = new Set(mergedSchedule.cycle?.nodeIds ?? []);
      const onCycle = usable.filter((l) => cycleNodeIds.has(l.newNodeId!));
      for (const l of onCycle) {
        l.errors.push('合并后形成环依赖：该口令位于成环路径上');
      }
      if (onCycle.length === 0) {
        globalErrors.push('合并后形成环依赖（成环路径均为现有口令，请检查引用方向）。');
      }
    } else {
      mergedMakespan = mergedSchedule.makespan;
    }
  }

  const ok =
    lineCount > 0 &&
    current.ok &&
    !anyLineError &&
    !!mergedSchedule?.ok &&
    globalErrors.length === 0;

  return {
    lines,
    ok,
    lineCount,
    nodes,
    edges,
    mergedSchedule: mergedSchedule?.ok ? mergedSchedule : undefined,
    mergedMakespan: ok ? mergedMakespan : 0,
    currentMakespan,
    globalErrors,
    cycle: !current.ok
      ? current.cycle
      : mergedSchedule && !mergedSchedule.ok
        ? mergedSchedule.cycle
        : undefined,
  };
}
