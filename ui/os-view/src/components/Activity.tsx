import type { OsState } from '../types';
import { fmtInt, fmtTime, words } from '../format';
import { Card, Empty } from './common';

export function Activity({ activity }: { activity: OsState['activity'] }) {
  return (
    <Card id="sec-activity" title="Activity timeline" wide>
      <p className="meta">{fmtInt(activity.unread)} unread</p>
      {activity.items.length === 0 ? (
        <Empty>No activity yet. Chat turns, ingests and meetings show up here as they happen.</Empty>
      ) : (
        <ol className="timeline">
          {activity.items.map((item) => (
            <li key={item.id}>
              <time dateTime={item.createdAt}>{fmtTime(item.createdAt)}</time>
              <span className="tag">{words(item.kind)}</span>
              <span className="timeline-title">{item.title}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
