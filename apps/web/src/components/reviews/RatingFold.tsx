import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useMarks } from '../../lib/member.ts';
import { m } from '../../paraglide/messages.js';

// "Hide ratings until I've visited" (P3a, A§15.1). The markup is the same for everyone: the server
// render and the first client render never carry `data-open`, and whether the block is hidden at all
// is CSS's call (`html[data-hide-ratings]`, set by src/prefs.ts from this browser's own flag). After
// hydration the block opens when the member's marks say the museum is visited, or on a click.
// `compact` (list cards) shows a short label; the full text stays the button's accessible name.

export function RatingFold({
  museumId,
  compact = false,
  children,
}: {
  museumId: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const marks = useMarks();
  const [clicked, setClicked] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const open = clicked || marks?.visited.has(museumId) === true;
  // After the click has opened the block (a hidden element cannot take focus), focus moves to it.
  useEffect(() => {
    if (clicked) body.current?.focus();
  }, [clicked]);
  return (
    <div className="fold" data-open={open ? '' : undefined}>
      <div className="fold-body" tabIndex={-1} ref={body}>
        {children}
      </div>
      <button
        type="button"
        className="fold-show"
        aria-label={compact ? m.fold_show() : undefined}
        onClick={() => setClicked(true)}
      >
        {compact ? m.fold_show_short() : m.fold_show()}
      </button>
    </div>
  );
}
