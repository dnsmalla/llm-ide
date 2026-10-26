import type { OsState } from '../types';
import type { OsController } from '../controller';
import { Card } from './common';

const CHECKS: Array<{ key: 'db' | 'claude' | 'skills'; label: string }> = [
  { key: 'db', label: 'Database' },
  { key: 'claude', label: 'Claude CLI' },
  { key: 'skills', label: 'Skills' },
];

export function SystemMap({ system, controller }: { system: OsState['system']; controller: OsController }) {
  const features = system.features ? system.features.join(', ') : 'all features on';
  return (
    <Card id="sec-map" title="System map">
      <p className="meta">
        Server {system.status === 'ok' ? 'healthy' : 'degraded'} · {features}
      </p>
      <ul className="checks" aria-label="Health checks">
        {CHECKS.map(({ key, label }) => {
          const ok = system.checks[key];
          const error = key === 'claude' ? system.checks.claudeError : key === 'skills' ? system.checks.skillsError : undefined;
          return (
            <li key={key}>
              <span className={ok ? 'dot dot-ok' : 'dot dot-bad'} aria-hidden="true" />
              <span>{label}</span>
              <span className="meta">{ok ? 'ok' : 'failed'}</span>
              {error ? <span className="meta"> · {error}</span> : null}
            </li>
          );
        })}
      </ul>
      <ul className="kits">
        {system.kits.map((kit) => (
          <li key={kit.id} className={kit.enabled ? 'kit kit-on' : 'kit kit-off'}>
            <div className="kit-name">{kit.id}</div>
            <div className="meta">
              {kit.enabled ? 'On' : 'Off'} · {kit.requires.length ? `needs ${kit.requires.join(', ')}` : 'always on'}
            </div>
            {!kit.enabled ? (
              <button type="button" className="btn" onClick={() => controller.open('settings')}>
                Turn on in Settings
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
