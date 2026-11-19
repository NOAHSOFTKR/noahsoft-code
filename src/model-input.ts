const FIELDS = ['provider', 'model-group', 'model'] as const;
const EXAMPLE = 'Provider: claude Model-Group: opus Model: 5.5';

export function parseModelInput(input: string): string {
  const value = input.trim();
  if (!/(?:^|\s)(?:provider|model-group|model)\s*:/i.test(value)) return value;
  const parts = new Map<string, string>();
  let remaining = value;
  while (remaining) {
    const match = /^(provider|model-group|model)\s*:\s*([a-z0-9][a-z0-9.-]*)(?:\s+|$)/i.exec(remaining);
    if (!match || parts.has(match[1].toLowerCase())) throw new Error(`모델 입력 형식: /model ${EXAMPLE}`);
    parts.set(match[1].toLowerCase(), match[2].toLowerCase());
    remaining = remaining.slice(match[0].length);
  }
  const [provider, group, version] = FIELDS.map(field => parts.get(field));
  if (provider !== 'claude' || !group || !/^[a-z][a-z0-9-]*$/.test(group) ||
      !version || !/^\d+(?:[.-]\d+)*$/.test(version)) {
    throw new Error(`모델 입력 형식: /model ${EXAMPLE} (이 연결은 Claude 모델을 지원해요.)`);
  }
  return `${provider}-${group}-${version.replaceAll('.', '-')}`;
}

export function modelCompletion(draft: string, ids: readonly string[]): string | undefined {
  if (!/^\/model(?:[ \t]+[^\r\n]*)?$/i.test(draft)) return;
  const prefix = draft.replace(/\s*:\s*/g, ': ').replace(/[ \t]+/g, ' ').toLowerCase();
  const candidates = ['/model Provider: claude Model-Group: '];
  for (const id of ids) {
    candidates.push(`/model ${id}`);
    const model = /^claude-([a-z][a-z0-9-]*?)-(\d+(?:-\d+)*)$/i.exec(id);
    if (model) candidates.push(`/model Provider: claude Model-Group: ${model[1]} Model: ${model[2].replaceAll('-', '.')}`);
  }
  const group = /^\/model provider: claude model-group: ([a-z][a-z0-9-]*) (?:m(?:o(?:d(?:e(?:l(?:: ?)?)?)?)?)?)?$/.exec(prefix);
  if (group) candidates.push(`/model Provider: claude Model-Group: ${group[1]} Model: `);
  return candidates.find(candidate => candidate.toLowerCase().startsWith(prefix) && candidate.toLowerCase() !== prefix);
}
