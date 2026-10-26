import type { ReactNode } from 'react';

export function Card({
  id,
  title,
  wide = false,
  children,
}: {
  id: string;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={wide ? 'card card-wide' : 'card'} aria-labelledby={id}>
      <h2 id={id} className="card-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A proportional bar. The number next to it is the text; the bar is decoration with a label. */
export function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar" role="img" aria-label={label}>
      <div className="bar-fill" style={{ width: `${width}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
