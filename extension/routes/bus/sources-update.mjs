// The `sources.update` bus kind's L4 wrapper. The logic lives in agents/tasks/sources-update.mjs; this file only
// supplies the two route-layer adapters the agent layer may not import (Google and iCal sync).
import { runGoogleSync } from '../google-connectors.mjs';
import { runIcalSync } from '../calendar-ical.mjs';
import {
  runSourcesUpdate as runCoreSourcesUpdate,
  storedBoxConnection,
  BOX_SCHEDULED_MIN_INTERVAL_MS,
} from '../../agents/tasks/sources-update.mjs';

export { storedBoxConnection, BOX_SCHEDULED_MIN_INTERVAL_MS };

export const runSourcesUpdate = (args) => runCoreSourcesUpdate({ ...args, deps: { runGoogleSync, runIcalSync } });
