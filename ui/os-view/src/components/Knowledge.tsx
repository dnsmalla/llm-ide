import type { OsState } from '../types';
import type { OsController } from '../controller';
import { fmtInt, fmtTime, shortSha, words } from '../format';
import { Card, Empty } from './common';

export function Knowledge({ knowledge, controller }: { knowledge: OsState['knowledge']; controller: OsController }) {
  const empty =
    knowledge.sources.total === 0 &&
    knowledge.meetings.count === 0 &&
    knowledge.outcomes.total === 0 &&
    knowledge.codeGraph.length === 0 &&
    knowledge.projectMemory.length === 0;

  return (
    <Card id="sec-knowledge" title="Memory and knowledge">
      {empty ? (
        <>
          <Empty>Nothing indexed yet. Add a source or a meeting in Library and it shows up here.</Empty>
          <button type="button" className="btn" onClick={() => controller.open('library')}>
            Open Library
          </button>
        </>
      ) : null}
      <dl className="totals">
        <div>
          <dt>Sources</dt>
          <dd>{fmtInt(knowledge.sources.total)}</dd>
        </div>
        <div>
          <dt>Meetings</dt>
          <dd>{fmtInt(knowledge.meetings.count)}</dd>
        </div>
        <div>
          <dt>Pending reviews</dt>
          <dd>{fmtInt(knowledge.pendingReviews)}</dd>
        </div>
        <div>
          <dt>Outcomes</dt>
          <dd>
            {fmtInt(knowledge.outcomes.total)}
            <span className="meta"> · {fmtInt(knowledge.outcomes.terminal)} finished</span>
          </dd>
        </div>
      </dl>

      {knowledge.sources.byKind.length > 0 ? (
        <>
          <h3 className="sub-title">Sources by kind</h3>
          <ul className="plain">
            {knowledge.sources.byKind.map((row) => (
              <li key={row.kind}>
                {words(row.kind)}: {fmtInt(row.count)} <span className="meta">· indexed {fmtTime(row.lastIndexedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {knowledge.codeGraph.length > 0 ? (
        <>
          <h3 className="sub-title">Code graph</h3>
          <ul className="plain">
            {knowledge.codeGraph.map((repo) => (
              <li key={repo.repoId}>
                {repo.repoId} <span className="meta">· {shortSha(repo.commitSha)} · built {fmtTime(repo.generatedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {knowledge.projectMemory.length > 0 ? (
        <>
          <h3 className="sub-title">Project memory</h3>
          <ul className="plain">
            {knowledge.projectMemory.map((repo) => (
              <li key={repo.repoRoot}>
                {repo.repoRoot}{' '}
                <span className="meta">
                  · {fmtInt(repo.active)} active, {fmtInt(repo.superseded)} superseded · confirmed{' '}
                  {fmtTime(repo.lastConfirmedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
