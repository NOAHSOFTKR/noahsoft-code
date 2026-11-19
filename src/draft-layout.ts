import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter();
type Position = { offset: number; column: number };

export function layoutDraft(text: string, width: number) {
  const rows: { text: string; positions: Position[] }[] = [];
  let row = { text: '', positions: [{ offset: 0, column: 0 }] };
  let column = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    const displayed = segment === '\t' ? ' '.repeat(Math.min(4, width)) : segment;
    const cells = stringWidth(displayed);
    if (segment === '\n' || (column > 0 && column + cells > width)) {
      if (segment !== '\n') row.positions.pop();
      rows.push(row);
      row = { text: '', positions: [{ offset: index + (segment === '\n' ? 1 : 0), column: 0 }] };
      column = 0;
    }
    if (segment === '\n') continue;
    row.text += displayed;
    column += cells;
    row.positions.push({ offset: index + segment.length, column });
  }
  rows.push(row);
  return rows;
}
