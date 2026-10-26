import type { OsController } from '../controller';
import { Card } from './common';

// Loop and Auto Tasks keep their state on this Mac, so the server cannot show it yet.
// The buttons ask native to open the real screen.
export function OnThisMac({ controller }: { controller: OsController }) {
  return (
    <Card id="sec-mac" title="On this Mac">
      <p className="meta">
        Loop and Auto Tasks run on this Mac and their state is not on the server yet, so they are not shown here.
      </p>
      <ul className="plain actions">
        <li>
          <span>Loop</span>
          <button type="button" className="btn" onClick={() => controller.open('loop')}>
            Open Loop
          </button>
        </li>
        <li>
          <span>Auto Tasks</span>
          <button type="button" className="btn" onClick={() => controller.open('autoTasks')}>
            Open Auto Tasks
          </button>
        </li>
      </ul>
    </Card>
  );
}
