import { Project } from './types';

export async function loadProject(): Promise<Project> {
  const res = await fetch('/api/project');
  if (!res.ok) throw new Error(`加载失败: HTTP ${res.status}`);
  return (await res.json()) as Project;
}

export async function saveProject(project: Project): Promise<void> {
  const res = await fetch('/api/project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  });
  if (!res.ok) throw new Error(`保存失败: HTTP ${res.status}`);
}
