export interface CommandNode {
  id: string;
  name: string;
  /** 口令执行持续时长（秒） */
  duration: number;
  /** 执行该口令占用的班组人数（非负整数；缺省为 0，兼容旧数据） */
  crew?: number;
  x: number;
  y: number;
}

export interface CommandEdge {
  id: string;
  /** 前置口令 */
  from: string;
  /** 后继口令 */
  to: string;
  /** 前置完成后至少等待的秒数 */
  minDelay: number;
}

/** 开场截止设置（相对排程零点的秒数） */
export interface DeadlineSetting {
  enabled: boolean;
  seconds: number;
}

/** 休息时段：相对排程零点的半开区间 [start, end)（秒），时段内班组容量为零 */
export interface BreakPeriod {
  id: string;
  /** 起点秒数（有限数，≥ 0 且小于终点） */
  start: number;
  /** 终点秒数（有限数，大于起点） */
  end: number;
}

/**
 * 口令片段：以某条口令为根、沿出边可达的全部后继口令构成的子图快照。
 * 节点 / 边 ID 仅在片段内部唯一（放置时会整体重新生成）；
 * 仅收录两个端点都在片段内的边，rootId 必须命中 nodes。
 */
export interface CommandSnippet {
  id: string;
  name: string;
  /** 片段根口令 id（放置时以它为锚点整体平移） */
  rootId: string;
  nodes: CommandNode[];
  edges: CommandEdge[];
}

export interface Project {
  nodes: CommandNode[];
  edges: CommandEdge[];
  /** 开场截止设置；缺省表示未配置（兼容旧数据） */
  deadline?: DeadlineSetting;
  /** 班组总人数（正整数；缺省为 1，兼容旧数据） */
  crewSize?: number;
  /** 休息时段列表；缺省为空（兼容旧数据），仅影响班组排程 */
  breaks?: BreakPeriod[];
  /** 口令片段库；缺省为空（兼容旧数据），随项目持久化 */
  snippets?: CommandSnippet[];
}

export interface CycleInfo {
  /** 成环路径上的节点 id（按环顺序） */
  nodeIds: string[];
  /** 成环路径上的边 id（按环顺序） */
  edgeIds: string[];
}

/** 截止倒排结果：按全部后继约束反向计算的最晚开始与浮动 */
export interface BackwardInfo {
  /** 本次倒排使用的截止秒数 */
  deadline: number;
  /** 每个口令的最晚开始时间（秒） */
  latestStarts: Record<string, number>;
  /** 每个口令的浮动时间（最晚开始 - 最早开始；超期时为负） */
  floats: Record<string, number>;
  /** 关键链上的节点 id（浮动最小，正常排程下即浮动为 0） */
  criticalNodeIds: string[];
  /** 关键链上的约束边 id */
  criticalEdgeIds: string[];
  /** 截止时间早于最短工期时的超期秒数（未超期为 0） */
  overrun: number;
}

export interface ScheduleResult {
  ok: boolean;
  /** 每个口令的最早开始时间（秒，相对排程零点） */
  starts: Record<string, number>;
  /** 全部口令完成的总时长（秒） */
  makespan: number;
  cycle?: CycleInfo;
  /** 启用截止时间且图无环时的倒排结果 */
  backward?: BackwardInfo;
}

/** 班组排程中一条口令的排定结果 */
export interface CrewAssignment {
  nodeId: string;
  /** 排定开始时间（秒，相对排程零点） */
  start: number;
  /** 排定结束时间（秒）；占用按 [start, end) 计算 */
  end: number;
}

/** 班组排程结果：容量约束下的不抢占可行排程 */
export interface CrewScheduleResult {
  ok: boolean;
  /** 按排定先后列出的口令起止 */
  assignments: CrewAssignment[];
  /** 每个口令的排定开始时间（秒） */
  starts: Record<string, number>;
  /** 全部口令完成的总时长（秒） */
  makespan: number;
  /** 交叠或相邻休息时段合并后的半开零容量区间（升序、互不交叠） */
  mergedBreaks: Array<{ start: number; end: number }>;
  cycle?: CycleInfo;
}

