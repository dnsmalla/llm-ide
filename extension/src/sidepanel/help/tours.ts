// The flagship side-panel tour: record a meeting, then generate notes from it. Content is pure data
// (TourFlow) so it can be imported by the node test runner without pulling in any .tsx.
import type { TourFlow } from './tour-model';

export const RECORD_NOTES_TOUR: TourFlow = {
  id: 'record-notes',
  title: 'Record a meeting → generate notes',
  steps: [
    {
      id: 'start',
      title: 'Start recording',
      body: 'Click Start Recording to begin capturing the meeting.',
      targetId: 'start-recording',
    },
    {
      id: 'generate',
      title: 'Generate your notes',
      body: 'Once you have some transcript, switch to Notes and click Generate Notes.',
      targetId: 'generate-notes',
      screenId: 'notes',
    },
    {
      id: 'result',
      title: 'Your notes are ready',
      body: 'Summaries, decisions and action items appear here, pulled straight from the transcript.',
      targetId: 'notes-result',
      screenId: 'notes',
    },
  ],
};
