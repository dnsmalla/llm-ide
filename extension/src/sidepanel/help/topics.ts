// Structured replacement for HelpPanel's Overview section — the first topic migrated out of static JSX prose, so
// the same copy can also host a "Start tour" entry point. The rest of HelpPanel's sections stay static prose this
// phase (see the Phase 1 design spec).
export interface OverviewPage {
  icon: string;
  name: string;
  body: string;
}

export interface OverviewFlowStep {
  title: string;
  body: string;
}

export interface OverviewContent {
  heading: string;
  intro: readonly string[];
  pagesHeading: string;
  pagesIntro: string;
  pages: readonly OverviewPage[];
  pagesHint: string;
  privacyHeading: string;
  privacy: readonly string[];
  flowHeading: string;
  flow: readonly OverviewFlowStep[];
}

export const OVERVIEW: OverviewContent = {
  heading: 'Welcome to LLM-IDE',
  intro: [
    "Meetings are where important things happen — decisions get made, tasks get assigned, ideas take shape. But keeping up with everything while you're actually in the conversation? That's almost impossible. That's exactly why LLM-IDE exists.",
    'LLM-IDE sits quietly beside your meeting, captures every word, and lets AI do the heavy lifting — summarizing, analyzing, and answering your questions. You focus on the conversation. We take care of the notes.',
  ],
  pagesHeading: 'Your five-tab workspace',
  pagesIntro: "LLM-IDE is organized into five pages. Each one handles a different part of the meeting workflow. Here's a quick map:",
  pages: [
    {
      icon: 'mic',
      name: 'Transcript',
      body: 'A live, scrolling record of everything being said. Words appear as people speak, grouped by who said them.',
    },
    {
      icon: 'note',
      name: 'Notes',
      body: 'One click turns your raw transcript into polished meeting notes with summaries, decisions, and action items.',
    },
    {
      icon: 'question',
      name: 'Questions',
      body: 'The AI reads between the lines and flags things that are vague, contradictory, or need follow-up.',
    },
    {
      icon: 'chat',
      name: 'Chat',
      body: 'Ask the AI anything about your meeting in plain English. "What did we decide about the timeline?"',
    },
    {
      icon: 'gear',
      name: 'Settings',
      body: 'Microphone setup, diagnostics, AI persona, connectors, and a searchable knowledge base of all your past meetings.',
    },
  ],
  pagesHint: 'Click any page name in the navigation above to see a detailed guide with examples and tips.',
  privacyHeading: '100% private — nothing leaves your machine',
  privacy: [
    "This isn't a cloud service. Your audio never gets uploaded. Your transcript never touches a remote server. Everything runs locally — the extension captures, a small server on localhost:3456 handles AI requests through your own Claude CLI credentials, and the knowledge base is a local SQLite file on your hard drive.",
    'No accounts with third parties. No data sharing. No subscriptions. Just your meetings, your notes, your machine.',
  ],
  flowHeading: 'A typical meeting flow',
  flow: [
    { title: 'Before the meeting', body: 'Make sure the server is running. Open LLM-IDE from the toolbar.' },
    { title: 'Start recording', body: 'Click Start. Words flow into the Transcript tab in real time.' },
    { title: 'During the meeting', body: 'Glance at the transcript, ask the Chat, or let the co-pilot flag gaps.' },
    { title: 'After the meeting', body: 'Generate Notes, export as DOCX, share with your team.' },
  ],
};