/** 现场续排：被锁定的口令（已完成取实际结束，执行中取实际起止） */
export interface ReplanLocked {
  nodeId: string;
  status: 'running' | 'done';
  /** 实际开始时间（秒） */
  start: number;
  /** 实际/预计结束时间（秒） */
  end: number;
}

/** 现场续排结果：锁定口令保持实际记录，为待执行口令给出最早可行新起止 */
export interface ReplanResult {
  ok: boolean;
  /** 被锁定的口令（已完成 / 执行中）及其实际起止 */
  locked: ReplanLocked[];
  /** 待执行口令的新排定起止 */
  assignments: CrewAssignment[];
  /** 全部口令的开始时间（锁定口令为实际开始，待执行为新排定开始） */
  starts: Record<string, number>;
  /** 按新计划全部完成的总时长（秒，相对排程零点） */
  makespan: number;
  /** 交叠或相邻休息时段合并后的半开零容量区间（升序、互不交叠） */
  mergedBreaks: Array<{ start: number; end: number }>;
  cycle?: CycleInfo;
}

export type SimState = 'idle' | 'running' | 'paused' | 'finished';

export type NodeStatus = 'pending' | 'running' | 'done';

export interface NodeRuntime {
  status: NodeStatus;
  /** 实际开始时间（秒） */
  start?: number;
  /** 实际/预计结束时间（秒） */
  end?: number;
}

/**
 * 模拟开始时冻结的本次排程快照：模拟期间的图编辑与现场续排均不改写，
 * 重置模拟时清空；仅用于执行复盘，不写回项目。
 */
export interface ScheduleSnapshot {
  /** 冻结时刻的排程零点（秒，固定为 0） */
  frozenAt: number;
  /** 冻结时全部口令完成的计划总工期（秒） */
  makespan: number;
  /** 冻结时每条口令的计划起止（按当时图结构复制，之后不随编辑变化） */
  entries: SnapshotEntry[];
}

/** 冻结快照中的一条口令计划记录 */
export interface SnapshotEntry {
  nodeId: string;
  name: string;
  /** 冻结时口令的计划时长（秒，计划结束 = 计划开始 + 计划时长） */
  duration: number;
  /** 计划开始时间（秒，相对排程零点） */
  start: number;
  /** 计划结束时间（秒） */
  end: number;
}

/** 执行复盘中单条口令的对比状态 */
export type ReviewStatus = 'on-time' | 'delayed' | 'not-run';

/** 执行复盘中一条口令的计划 / 实际对比行 */
export interface ReviewRow {
  nodeId: string;
  name: string;
  /** 计划开始时间（秒，取自冻结快照） */
  plannedStart: number;
  /** 计划结束时间（秒，取自冻结快照） */
  plannedEnd: number;
  /** 实际开始时间（秒）；未执行为 undefined */
  actualStart?: number;
  /** 实际/预计结束时间（秒）；未执行为 undefined */
  actualEnd?: number;
  /** 开始偏差（实际开始 - 计划开始，秒）；未执行为 undefined */
  startDelta?: number;
  /** 结束偏差（实际结束 - 计划结束，秒）；未执行为 undefined */
  endDelta?: number;
  /** 模拟运行时状态（running 行的实际结束为按当时时长的预计结束） */
  runtimeStatus: NodeStatus;
  /** 复盘状态：按时 / 延迟 / 未执行 */
  status: ReviewStatus;
}

/** 执行复盘结果：各口令对比行（按实际开始时间排序）与总览指标 */
export interface ReviewResult {
  rows: ReviewRow[];
  /** 已完成口令数（runtimeStatus 为 done） */
  completedCount: number;
  /** 已开始口令中的最大开始正偏差（秒；无则为 0） */
  maxDelay: number;
  /** 计划总工期（秒，冻结快照） */
  plannedMakespan: number;
  /** 实际总工期（秒）：已开始口令实际/预计结束的最大值；暂停中为截至当前时刻的值 */
  actualMakespan: number;
  /** 总工期偏差（实际总工期 - 计划总工期，秒） */
  makespanDelta: number;
  /** 生成复盘时的模拟状态 */
  state: SimState;
  /** 生成复盘时的模拟时刻（秒） */
  time: number;
}
