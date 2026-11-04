import type { ReactNode } from 'react';

/** Native disclosure keeps its children mounted (drafts, players and jobs survive). */
export function Details({ title, children, open, className = '' }: { title: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  return <details className={`ui-details ${className}`} open={open}><summary>{title}</summary><div className="ui-details-body">{children}</div></details>;
}
