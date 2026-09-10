import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function clipText(text, width) {
  const plain = stripVTControlCharacters(String(text)).replace(/\s+/g, ' ');
  if (width <= 0) return '';
  if (stringWidth(plain) <= width) return plain;
  let result = '';
  let used = 0;
  for (const { segment } of graphemes.segment(plain)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    result += segment;
    used += size;
  }
  return `${result}…`;
}

// The viewport moves only when the cursor leaves it. Headers and blank lines
// are real rows, so crossing a group never changes the height of the frame.
export class PickerViewport {
  constructor() { this.start = 0; }

  layout(options, cursor, height) {
    const grouped = new Set(options.map(o => o.group)).size > 1;
    const rows = [];
    let previousGroup;
    let focusedRow = 0;
    options.forEach((option, index) => {
      if (grouped && previousGroup !== option.group) {
        if (rows.length) rows.push({ type: 'blank' });
        rows.push({ type: 'group', label: option.group });
      }
      previousGroup = option.group;
      if (index === cursor) focusedRow = rows.length;
      rows.push({ type: 'skill', option, focused: index === cursor });
    });
    const size = Math.max(1, Math.min(height, rows.length));
    this.start = Math.max(0, Math.min(this.start, rows.length - size));
    if (focusedRow < this.start) this.start = focusedRow;
    else if (focusedRow >= this.start + size) this.start = focusedRow - size + 1;
    if (cursor === 0 && focusedRow < size) this.start = 0;
    const visible = rows.slice(this.start, this.start + size);
    return { rows: visible, grouped, above: this.start > 0, below: this.start + size < rows.length };
  }
}
