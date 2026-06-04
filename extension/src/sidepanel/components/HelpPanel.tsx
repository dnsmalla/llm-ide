import React, { useEffect, useState } from 'react';

interface Props {
  onClose: () => void;
}

type HelpSection =
  | 'overview'
  | 'getting-started'
  | 'transcript'
  | 'notes'
  | 'questions'
  | 'chat'
  | 'settings'
  | 'platforms'
  | 'shortcuts'
  | 'troubleshooting';

interface SectionDef {
  id: HelpSection;
  icon: string;
  title: string;
  group?: string;
}

const SECTIONS: SectionDef[] = [
  { id: 'overview', icon: '📋', title: 'Overview' },
  { id: 'getting-started', icon: '🚀', title: 'Getting Started' },
  { id: 'transcript', icon: '🎙', title: 'Transcript', group: 'Pages' },
  { id: 'notes', icon: '📝', title: 'Notes', group: 'Pages' },
  { id: 'questions', icon: '❓', title: 'Questions', group: 'Pages' },
  { id: 'chat', icon: '💬', title: 'Chat', group: 'Pages' },
  { id: 'settings', icon: '⚙', title: 'Settings', group: 'Pages' },
  { id: 'platforms', icon: '🖥', title: 'Platforms' },
  { id: 'shortcuts', icon: '⌨', title: 'Shortcuts' },
  { id: 'troubleshooting', icon: '🔧', title: 'Troubleshoot' },
];

export default function HelpPanel({ onClose }: Props) {
  const [activeSection, setActiveSection] = useState<HelpSection>('overview');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  let lastGroup: string | undefined;
  const navItems: React.ReactNode[] = [];
  for (const s of SECTIONS) {
    if (s.group && s.group !== lastGroup) {
      navItems.push(
        <span key={`g-${s.group}`} className="help-nav-divider" aria-hidden="true">|</span>,
      );
      lastGroup = s.group;
    }
    navItems.push(
      <button
        key={s.id}
        className={`help-nav-item ${activeSection === s.id ? 'active' : ''}`}
        onClick={() => setActiveSection(s.id)}
        aria-current={activeSection === s.id ? 'true' : undefined}
      >
        <span className="help-nav-icon" aria-hidden="true">{s.icon}</span>
        {s.title}
      </button>,
    );
  }

  return (
    <div className="help-panel" role="dialog" aria-label="Help and onboarding guide">
      <div className="help-header">
        <h2 className="help-title">Help Guide</h2>
        <button
          className="btn-popout"
          onClick={onClose}
          aria-label="Close help panel"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <nav className="help-nav" aria-label="Help sections">{navItems}</nav>

      <div className="help-content">
        {activeSection === 'overview' && <OverviewSection />}
        {activeSection === 'getting-started' && <GettingStartedSection />}
        {activeSection === 'transcript' && <TranscriptPageSection />}
        {activeSection === 'notes' && <NotesPageSection />}
        {activeSection === 'questions' && <QuestionsPageSection />}
        {activeSection === 'chat' && <ChatPageSection />}
        {activeSection === 'settings' && <SettingsPageSection />}
        {activeSection === 'platforms' && <PlatformsSection />}
        {activeSection === 'shortcuts' && <ShortcutsSection />}
        {activeSection === 'troubleshooting' && <TroubleshootingSection />}
      </div>
    </div>
  );
}

/* ================================================================
   OVERVIEW
   ================================================================ */

