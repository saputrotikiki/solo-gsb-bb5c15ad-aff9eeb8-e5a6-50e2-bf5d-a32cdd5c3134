import { planBulkImport } from './bulkImport';
import type { Project } from './types';

const project: Project = {
  nodes: [
    { id: 'n1', name: '现有甲', duration: 3, crew: 1, x: 0, y: 0 },
    { id: 'n2', name: '现有乙', duration: 2, crew: 0, x: 0, y: 0 },
  ],
  edges: [{ id: 'e1', from: 'n1', to: 'n2', minDelay: 0 }],
  crewSize: 2,
};

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`, extra ?? '');
  }
}

// 1. 基本成功：引用后面的行 + 引用现有 ID（2→3→1 链，含前向引用）
{
  const text = `
# 注释行
1 新甲 5 1 2:1
2 新乙 4 0 3:0 n1:2
3 新丙 2 2 n2:0
`;
  const p = planBulkImport(text, project);
  check('case1 ok', p.ok, p.lines.map((l) => l.errors));
  check('case1 3 nodes', p.nodes.length === 3);
  check('case1 4 edges', p.edges.length === 4, p.edges);
  check('case1 makespan >= current', p.mergedMakespan >= p.currentMakespan);
  // 新甲前置为新乙（引用第 2 行）
  const jia = p.lines.find((l) => l.lineNo === 1)!;
  const yi = p.lines.find((l) => l.lineNo === 2)!;
  check(
    'case1 line ref resolved',
    jia.prereqs[0].resolvedFrom === yi.newNodeId,
  );
  // 边方向：新乙 -> 新甲，等待 1s
  const e = p.edges.find((e) => e.to === jia.newNodeId);
  check('case1 edge direction', e?.from === yi.newNodeId && e?.minDelay === 1);
  // 新乙还引用现有口令 n1，等待 2s
  const fromN1 = p.edges.find((e) => e.to === yi.newNodeId && e.from === 'n1');
  check('case1 existing-id edge', fromN1?.minDelay === 2);
  // 零时长也生成
  check('case1 short node', p.nodes.some((n) => n.duration === 2 && n.crew === 2));
}

// 2. 引号名称含空格
{
  const text = `1 "灯光 转暗" 2.5 1`;
  const p = planBulkImport(text, project);
  check('case2 ok', p.ok, p.lines[0]?.errors);
  check('case2 name with space', p.nodes[0]?.name === '灯光 转暗');
  check('case2 fractional duration', p.nodes[0]?.duration === 2.5);
}

// 3. 重复行号：两处都报错
{
  const text = `1 甲 1 0\n1 乙 1 0`;
  const p = planBulkImport(text, project);
  check('case3 not ok', !p.ok);
  check('case3 both lines flagged', p.lines.every((l) => l.errors.length > 0), p.lines.map((l) => l.errors));
  check('case3 no nodes', p.nodes.length === 0);
}

// 4. 缺失引用：不存在的行号 + 不存在的 ID
{
  const text = `1 甲 1 0 9:0 no-such-id:1`;
  const p = planBulkImport(text, project);
  check('case4 not ok', !p.ok);
  const errs = p.lines[0].errors.join('；');
  check('case4 missing line', errs.includes('不存在行号 9'), errs);
  check('case4 missing id', errs.includes('no-such-id'), errs);
}

// 5. 数值非法：负数时长、NaN、Infinity、小数用人、超班组、负等待
{
  const text = `1 甲 -1 0\n2 乙 abc 0\n3 丙 3 3\n4 丁 3 1 1:-2\n5 戊 Infinity 0`;
  const p = planBulkImport(text, project);
  check('case5 not ok', !p.ok);
  const byLine = (n: number) => p.lines.find((l) => l.lineNo === n)!.errors.join('；');
  check('case5 neg duration', byLine(1).includes('时长非法'));
  check('case5 nan duration', byLine(2).includes('时长非法'));
  check('case5 crew exceed', byLine(3).includes('超过班组人数 2'), byLine(3));
  check('case5 neg wait', byLine(4).includes('等待秒数非法'));
  check('case5 infinity', byLine(5).includes('时长非法'));
  // 全部行非法时不产生节点
  check('case5 no nodes', p.nodes.length === 0);
}

// 6. 合并后成环：新口令接回新链形成环
{
  // 1 -> 2 -> 3 -> 1
  const text = `1 甲 1 0 3:0\n2 乙 1 0 1:0\n3 丙 1 0 2:0`;
  const p = planBulkImport(text, project);
  check('case6 not ok (cycle)', !p.ok, p.lines.map((l) => l.errors));
  check('case6 cycle flagged per line', p.lines.every((l) => l.errors.some((e) => e.includes('环'))));
  check('case6 no schedule', p.mergedSchedule === undefined);
}

// 7. 引用自身成环
{
  const text = `1 甲 1 0 1:0`;
  const p = planBulkImport(text, project);
  check('case7 self cycle rejected', !p.ok);
  check('case7 self cycle msg', p.lines[0].errors.some((e) => e.includes('环')));
}

// 8. 字段不足 / 行号非正
{
  const text = `0 甲 1 0\n2 乙 1`;
  const p = planBulkImport(text, project);
  check('case8 not ok', !p.ok);
  check('case8 line zero', p.lines[0].errors.join().includes('行号非法'));
  check('case8 too few fields', p.lines[1].errors.join().includes('字段不足'));
}

// 9. 空输入：不可确认但无错误
{
  const p = planBulkImport('  \n# only comment\n', project);
  check('case9 empty not ok', !p.ok);
  check('case9 no lines', p.lines.length === 0);
}

// 10. 等待秒数格式错误（无冒号、空等待）
{
  const text = `1 甲 1 0 n1 2:`;
  const p = planBulkImport(text, project);
  const errs = p.lines[0].errors;
  check('case10 not ok', !p.ok);
  check('case10 bad format', errs.some((e) => e.includes('格式非法')), errs);
  check('case10 empty wait', errs.some((e) => e.includes('等待秒数非法')), errs);
}

// 11. 重复前置
{
  const text = `1 甲 1 0 n1:0 n1:2`;
  const p = planBulkImport(text, project);
  check('case11 dup prereq', !p.ok && p.lines[0].errors.some((e) => e.includes('重复')));
}

// 12. 纯数字引用被当作行号而非 ID（现有 id 为 n1，不会误匹配）
{
  const text = `1 甲 1 0 2:0\n2 乙 1 0`;
  const p = planBulkImport(text, project);
  check('case12 numeric = line ref', p.ok);
}

// 13. 现有图有环：整批拒绝 + 全局错误
{
  const cyclic: Project = {
    nodes: [
      { id: 'a', name: 'A', duration: 1, crew: 0, x: 0, y: 0 },
      { id: 'b', name: 'B', duration: 1, crew: 0, x: 0, y: 0 },
    ],
    edges: [
      { id: 'ea', from: 'a', to: 'b', minDelay: 0 },
      { id: 'eb', from: 'b', to: 'a', minDelay: 0 },
    ],
    crewSize: 1,
  };
  const p = planBulkImport(`1 甲 1 0`, cyclic);
  check('case13 existing cycle rejected', !p.ok);
  check('case13 global error', p.globalErrors.some((e) => e.includes('环依赖')));
}

// 14. 每行都有独立 ID / 边 ID，且不与现有冲突
{
  const text = `1 甲 1 0 n1:0`;
  const p = planBulkImport(text, project);
  const ids = [...p.nodes.map((n) => n.id), ...p.edges.map((e) => e.id)];
  check('case14 unique ids', new Set(ids).size === ids.length);
  check('case14 no clash', ids.every((id) => !new Set([...project.nodes.map((n) => n.id), ...project.edges.map((e) => e.id)]).has(id)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} bulk import checks failed`);
