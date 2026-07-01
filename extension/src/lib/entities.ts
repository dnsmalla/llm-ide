// Structured signals extracted from a meeting transcript.  These types
// must stay in sync with the server's /extract-entities validation.

export interface ExtractedEntities {
  actions: Array<{
    id: string;
    text: string;
    owner: string | null;
    due: string | null;
    quote: string;
    status: 'open' | 'in_progress' | 'done';
    meetingId?: string;
    createdAt: string;
  }>;
  decisions: Array<{
    id: string;
    text: string;
    participants: string[];
    quote: string;
    meetingId?: string;
    createdAt: string;
  }>;
  blockers: Array<{
    id: string;
    text: string;
    severity: 'low' | 'med' | 'high';
    quote: string;
    meetingId?: string;
    createdAt: string;
  }>;
}
