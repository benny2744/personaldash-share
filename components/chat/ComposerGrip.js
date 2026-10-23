'use client';

import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT } from '@/lib/hermes/panelState';

/**
 * Drag grip on a bottom-docked composer's top edge, shared by the Hermes and
 * DingTalk composers. Drag up/down to set a manual composer height; a saved
 * height applies to both. Double-click resets to auto-grow. Same
 * window-mousemove drag pattern as the ChatWorkspace panel dividers —
 * mouse-oriented like those handles; touch users just get whatever height was
 * last saved.
 *
 * @param {{
 *   targetRef: React.RefObject<HTMLTextAreaElement|null>,
 *   height: number | null,
 *   onChange?: (height: number) => void,
 *   onReset?: () => void,
 * }} props
 */
export default function ComposerGrip({
  targetRef,
  height,
  onChange,
  onReset,
}) {
  function handleMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const el = targetRef?.current;
    const startY = event.clientY;
    // Dragging from auto-grow starts at the box's current rendered height.
    const startHeight = el?.offsetHeight || height || COMPOSER_MIN_HEIGHT;
    // Never let a manual height eat more than ~55% of the window — the
    // transcript above must keep room.
    const maxHeight = Math.max(
      COMPOSER_MIN_HEIGHT,
      Math.min(COMPOSER_MAX_HEIGHT, Math.round(window.innerHeight * 0.55)),
    );
    function onMove(moveEvent) {
      const delta = startY - moveEvent.clientY; // drag up = grow
      onChange?.(
        Math.min(
          maxHeight,
          Math.max(COMPOSER_MIN_HEIGHT, Math.round(startHeight + delta)),
        ),
      );
    }
    function onUp() {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize composer"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      title="Drag to resize the composer · double-click to reset"
      className="mx-auto mb-1.5 h-1.5 w-10 shrink-0 cursor-row-resize rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--accent-muted)]"
    />
  );
}
