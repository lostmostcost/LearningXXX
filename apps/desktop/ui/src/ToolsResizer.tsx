import { useRef } from 'react';
import { clampToolsWidth, TOOLS_MIN_WIDTH } from './layout.ts';

/**
 * WBS-103: the edge between the middle column and the tools column. Dragging
 * it (or the arrow keys while it has focus) sets the tools column's width;
 * a double click goes back to the default width. The pointer is captured so
 * a PDF or preview under the cursor never takes the drag.
 */
export function ToolsResizer({ width, onChange, onReset }: { width: number | undefined; onChange(width: number, done: boolean): void; onReset(): void }) {
  const drag = useRef<{ id: number; right: number; total: number } | undefined>(undefined);
  const area = (el: Element) => el.closest('.panels')?.getBoundingClientRect();
  const current = (el: Element) => width ?? el.parentElement?.getBoundingClientRect().width ?? TOOLS_MIN_WIDTH;
  return <div className="tools-resizer" role="separator" aria-orientation="vertical" aria-label="학습 도구 너비 조절" title="끌어서 너비 조절 · 두 번 누르면 기본 너비"
    aria-valuenow={width === undefined ? undefined : Math.round(width)} aria-valuemin={TOOLS_MIN_WIDTH} tabIndex={0}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const box = area(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, right: box.right, total: box.width };
      document.body.classList.add('resizing-tools');
    }}
    onPointerMove={(event) => {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      onChange(clampToolsWidth(d.right - event.clientX, d.total), false);
    }}
    onPointerUp={(event) => {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      drag.current = undefined;
      document.body.classList.remove('resizing-tools');
      onChange(clampToolsWidth(d.right - event.clientX, d.total), true);
    }}
    onPointerCancel={() => { drag.current = undefined; document.body.classList.remove('resizing-tools'); }}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const box = area(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      const step = event.shiftKey ? 64 : 16;
      onChange(clampToolsWidth(current(event.currentTarget) + (event.key === 'ArrowLeft' ? step : -step), box.width), true);
    }} />;
}