function OverviewSection() {
  return (
    <div className="help-section">
      <h3>Welcome to LLM IDE</h3>
      <p>
        Meetings are where important things happen &mdash; decisions get made,
        tasks get assigned, ideas take shape. But keeping up with everything
        while you&apos;re actually <em>in</em> the conversation? That&apos;s
        almost impossible. That&apos;s exactly why LLM IDE exists.
      </p>
      <p>
        LLM IDE sits quietly beside your meeting, captures every word,
        and lets AI do the heavy lifting &mdash; summarizing, analyzing, and
        answering your questions. You focus on the conversation. We take care
        of the notes.
      </p>

      <div className="help-card">
        <h4>Your five-tab workspace</h4>
        <p>
          LLM IDE is organized into five pages. Each one handles a different
          part of the meeting workflow. Here&apos;s a quick map:
        </p>
        <div className="help-page-overview">
          <div className="help-page-pill">
            <span aria-hidden="true">🎙</span>
            <strong>Transcript</strong> &mdash; A live, scrolling record of everything
            being said. Words appear as people speak, grouped by who said them.
          </div>
          <div className="help-page-pill">
            <span aria-hidden="true">📝</span>
            <strong>Notes</strong> &mdash; One click turns your raw transcript into
            polished meeting notes with summaries, decisions, and action items.
          </div>
          <div className="help-page-pill">
            <span aria-hidden="true">❓</span>
            <strong>Questions</strong> &mdash; The AI reads between the lines and
            flags things that are vague, contradictory, or need follow-up.
          </div>
          <div className="help-page-pill">
            <span aria-hidden="true">💬</span>
            <strong>Chat</strong> &mdash; Ask the AI anything about your meeting in
            plain English. &ldquo;What did we decide about the timeline?&rdquo;
          </div>
          <div className="help-page-pill">
            <span aria-hidden="true">⚙</span>
            <strong>Settings</strong> &mdash; Microphone setup, diagnostics, AI
            persona, connectors, and a searchable knowledge base of all your past
            meetings.
          </div>
        </div>
        <p className="help-hint">
          Click any page name in the navigation above to see a detailed guide
          with examples and tips.
        </p>
      </div>

      <div className="help-card help-card-highlight">
        <h4>100% private &mdash; nothing leaves your machine</h4>
        <p>
          This isn&apos;t a cloud service. Your audio never gets uploaded. Your
          transcript never touches a remote server. Everything runs locally
          &mdash; the extension captures, a small server on <code>localhost:3456</code>{' '}
          handles AI requests through your own Claude CLI credentials, and the
          knowledge base is a local SQLite file on your hard drive.
        </p>
        <p>
          No accounts with third parties. No data sharing. No subscriptions.
          Just your meetings, your notes, your machine.
        </p>
      </div>

      <div className="help-card">
        <h4>A typical meeting flow</h4>
        <div className="help-flow">
          <div className="help-flow-step active">
            <div className="help-flow-icon">1</div>
            <div className="help-flow-body">
              <h4>Before the meeting</h4>
              <p>Make sure the server is running. Open LLM IDE from the toolbar.</p>
            </div>
          </div>
          <div className="help-flow-arrow">↓</div>
          <div className="help-flow-step active">
            <div className="help-flow-icon">2</div>
            <div className="help-flow-body">
              <h4>Start recording</h4>
              <p>Click Start. Words flow into the Transcript tab in real time.</p>
            </div>
          </div>
          <div className="help-flow-arrow">↓</div>
          <div className="help-flow-step">
            <div className="help-flow-icon">3</div>
            <div className="help-flow-body">
              <h4>During the meeting</h4>
              <p>Glance at the transcript, ask the Chat, or let the co-pilot flag gaps.</p>
            </div>
          </div>
          <div className="help-flow-arrow">↓</div>
          <div className="help-flow-step">
            <div className="help-flow-icon">4</div>
            <div className="help-flow-body">
              <h4>After the meeting</h4>
              <p>Generate Notes, export as DOCX, share with your team.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   GETTING STARTED
   ================================================================ */

function GettingStartedSection() {
  return (
    <div className="help-section">
      <h3>Getting started in 5 minutes</h3>
      <p>
        You&apos;re about to go from &ldquo;I just installed this&rdquo; to
        &ldquo;I have AI-powered meeting notes.&rdquo; Let&apos;s walk through
        it step by step &mdash; it&apos;s easier than it looks.
      </p>

      <div className="help-card">
        <h4>Step 1 &mdash; Start the local server</h4>
        <p>
          Open any terminal (Terminal on Mac, Command Prompt on Windows) and run:
        </p>
        <code className="help-code-block">node server.mjs</code>
        <p>
          You should see output like <code>Server running on port 3456</code>.
          Leave this terminal open &mdash; it needs to stay running while you use
          LLM IDE.
        </p>
        <div className="help-card help-tip">
          <strong>Good to know:</strong> Recording works even without the server.
          So if you forget to start it, you can still capture the meeting and
          generate notes afterward. The server is only needed for AI features
          (notes, chat, questions).
        </div>
      </div>

      <div className="help-card">
        <h4>Step 2 &mdash; Join your meeting</h4>
        <p>
          Open <strong>Google Meet</strong>, <strong>Microsoft Teams</strong>,
          or <strong>Zoom</strong> in the same Chrome browser where this extension
          is installed. No plugins to install in the meeting app, no special
          settings &mdash; just join your meeting normally.
        </p>
        <div className="help-scenario">
          <div className="help-scenario-label">Example</div>
          <p>
            You have a standup at 10am on Google Meet. You click the meeting link,
            Chrome opens the meeting, and you&apos;re in. That&apos;s all the setup
            LLM IDE needs.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>Step 3 &mdash; Open the side panel</h4>
        <p>
          Click the <strong>LLM IDE icon</strong> in your browser toolbar
          (it&apos;s in the top-right corner, next to your other extensions).
          A side panel slides open on the right side of your screen, right
          next to the meeting.
        </p>
        <div className="help-card help-tip">
          <strong>Tip:</strong> The side panel stays open even when you switch
          between browser tabs. So you can peek at a document and come back to
          the meeting without losing your place.
        </div>
      </div>

      <div className="help-card">
        <h4>Step 4 &mdash; Press Start</h4>
        <p>
          Click the big <strong>Start</strong> button at the top. LLM IDE
          automatically figures out the best way to capture your meeting:
        </p>
        <div className="help-compare">
          <div className="help-compare-col after">
            <div className="help-compare-label">Captions mode (best)</div>
            <p>
              Reads the platform&apos;s built-in CC subtitles. You get real
              speaker names like &ldquo;Alice Chen&rdquo; and
              &ldquo;Bob Smith.&rdquo;
            </p>
          </div>
          <div className="help-compare-col before">
            <div className="help-compare-label">Mic mode (fallback)</div>
            <p>
              Uses your microphone and browser speech recognition. Speakers
              show as &ldquo;Speaker 1&rdquo;, &ldquo;Speaker 2&rdquo; (you
              can rename them).
            </p>
          </div>
        </div>
        <p className="help-hint">
          You don&apos;t need to choose &mdash; LLM IDE picks captions mode
          automatically when available.
        </p>
      </div>

      <div className="help-card">
        <h4>Step 5 &mdash; Generate your first notes</h4>
        <p>
          When the meeting wraps up (or even mid-meeting &mdash; it won&apos;t
          interrupt recording), switch to the <strong>Notes</strong> tab and
          click <strong>Generate Notes</strong>.
        </p>
        <p>
          Within a few seconds, the AI reads through everything that was said
          and produces structured meeting notes. You&apos;ll see a summary,
          key decisions, action items, and anything that was left open.
        </p>
        <p>
          From there you can download the notes as a Word document, copy them
          to your clipboard, or export in half a dozen other formats.
        </p>

        <div className="help-card help-card-highlight">
          <h4>That&apos;s it &mdash; you&apos;re set!</h4>
          <p>
            Five steps, and you&apos;ve gone from an empty panel to
            AI-generated meeting notes. Explore the other tabs (Questions,
            Chat, Settings) to discover more powerful features as you get
            comfortable.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   TRANSCRIPT PAGE
   ================================================================ */

function TranscriptPageSection() {
  return (
    <div className="help-section">
      <div className="help-page-header">
        <span className="help-page-header-icon" aria-hidden="true">🎙</span>
        <div>
          <h3>Transcript Page</h3>
          <p className="help-page-tagline">
            Your live, searchable, speaker-attributed record of everything said
            in the meeting &mdash; updated word by word as people speak.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>What you&apos;ll see</h4>
        <p>
          The moment you press <strong>Start</strong>, the transcript comes alive.
          Words appear in real time, grouped under the name of whoever is speaking.
          Each group shows a timestamp so you can see exactly when something was said.
        </p>
        <p>
          Think of it like reading live subtitles for your meeting &mdash; except
          you can scroll back, search through it, and rename speakers whenever you
          want.
        </p>
        <div className="help-scenario">
          <div className="help-scenario-label">What it looks like</div>
          <p><strong>Alice Chen</strong> &nbsp; 10:03:15<br />
            I think we should move the deadline to Friday.
          </p>
          <p><strong>Bob Smith</strong> &nbsp; 10:03:22<br />
            That works for me. I&apos;ll update the project board.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>Searching the transcript</h4>
        <p>
          At the very top of the transcript area, there&apos;s a search bar. Start
          typing and the transcript <em>instantly</em> filters down to only the
          lines that match. A small counter next to the search bar shows you how
          many lines matched out of the total.
        </p>
        <p>
          You can search by <strong>keyword</strong> (e.g., &ldquo;deadline&rdquo;)
          or by <strong>speaker name</strong> (e.g., &ldquo;Alice&rdquo;). Clear
          the search field to see the full transcript again.
        </p>
        <div className="help-card help-tip">
          <strong>Pro tip:</strong> Searching doesn&apos;t affect the recording.
          New lines still arrive while you&apos;re searching &mdash; they just
          won&apos;t auto-scroll into view so your search results stay stable.
        </div>
      </div>

      <div className="help-card">
        <h4>Renaming speakers</h4>
        <p>
          When LLM IDE uses <strong>mic mode</strong> (no platform captions
          available), speakers are labeled generically: &ldquo;Speaker 1&rdquo;,
          &ldquo;Speaker 2&rdquo;, and so on.
        </p>
        <p>
          To fix this, simply <strong>click on any speaker name</strong> in the
          transcript. A small input field appears. Type the real name
          (e.g., &ldquo;Alice&rdquo;) and press <kbd>Enter</kbd>. The name
          updates <em>everywhere</em> in the transcript instantly.
        </p>
        <div className="help-compare">
          <div className="help-compare-col before">
            <div className="help-compare-label">Before</div>
            <p>Speaker 1: I think we should move the deadline.<br />
              Speaker 2: That works for me.</p>
          </div>
          <div className="help-compare-col after">
            <div className="help-compare-label">After</div>
            <p>Alice: I think we should move the deadline.<br />
              Bob: That works for me.</p>
          </div>
        </div>
        <p className="help-hint">
          In captions mode (Meet, Teams, Zoom), the platform provides real names
          automatically, so you usually don&apos;t need to rename anyone.
        </p>
      </div>

      <div className="help-card">
        <h4>Auto-save &amp; manual save</h4>
        <p>
          When you stop recording, LLM IDE <strong>automatically saves</strong>{' '}
          the transcript to your browser&apos;s local storage. If the browser
          crashes or you accidentally close the tab, your transcript is safe.
        </p>
        <p>
          You can also click the <strong>Save Transcript</strong> button that
          appears below the transcript to download it as a <code>.txt</code> file
          with timestamps and speaker names.
        </p>
      </div>

      <div className="help-card">
        <h4>Bilingual mode &mdash; for multilingual meetings</h4>
        <p>
          Some meetings naturally switch between languages (e.g., Japanese
          and English). Instead of only recognizing one language, you can
          enable <strong>bilingual mode</strong> in the language selector above
          the transcript.
        </p>
        <p>
          When bilingual mode is active, LLM IDE runs <em>two</em> speech
          recognizers at the same time &mdash; one for each language. For every
          sentence, it compares both results and picks the one with higher
          confidence. The winning language is shown as a small badge next to each
          line so you know which language was detected.
        </p>
      </div>

      <div className="help-card">
        <h4>Language selector</h4>
        <p>
          Above the transcript you&apos;ll find dropdown menus to set your{' '}
          <strong>primary language</strong> and (optionally) a{' '}
          <strong>secondary language</strong>. LLM IDE supports 20 languages
          including Japanese, English, Chinese, Korean, Hindi, Nepali, Spanish,
          French, German, Arabic, Thai, and more.
        </p>
        <p className="help-hint">
          Pick the language that matches what people are actually speaking. If
          everyone speaks English, set English as primary and leave bilingual mode
          off.
        </p>
      </div>

      <div className="help-card">
        <h4>Transcript limits</h4>
        <p>
          For very long meetings, the transcript is capped at <strong>5,000
          segments</strong> to keep the browser responsive. If you hit this limit,
          you&apos;ll see a warning banner, and the oldest lines start dropping
          off. This only applies to the live view &mdash; the full transcript is
          still sent to the AI when you generate notes.
        </p>
      </div>
    </div>
  );
}

/* ================================================================
   NOTES PAGE
   ================================================================ */

function NotesPageSection() {
  return (
    <div className="help-section">
      <div className="help-page-header">
        <span className="help-page-header-icon" aria-hidden="true">📝</span>
        <div>
          <h3>Notes Page</h3>
          <p className="help-page-tagline">
            One click transforms a 45-minute conversation into clear, structured
            notes you can share with your team in seconds.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>How to generate notes</h4>
        <p>
          It&apos;s beautifully simple:
        </p>
        <ol className="help-steps">
          <li>
            Make sure you have a transcript &mdash; either record a live meeting
            or load a saved one
          </li>
          <li>
            Switch to the <strong>Notes</strong> tab
          </li>
          <li>
            Click the <strong>Generate Notes</strong> button
          </li>
          <li>
            Watch the spinner for a few seconds while the AI reads through
            everything that was said
          </li>
          <li>
            Your structured meeting notes appear, formatted and ready to share
          </li>
        </ol>
      </div>

      <div className="help-card">
        <h4>What the AI creates for you</h4>
        <p>
          The AI doesn&apos;t just regurgitate the transcript &mdash; it
          <em> understands</em> it. The output is a well-organized document that
          typically includes:
        </p>
        <ul className="help-list">
          <li><strong>Meeting summary</strong> &mdash; A 2&ndash;3 sentence overview
            of what the meeting was about</li>
          <li><strong>Key discussion points</strong> &mdash; The main topics that
            were discussed, with context</li>
          <li><strong>Decisions made</strong> &mdash; Anything that was agreed upon,
            with who agreed to what</li>
          <li><strong>Action items</strong> &mdash; Tasks that need to happen, with
            owners where mentioned</li>
          <li><strong>Open questions</strong> &mdash; Topics that were raised but not
            resolved</li>
        </ul>
        <div className="help-scenario">
          <div className="help-scenario-label">Example output</div>
          <p>
            <strong>Summary:</strong> The team discussed the Q3 launch timeline.
            Alice proposed moving the deadline to Friday, which Bob agreed to.
            A concern about testing capacity was raised but left unresolved.
          </p>
          <p>
            <strong>Action items:</strong><br />
            &bull; Bob: Update the project board with new Friday deadline<br />
            &bull; Alice: Send the revised timeline to stakeholders
          </p>
        </div>
        <p className="help-hint">
          The format adapts to the content. A standup produces bullet points per
          person. A design review highlights feedback and next steps. A planning
          session surfaces milestones and dependencies.
        </p>
      </div>

      <div className="help-card">
        <h4>Export options &mdash; share it your way</h4>
        <p>
          Below the generated notes, you&apos;ll find a row of export buttons.
          LLM IDE gives you multiple formats for different needs:
        </p>
        <ul className="help-list">
          <li><strong>Download DOCX</strong> &mdash; A polished Word document with
            formatting, headings, and bullet points. Perfect for sharing with
            stakeholders or archiving.</li>
          <li><strong>Copy Notes</strong> &mdash; One-click clipboard copy. Paste
            directly into Slack, Notion, Google Docs, or an email.</li>
          <li><strong>Download .md</strong> &mdash; Markdown file for developers,
            wikis, or knowledge bases.</li>
          <li><strong>Copy Transcript</strong> &mdash; The raw transcript text,
            great for pasting into another tool.</li>
          <li><strong>Download .txt</strong> &mdash; Plain text with timestamps
            and speaker names.</li>
          <li><strong>Download .vtt</strong> &mdash; WebVTT subtitle format. Useful
            if you recorded the meeting video and want synchronized captions.</li>
          <li><strong>Download .srt</strong> &mdash; SubRip subtitle format. Works
            with most video players and editors.</li>
          <li><strong>Download .json</strong> &mdash; Structured JSON with speaker
            names, timestamps, and language tags. Ideal for programmatic
            analysis or importing into other tools.</li>
        </ul>
      </div>

      <div className="help-card">
        <h4>Re-generate anytime</h4>
        <p>
          Notes aren&apos;t a one-shot deal. You can click{' '}
          <strong>Generate Notes</strong> again at any point &mdash; even while
          the meeting is still going. Each time, the AI uses the most recent
          transcript, so mid-meeting notes give you a snapshot of what&apos;s
          been discussed so far.
        </p>
        <div className="help-card help-tip">
          <strong>Handy trick:</strong> Generate notes halfway through a long
          meeting to capture the first half&apos;s decisions. Then generate again
          at the end for the complete picture. Both sets of notes stay available.
        </div>
      </div>

      <div className="help-card">
        <h4>When there&apos;s no transcript yet</h4>
        <p>
          The Generate Notes button is disabled (grayed out) until there&apos;s
          a transcript to work with. You&apos;ll see the message{' '}
          <em>&ldquo;Record a meeting first.&rdquo;</em> Just switch back to
          the Transcript tab, start recording, and come back when there&apos;s
          content.
        </p>
      </div>
    </div>
  );
}

/* ================================================================
   QUESTIONS PAGE
   ================================================================ */

function QuestionsPageSection() {
  return (
    <div className="help-section">
      <div className="help-page-header">
        <span className="help-page-header-icon" aria-hidden="true">❓</span>
        <div>
          <h3>Questions Page</h3>
          <p className="help-page-tagline">
            Your AI meeting analyst &mdash; it reads between the lines and flags
            everything that&apos;s vague, contradictory, or needs follow-up.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>Why this page exists</h4>
        <p>
          Every meeting has blind spots. Someone says &ldquo;we&apos;ll handle
          it next week&rdquo; &mdash; but <em>who</em> exactly? A deadline is
          mentioned as both &ldquo;Friday&rdquo; and &ldquo;end of next
          week.&rdquo; A key assumption goes unchallenged. These are the gaps
          that cause problems later.
        </p>
        <p>
          The Questions page catches them for you. The AI reads your transcript
          with fresh eyes and generates specific, pointed questions that help you
          close the gaps &mdash; either before the meeting ends or in a follow-up.
        </p>
      </div>

      <div className="help-card">
        <h4>Three types of questions</h4>
        <p>
          Each question is categorized so you can focus on what matters most:
        </p>
        <div className="help-page-overview">
          <div className="help-page-pill">
            <span aria-hidden="true">⚡</span>
            <strong>Conflicts</strong> &mdash; Two or more people said contradictory
            things. &ldquo;Alice said Friday, but Bob mentioned next Wednesday.
            Which deadline is correct?&rdquo;
          </div>
          <div className="help-page-pill">
            <span aria-hidden="true">✅</span>
            <strong>Needs confirmation</strong> &mdash; A decision, number, or
            commitment was stated but not verified. &ldquo;Is the budget of $50K
            confirmed? Bob nodded but didn&apos;t verbally agree.&rdquo;
          </div>
          <div className="help-page-pill">
            <span aria-hidden="true">🔍</span>
            <strong>Needs more detail</strong> &mdash; Something important was
            mentioned but the reasoning was vague or skipped entirely.
            &ldquo;Alice said the API will need changes &mdash; what specifically
            needs to change?&rdquo;
          </div>
        </div>
      </div>

      <div className="help-card">
        <h4>Customizing what gets generated</h4>
        <p>
          Before clicking Generate, you can expand the <strong>Customize</strong>{' '}
          section to fine-tune:
        </p>
        <ul className="help-list">
          <li><strong>Question types</strong> &mdash; Toggle which categories
            (conflicts, confirmations, details) to include</li>
          <li><strong>Focus on specific speakers</strong> &mdash; Select
            participants to focus the analysis on</li>
        </ul>
        <p className="help-hint">
          Your customization preferences are saved automatically, so you
          don&apos;t need to set them up again next time.
        </p>
      </div>

      <div className="help-card">
        <h4>The AI Co-pilot &mdash; questions on autopilot</h4>
        <p>
          At the top of this page, you&apos;ll notice an <strong>AI
          Assistant</strong> toggle. This is the co-pilot &mdash; your live meeting
          analyst.
        </p>
        <p>
          When enabled:
        </p>
        <ul className="help-list">
          <li>The co-pilot <strong>attaches automatically</strong> when you start
            recording &mdash; no extra setup</li>
          <li>It watches the conversation <strong>in real time</strong> and
            generates questions as gaps appear</li>
          <li>It&apos;s <strong>intentionally conservative</strong> &mdash; it only
            speaks up when something genuinely needs attention, not on every
            sentence</li>
          <li>A small status indicator shows what the co-pilot is doing (&ldquo;
            listening&rdquo;, &ldquo;analyzing&rdquo;, or why it chose not to
            ask)</li>
        </ul>
        <div className="help-card help-tip">
          <strong>When to turn it off:</strong> If you&apos;re in a casual
          brainstorming session where precision doesn&apos;t matter, the co-pilot
          might feel overzealous. Flip the toggle off and it stops immediately.
          Turn it back on anytime.
        </div>
      </div>

      <div className="help-card">
        <h4>Posting questions to the meeting chat</h4>
        <p>
          On <strong>Google Meet</strong>, there&apos;s a special power: you can
          click any generated question to <strong>send it directly</strong> into
          the meeting&apos;s chat window. This is perfect for raising a
          clarification without interrupting the speaker or unmuting yourself.
        </p>
        <p className="help-hint">
          This feature is currently available on Google Meet only. On Teams and
          Zoom, you can copy the question and paste it into the meeting chat
          manually.
        </p>
      </div>

      <div className="help-card">
        <h4>History-based questions</h4>
        <p>
          If you&apos;ve had similar meetings before (e.g., weekly standups,
          recurring planning sessions), click the <strong>From History</strong>{' '}
          button. The AI looks at your knowledge base &mdash; all your past
          meetings, decisions, and unresolved items &mdash; and generates
          questions informed by that broader context.
        </p>
        <div className="help-scenario">
          <div className="help-scenario-label">Example</div>
          <p>
            In last week&apos;s standup, Alice said she&apos;d fix the login bug
            by Wednesday. This week, it wasn&apos;t mentioned. The history-aware
            AI might ask: &ldquo;Was the login bug resolved? It was due Wednesday
            but wasn&apos;t discussed today.&rdquo;
          </p>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   CHAT PAGE
   ================================================================ */

function ChatPageSection() {
  return (
    <div className="help-section">
      <div className="help-page-header">
        <span className="help-page-header-icon" aria-hidden="true">💬</span>
        <div>
          <h3>Chat Page</h3>
          <p className="help-page-tagline">
            A conversation with an AI that has perfect memory of your meeting.
            Ask anything, in plain language, and get instant answers.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>What makes this chat special</h4>
        <p>
          This isn&apos;t a generic chatbot. It has the <strong>full
          transcript</strong> of your meeting loaded into its context. So when you
          ask &ldquo;What did Alice say about the budget?&rdquo;, it knows exactly
          what Alice said &mdash; because it read every word.
        </p>
        <p>
          This makes it incredibly powerful for recalling specifics, creating
          summaries, drafting follow-ups, or understanding what happened during
          a part of the meeting you weren&apos;t paying full attention to.
        </p>
      </div>

      <div className="help-card">
        <h4>Things you can ask</h4>
        <p>Here are some real examples to give you ideas:</p>
        <div className="help-page-overview">
          <div className="help-page-pill">
            &ldquo;What were the main decisions made in this meeting?&rdquo;
          </div>
          <div className="help-page-pill">
            &ldquo;Summarize everything Bob said&rdquo;
          </div>
          <div className="help-page-pill">
            &ldquo;What action items came out of the design discussion?&rdquo;
          </div>
          <div className="help-page-pill">
            &ldquo;Write a follow-up email summarizing the meeting&rdquo;
          </div>
          <div className="help-page-pill">
            &ldquo;Did anyone disagree with the new timeline?&rdquo;
          </div>
          <div className="help-page-pill">
            &ldquo;Translate the key points into Japanese&rdquo;
          </div>
          <div className="help-page-pill">
            &ldquo;Create a Slack message announcing the decisions&rdquo;
          </div>
        </div>
      </div>

      <div className="help-card">
        <h4>Quick prompts &mdash; one-click starters</h4>
        <p>
          When the chat is empty, you&apos;ll see a row of <strong>suggested
          prompts</strong> like &ldquo;Summarize the key points&rdquo; and
          &ldquo;List all action items.&rdquo; These are the most common things
          people ask. Click any of them to get started without typing.
        </p>
        <p className="help-hint">
          The quick prompts disappear once you start chatting, but you can
          always type these same questions (or any question) manually.
        </p>
      </div>

      <div className="help-card">
        <h4>Conversation memory &mdash; build on previous answers</h4>
        <p>
          The chat remembers everything you&apos;ve said in this session. That
          means you can have a real <em>conversation</em>, building on previous
          answers:
        </p>
        <div className="help-scenario">
          <div className="help-scenario-label">Multi-turn example</div>
          <p><strong>You:</strong> Summarize the meeting in 3 bullet points</p>
          <p><strong>AI:</strong> (gives a 3-point summary)</p>
          <p><strong>You:</strong> Now expand bullet 2 with more detail</p>
          <p><strong>AI:</strong> (expands that specific point)</p>
          <p><strong>You:</strong> Turn that into a Slack message</p>
          <p><strong>AI:</strong> (formats it as a ready-to-post Slack message)</p>
        </div>
        <p className="help-hint">
          Click <strong>Clear Chat</strong> to wipe the conversation and start
          fresh. The meeting transcript is always available regardless &mdash;
          clearing chat only removes your Q&amp;A history.
        </p>
      </div>

      <div className="help-card">
        <h4>Use it during the meeting, not just after</h4>
        <p>
          A powerful but often overlooked feature: you can chat <strong>while
          the meeting is still happening</strong>. The AI always uses the latest
          transcript, so it knows everything up to right now.
        </p>
        <p>
          This is perfect for situations like:
        </p>
        <ul className="help-list">
          <li>Quickly looking up &ldquo;Wait, what did they agree on for the
            deadline?&rdquo; without scrolling back</li>
          <li>Drafting a summary of the first half to share with someone who
            joined late</li>
          <li>Checking if a topic was already covered before you bring it up</li>
        </ul>
      </div>

      <div className="help-card">
        <h4>Formatting &amp; Markdown</h4>
        <p>
          The AI&apos;s responses are rendered as <strong>rich Markdown</strong>.
          That means you&apos;ll see proper headings, bullet points, numbered
          lists, bold text, code blocks, and more &mdash; not just a wall of
          plain text. When you copy the response, the formatting carries over to
          most apps.
        </p>
      </div>

      <div className="help-card">
        <h4>Usage limits</h4>
        <p>
          The chat uses the same AI backend as Notes and Questions. If you see a
          quota warning banner at the top of the chat, it means you&apos;re
          approaching the rate limit for API requests. Slow down for a minute and
          it will reset.
        </p>
      </div>
    </div>
  );
}

/* ================================================================
   SETTINGS PAGE
   ================================================================ */

function SettingsPageSection() {
  return (
    <div className="help-section">
      <div className="help-page-header">
        <span className="help-page-header-icon" aria-hidden="true">⚙</span>
        <div>
          <h3>Settings Page</h3>
          <p className="help-page-tagline">
            Your control center &mdash; manage your account, fine-tune audio,
            customize the AI, diagnose issues, and explore your meeting history.
          </p>
        </div>
      </div>

      <div className="help-card">
        <h4>Account</h4>
        <p>
          At the very top of Settings you&apos;ll see your <strong>display
          name</strong> and <strong>email</strong>. You can change your display
          name (this is what appears in the header and what the AI uses when
          referring to you) and update your password if needed.
        </p>
        <p className="help-hint">
          Your account is local to this server. There&apos;s no cloud sync
          &mdash; your credentials live in the local database.
        </p>
      </div>

      <div className="help-card">
        <h4>Microphone selection</h4>
        <p>
          If you have multiple audio input devices (e.g., a USB headset, laptop
          mic, and a webcam mic), this is where you choose which one LLM IDE
          listens to in <strong>mic mode</strong>.
        </p>
        <ul className="help-list">
          <li><strong>System Default</strong> &mdash; Uses whatever your OS considers
            the active mic. Usually fine for most setups.</li>
          <li><strong>Specific device</strong> &mdash; Pick a particular mic. Useful if
            your system default is a laptop mic but you&apos;re wearing a headset.</li>
        </ul>
        <p>
          Click <strong>Refresh</strong> if you plug in or unplug a device and
          it doesn&apos;t appear in the list.
        </p>
        <p className="help-hint">
          This setting only matters for mic mode. In captions mode (Meet, Teams,
          Zoom), audio comes from the platform&apos;s own CC system, not your
          microphone.
        </p>
      </div>

      <div className="help-card">
        <h4>Volume Boost</h4>
        <p>
          A slider that amplifies the microphone signal before it reaches the
          speech recognition engine. The range is 50% (quieter than normal) to
          300% (three times normal volume).
        </p>
        <div className="help-compare">
          <div className="help-compare-col before">
            <div className="help-compare-label">When to lower it</div>
            <p>If you&apos;re close to the mic or in a quiet room, 100% is fine.
              Boosting too high adds noise and echoes.</p>
          </div>
          <div className="help-compare-col after">
            <div className="help-compare-label">When to raise it</div>
            <p>If speakers are quiet, far from the mic, or in a noisy room,
              try 150&ndash;200% for noticeably better recognition.</p>
          </div>
        </div>
      </div>

      <div className="help-card">
        <h4>Diagnostics &mdash; your debugging dashboard</h4>
        <p>
          The diagnostics panel is a real-time health check. Here&apos;s what
          each field tells you:
        </p>
        <ul className="help-list">
          <li><strong>Recording</strong> &mdash; Shows &ldquo;yes (captions)&rdquo;
            or &ldquo;yes (mic)&rdquo; when active, &ldquo;no&rdquo; when
            stopped</li>
          <li><strong>Platform</strong> &mdash; Which meeting platform was detected
            (Google Meet, Teams, Zoom, or &ldquo;none&rdquo; if no meeting tab was
            found)</li>
          <li><strong>Captions received</strong> &mdash; A counter of how many caption
            messages have arrived since recording started. If this stays at zero,
            captions aren&apos;t flowing &mdash; check the Troubleshooting section</li>
          <li><strong>Last caption</strong> &mdash; How long ago the most recent
            caption arrived (e.g., &ldquo;3s ago&rdquo; or &ldquo;never&rdquo;).
            If it says &ldquo;never&rdquo; while recording, something is wrong.</li>
        </ul>
        <div className="help-card help-tip">
          <strong>Quick diagnostic:</strong> If you see &ldquo;Recording: yes
          (captions)&rdquo; but &ldquo;Captions received: 0&rdquo; and
          &ldquo;Last caption: never,&rdquo; it means the extension is trying to
          read CC but the platform isn&apos;t producing any. Turn on closed
          captions in the meeting itself.
        </div>
      </div>

      <div className="help-card">
        <h4>Agent Persona &mdash; make the AI your own</h4>
        <p>
          This is a powerful customization feature. You can give the AI a{' '}
          <strong>custom personality and focus</strong> that shapes how it
          generates notes, answers questions, and interacts in chat.
        </p>
        <div className="help-scenario">
          <div className="help-scenario-label">Example personas</div>
          <p>
            <strong>&ldquo;Technical PM&rdquo;</strong> &mdash; &ldquo;You are a
            technical program manager. Focus on deadlines, blockers, and
            dependencies. Always list action items with owners and due dates.&rdquo;
          </p>
          <p>
            <strong>&ldquo;Design Reviewer&rdquo;</strong> &mdash; &ldquo;You are a
            UX design lead. Highlight feedback on designs, usability concerns,
            and next steps for each design iteration.&rdquo;
          </p>
        </div>
        <p className="help-hint">
          Leave the persona blank for the default, general-purpose assistant.
        </p>
      </div>

      <div className="help-card">
        <h4>Connectors &mdash; give the AI more context</h4>
        <p>
          Connectors let you link <strong>external sources</strong> to the
          knowledge base. For example, you can connect a Git repository, and the
          AI will have context about your codebase when generating notes or
          answering questions.
        </p>
        <p>
          This is especially useful for engineering teams &mdash; when someone
          mentions &ldquo;the auth service refactor,&rdquo; the AI can
          understand what that means because it has seen the relevant code.
        </p>
      </div>

      <div className="help-card">
        <h4>Knowledge Base Search &mdash; your meeting memory</h4>
        <p>
          This is one of the most powerful features in LLM IDE, and it gets
          better the more you use it.
        </p>
        <p>
          Every meeting you record and every set of notes you generate feeds into
          a <strong>searchable knowledge base</strong>. You can search across:
        </p>
        <ul className="help-list">
          <li><strong>Meetings</strong> &mdash; Find past meetings by topic or keyword</li>
          <li><strong>Actions</strong> &mdash; Track who was assigned what, across all meetings</li>
          <li><strong>Decisions</strong> &mdash; Search for decisions made in any meeting</li>
          <li><strong>Blockers</strong> &mdash; Find unresolved blockers from past sessions</li>
          <li><strong>Code</strong> &mdash; Code-related discussions and references</li>
          <li><strong>Tickets</strong> &mdash; Issue/ticket references extracted from conversations</li>
          <li><strong>QA</strong> &mdash; Questions and answers from past meetings</li>
          <li><strong>Plans</strong> &mdash; Project plans generated from meetings</li>
          <li><strong>Outcomes</strong> &mdash; Results and outcomes that were tracked</li>
        </ul>
        <div className="help-card help-tip">
          <strong>Think of it as your team&apos;s institutional memory.</strong>{' '}
          Three months from now, when someone asks &ldquo;Why did we decide to
          use PostgreSQL instead of MongoDB?&rdquo; you can search for
          &ldquo;database decision&rdquo; and find the exact meeting where it
          was discussed.
        </div>
      </div>

      <div className="help-card">
        <h4>About</h4>
        <p>
          At the bottom of Settings, you&apos;ll find the version number and a
          reminder that everything runs locally. This section also confirms the
          server address (<code>127.0.0.1:3456</code>) so you always know
          where your data is going: nowhere but your own machine.
        </p>
      </div>
    </div>
  );
}

/* ================================================================
   PLATFORMS
   ================================================================ */

function PlatformsSection() {
  return (
    <div className="help-section">
      <h3>Supported Platforms</h3>
      <p>
        LLM IDE works with the three most popular meeting platforms, plus
        a fallback for everything else. Here&apos;s a detailed breakdown of
        what each platform supports.
      </p>

      <div className="help-platform-list">
        <div className="help-card">
          <h4>Google Meet &mdash; Best experience</h4>
          <p>
            Google Meet is the flagship platform for LLM IDE. You get the
            fullest feature set:
          </p>
          <ul className="help-list">
            <li><strong>Live captions (CC)</strong> with real speaker names</li>
            <li><strong>Speaker detection</strong> via video tile analysis</li>
            <li><strong>Participant list</strong> synced from meeting roster</li>
            <li><strong>Chat injection</strong> &mdash; post AI-generated questions
              directly into the meeting chat</li>
            <li><strong>CC overlay hiding</strong> &mdash; LLM IDE can hide the
              platform&apos;s own caption overlay so you see captions only in the
              side panel, keeping the video clean</li>
          </ul>
          <div className="help-card help-tip">
            <strong>For best results:</strong> Make sure closed captions are turned
            on in the meeting. Look for the &ldquo;CC&rdquo; button in the bottom
            toolbar. LLM IDE will also try to enable CC automatically when you
            start recording.
          </div>
        </div>

        <div className="help-card">
          <h4>Microsoft Teams</h4>
          <p>Full caption support with a rich feature set:</p>
          <ul className="help-list">
            <li><strong>Live captions (CC)</strong> with speaker names</li>
            <li><strong>Speaker detection</strong> via roster and video tiles</li>
            <li><strong>Participant list</strong> from the meeting roster</li>
          </ul>
          <p className="help-hint">
            Works on both <code>teams.microsoft.com</code> and{' '}
            <code>teams.live.com</code> (the consumer version).
          </p>
        </div>

        <div className="help-card">
          <h4>Zoom (Web Client)</h4>
          <p>Solid support for Zoom&apos;s web-based meetings:</p>
          <ul className="help-list">
            <li><strong>Transcript panel</strong> and inline captions</li>
            <li><strong>Speaker detection</strong> via video tile CSS classes</li>
          </ul>
          <div className="help-card help-warning">
            <strong>Important:</strong> This works with Zoom in your <em>web
            browser</em> only. The standalone Zoom desktop app runs outside
            Chrome, so the extension can&apos;t access it. To use the web client,
            click &ldquo;Join from your browser&rdquo; instead of launching the
            app.
          </div>
        </div>
      </div>

      <div className="help-card">
        <h4>Everything else &mdash; Microphone fallback</h4>
        <p>
          For platforms without built-in caption support (e.g., phone calls,
          Slack huddles, Discord, or in-person meetings), LLM IDE switches to{' '}
          <strong>microphone mode</strong>:
        </p>
        <ul className="help-list">
          <li>Your microphone captures all audio in the room</li>
          <li>Chrome&apos;s built-in speech recognition transcribes it in real time</li>
          <li>Speakers are labeled &ldquo;Speaker 1&rdquo;, &ldquo;Speaker 2&rdquo;
            based on silence gaps (you can rename them)</li>
          <li>Bilingual mode works here too &mdash; both language recognizers run on
            the mic input</li>
        </ul>
        <p className="help-hint">
          For the best mic-mode accuracy, use a headset rather than a laptop
          mic, and try boosting the volume to 150&ndash;200% in Settings.
        </p>
      </div>
    </div>
  );
}

/* ================================================================
   SHORTCUTS
   ================================================================ */

function ShortcutsSection() {
  return (
    <div className="help-section">
      <h3>Keyboard Shortcuts</h3>
      <p>
        Navigate faster with these shortcuts. They work whenever the side
        panel is focused (click anywhere in the panel first if another window
        has focus).
      </p>

      <div className="help-card">
        <h4>Tab navigation</h4>
        <table className="help-shortcuts-table" aria-label="Tab navigation shortcuts">
          <thead>
            <tr><th>Shortcut</th><th>Action</th></tr>
          </thead>
          <tbody>
            <tr><td><kbd>Alt</kbd> + <kbd>1</kbd></td><td>Go to Transcript</td></tr>
            <tr><td><kbd>Alt</kbd> + <kbd>2</kbd></td><td>Go to Notes</td></tr>
            <tr><td><kbd>Alt</kbd> + <kbd>3</kbd></td><td>Go to Questions</td></tr>
            <tr><td><kbd>Alt</kbd> + <kbd>4</kbd></td><td>Go to Chat</td></tr>
            <tr><td><kbd>Alt</kbd> + <kbd>5</kbd></td><td>Go to Settings</td></tr>
          </tbody>
        </table>
        <p className="help-hint">
          These are shown as tooltips when you hover over the tab buttons.
        </p>
      </div>

      <div className="help-card">
        <h4>Inside the Transcript tab</h4>
        <ul className="help-list">
          <li>Start typing in the <strong>search bar</strong> to filter instantly</li>
          <li><strong>Click a speaker name</strong> to edit it inline</li>
          <li><kbd>Enter</kbd> saves the new name</li>
          <li><kbd>Esc</kbd> cancels the rename without saving</li>
        </ul>
      </div>

      <div className="help-card">
        <h4>Inside the Chat tab</h4>
        <ul className="help-list">
          <li><kbd>Enter</kbd> sends your message</li>
          <li><kbd>Shift</kbd> + <kbd>Enter</kbd> inserts a new line without
            sending (for multi-line messages)</li>
        </ul>
      </div>

      <div className="help-card">
        <h4>Help panel</h4>
        <ul className="help-list">
          <li><kbd>Esc</kbd> closes this help guide and returns you to the app</li>
        </ul>
      </div>
    </div>
  );
}

/* ================================================================
   TROUBLESHOOTING
   ================================================================ */

function TroubleshootingSection() {
  return (
    <div className="help-section">
      <h3>Troubleshooting</h3>
      <p>
        Something not working right? Don&apos;t worry &mdash; most issues have
        simple fixes. Here are the most common problems and exactly how to
        solve them.
      </p>

      <div className="help-card">
        <h4>Captions aren&apos;t appearing in the transcript</h4>
        <p>
          This is the #1 question new users have. Here&apos;s a checklist:
        </p>
        <ol className="help-steps">
          <li>
            <strong>Turn on CC in the meeting itself.</strong> LLM IDE reads the
            platform&apos;s captions &mdash; they must be enabled first. Look for a
            &ldquo;CC&rdquo; or &ldquo;Captions&rdquo; button in the meeting toolbar.
          </li>
          <li>
            <strong>Make sure the meeting tab is active</strong> when you click
            Start. Chrome restricts extensions from talking to background tabs.
          </li>
          <li>
            <strong>Check the browser profile.</strong> The extension must be
            installed in the same Chrome profile that has the meeting open.
          </li>
          <li>
            <strong>Try refreshing the meeting tab</strong> and clicking Start
            again. This re-injects the content scripts.
          </li>
        </ol>
        <div className="help-card help-tip">
          <strong>How to verify:</strong> Go to Settings &gt; Diagnostics. If
          &ldquo;Captions received&rdquo; is incrementing, captions are flowing
          correctly. If it&apos;s stuck at 0, one of the steps above will fix it.
        </div>
      </div>

      <div className="help-card">
        <h4>The server won&apos;t connect</h4>
        <p>
          You see a red banner saying &ldquo;Can&apos;t reach the local
          server.&rdquo; Here&apos;s what to check:
        </p>
        <ol className="help-steps">
          <li>
            <strong>Is the server running?</strong> Open a terminal and run{' '}
            <code>node server.mjs</code>. You should see &ldquo;Server running on
            port 3456.&rdquo;
          </li>
          <li>
            <strong>Is the port in use?</strong> If another process is using port
            3456, the server can&apos;t start. Check with{' '}
            <code>lsof -i :3456</code> (Mac/Linux) or{' '}
            <code>netstat -an | findstr 3456</code> (Windows).
          </li>
          <li>
            <strong>Check your Node version.</strong> Run <code>node --version</code>.
            LLM IDE requires <strong>Node.js 20+</strong>.
          </li>
          <li>
            <strong>&ldquo;Server needs restart&rdquo;</strong> means the server is
            running but outdated. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the
            terminal, then run <code>node server.mjs</code> again.
          </li>
        </ol>
      </div>

      <div className="help-card">
        <h4>&ldquo;Extension context lost&rdquo; red banner</h4>
        <p>
          This looks alarming but it&apos;s completely normal. Chrome
          aggressively suspends extensions to save memory. When the extension
          wakes up, any content scripts that were running lose their connection.
        </p>
        <p>
          <strong>The fix is simple:</strong> Reload the meeting tab (press{' '}
          <kbd>F5</kbd> or <kbd>Cmd</kbd>+<kbd>R</kbd>) and click Start again.
          Your transcript up to that point is automatically saved, so you
          won&apos;t lose anything.
        </p>
      </div>

      <div className="help-card">
        <h4>Mic mode: poor transcription accuracy</h4>
        <p>If mic mode isn&apos;t picking up speech accurately, try these in order:</p>
        <ol className="help-steps">
          <li>
            <strong>Boost the volume</strong> &mdash; Go to Settings &gt; Volume
            Boost and slide it to 150&ndash;200%.
          </li>
          <li>
            <strong>Switch microphones</strong> &mdash; Go to Settings &gt;
            Microphone and pick your headset mic instead of the default.
          </li>
          <li>
            <strong>Use a headset</strong> &mdash; A close-to-mouth mic drastically
            improves recognition vs. a laptop&apos;s built-in mic across the room.
          </li>
          <li>
            <strong>Switch to a supported platform</strong> &mdash; If possible, use
            Google Meet, Teams, or Zoom. Their CC-based captions are far more
            accurate than browser speech recognition.
          </li>
        </ol>
      </div>

      <div className="help-card">
        <h4>Notes generation fails or times out</h4>
        <ol className="help-steps">
          <li>
            <strong>Is the server running?</strong> Check for a red banner at the
            top of the app. If it says &ldquo;Can&apos;t reach the local server,&rdquo;
            start the server first.
          </li>
          <li>
            <strong>Is Claude authenticated?</strong> In a terminal, run{' '}
            <code>claude auth</code> to check. The server uses your Claude CLI
            credentials.
          </li>
          <li>
            <strong>Is the transcript too long?</strong> Very long meetings
            (2+ hours) produce large transcripts. Try generating notes for just
            the first portion to confirm the server is working.
          </li>
          <li>
            <strong>Check the terminal output.</strong> The server logs errors
            in the terminal where you ran <code>node server.mjs</code>. Look
            for error messages there.
          </li>
        </ol>
      </div>

      <div className="help-card">
        <h4>The AI co-pilot isn&apos;t attaching</h4>
        <ul className="help-list">
          <li>Make sure the <strong>AI Assistant toggle</strong> is turned on in the
            Questions tab</li>
          <li>Recording must be <strong>active</strong> &mdash; the co-pilot only runs
            during a live session</li>
          <li>A <strong>plan</strong> must exist &mdash; the co-pilot auto-creates a
            stub plan when you start recording. If something goes wrong, click
            &ldquo;Attach anyway&rdquo; in the Questions tab</li>
        </ul>
      </div>

      <div className="help-card">
        <h4>Still stuck?</h4>
        <p>
          If none of the above solves your problem, here are two more things to
          check:
        </p>
        <ul className="help-list">
          <li><strong>Settings &gt; Diagnostics</strong> &mdash; Look at every field
            for clues about what&apos;s working and what isn&apos;t</li>
          <li><strong>Browser DevTools console</strong> &mdash; Right-click the side
            panel, choose &ldquo;Inspect,&rdquo; go to the Console tab. Errors
            prefixed with <code>[LLM IDE]</code> will tell you exactly
            what failed</li>
        </ul>
      </div>
    </div>
  );
}
