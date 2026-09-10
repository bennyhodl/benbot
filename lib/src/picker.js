import { styleText } from 'node:util';
import stringWidth from 'fast-string-width';
import { MultiSelectPrompt } from '@clack/core';
import { symbol, S_BAR, S_BAR_END, S_CHECKBOX_ACTIVE, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED } from '@clack/prompts';
import { PickerViewport, clipText } from './viewport.js';

export function skillGroup(path) {
  if (!path) return 'Repository root';
  const parent = path.split('/').slice(0, -1);
  if (parent.at(-1) === 'skills') parent.pop();
  return parent.join('/') || 'Skills';
}

export function skillOptions(skills) {
  return [...skills].sort((a, b) => skillGroup(a.path).localeCompare(skillGroup(b.path)) || a.name.localeCompare(b.name))
    .map(skill => ({
      value: skill.path,
      label: skill.name,
      group: skillGroup(skill.path),
      hint: `${skill.path || '(repo root)'}${skill.description ? ` — ${skill.description.slice(0, 100)}` : ''}`,
      disabled: false,
    }));
}

export function renderPicker(prompt, viewport, message, output) {
  // Leave one terminal column free to avoid automatic wrapping at the edge.
  const columns = Math.max(1, (output.columns || 80) - 1);
  const width = Math.max(0, columns - 3);
  const selected = prompt.value || [];
  const heading = [styleText('gray', S_BAR), `${symbol(prompt.state)}  ${clipText(message, width)}`];
  const bar = styleText('cyan', S_BAR);
  if (prompt.state === 'submit' || prompt.state === 'cancel') {
    const names = prompt.options.filter(o => selected.includes(o.value)).map(o => o.label).join(', ');
    return [...heading, `${bar}  ${styleText('dim', clipText(names, width))}`].join('\n');
  }
  // Two heading rows, two scroll indicators, one error row, two footer rows,
  // and two spare terminal rows for Clack's final newline and cursor.
  const view = viewport.layout(prompt.options, prompt.cursor, Math.max(1, (output.rows || 24) - 9));
  const rows = view.rows.map(row => {
    if (row.type === 'blank') return '';
    if (row.type === 'group') return styleText('bold', clipText(row.label, width));
    const { option: item, focused } = row;
    const checked = selected.includes(item.value);
    const indent = view.grouped ? '  ' : '';
    const checkbox = checked ? S_CHECKBOX_SELECTED : focused ? S_CHECKBOX_ACTIVE : S_CHECKBOX_INACTIVE;
    const remaining = Math.max(0, width - stringWidth(`${indent}${checkbox} `));
    const label = clipText(item.label, remaining);
    const labelStyle = item.disabled ? ['dim', 'strikethrough'] : focused ? [] : ['dim'];
    const hint = (focused || checked) && item.hint ? clipText(` (${item.hint})`, remaining - stringWidth(label)) : '';
    return `${indent}${styleText(checked ? 'green' : focused ? 'cyan' : 'dim', checkbox)} ${styleText(labelStyle, label)}${styleText('dim', hint)}`;
  });
  const error = prompt.state === 'error' ? styleText('yellow', clipText(prompt.error, width)) : '';
  const instructions = clipText('↑/↓ navigate · Space select · A toggle all · Enter confirm', width);
  return [
    ...heading,
    `${bar}  ${view.above ? styleText('dim', '…') : ''}`,
    ...rows.map(row => `${bar}  ${row}`),
    `${bar}  ${view.below ? styleText('dim', '…') : ''}`,
    `${bar}  ${error}`,
    `${bar}  ${styleText('dim', instructions)}`,
    styleText('cyan', S_BAR_END),
  ].join('\n');
}

// Headings are display rows, never selectable options. Clack handles all input.
export function skillPicker({ options, message, output = process.stdout }) {
  const viewport = new PickerViewport();
  const prompt = new MultiSelectPrompt({
    options, output, required: true,
    validate: values => !values?.length ? 'Please select at least one skill.' : undefined,
    render() { return renderPicker(this, viewport, message(), output); },
  });
  const selection = prompt.prompt();
  selection.refresh = () => {
    const focused = options[prompt.cursor]?.value;
    options.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
    prompt.cursor = Math.max(0, options.findIndex(item => item.value === focused));
    output.emit('resize');
  };
  return selection;
}
