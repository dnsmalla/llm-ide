// Tests for unified note service
// Tests the separation of raw data sources from generated notes

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { NoteService } from '../services/note-service.ts';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

describe('NoteService', () => {
  const testRepo = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '.tmp-note-service-test'
  );

  async function cleanup() {
    try {
      await rm(testRepo, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  }

  before(async () => {
    await cleanup();
    await mkdir(testRepo, { recursive: true });
  });

  it('should create notes directory structure', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    // Create a test note to trigger directory creation
    await service.saveNote(
      'meeting',
      '2026-07-08-090000-test-meeting.docx',
      Buffer.from('test content'),
      {
        type: 'meeting',
        source: 'google-meet',
        title: 'Test Meeting',
        date: '2026-07-08T09:00:00Z',
        tags: [],
        participants: ['Alice', 'Bob'],
      }
    );

    // Verify directories exist
    const meetingsDir = path.join(testRepo, 'notes', 'meetings', '2026', '07');
    const fs = await import('node:fs/promises');
    assert.ok(await fs.access(meetingsDir).then(() => true).catch(() => false));
  });

  it('should save meeting notes to correct location', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    const metadata = await service.saveNote(
      'meeting',
      '2026-07-08-090000-test-meeting.docx',
      Buffer.from('Meeting content'),
      {
        type: 'meeting',
        source: 'google-meet',
        title: 'Test Meeting',
        date: '2026-07-08T09:00:00Z',
        tags: ['standup'],
        participants: ['Alice', 'Bob'],
      }
    );

    assert.equal(metadata.type, 'meeting');
    assert.equal(metadata.source, 'google-meet');
    assert.ok(metadata.path.startsWith('notes/meetings/'));
    assert.ok(metadata.tags.includes('standup'));
  });

  it('should save email notes to correct location', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    const metadata = await service.saveNote(
      'email',
      '2026-07-08-100000-test-email.md',
      Buffer.from('# Email\n\nContent'),
      {
        type: 'email',
        source: 'email',
        title: 'Test Email',
        date: '2026-07-08T10:00:00Z',
        tags: ['action-required'],
        rawFile: 'EmailInbox/2026/07/raw-email.txt',
        sourceHash: 'abc123',
      }
    );

    assert.equal(metadata.type, 'email');
    assert.equal(metadata.source, 'email');
    assert.ok(metadata.path.startsWith('notes/emails/'));
    assert.equal(metadata.rawFile, 'EmailInbox/2026/07/raw-email.txt');
  });

  it('should save document notes to correct location', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    const metadata = await service.saveNote(
      'document',
      '2026-07-07-140000-requirements-doc.md',
      Buffer.from('# Requirements\n\n...'),
      {
        type: 'document',
        source: 'box',
        title: 'Requirements Doc',
        date: '2026-07-07T14:00:00Z',
        tags: ['requirements'],
        rawFile: 'Documents/2026/07/requirements.pdf',
      }
    );

    assert.equal(metadata.type, 'document');
    assert.equal(metadata.source, 'box');
    assert.ok(metadata.path.startsWith('notes/documents/'));
    assert.equal(metadata.rawFile, 'Documents/2026/07/requirements.pdf');
  });

  it('should track which raw file generated which note', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    const metadata = await service.saveNote(
      'email',
      '2026-07-08-100000-test.md',
      Buffer.from('content'),
      {
        type: 'email',
        source: 'email',
        title: 'Test',
        date: '2026-07-08T10:00:00Z',
        tags: [],
        rawFile: 'EmailInbox/2026/07/raw.txt',
        sourceHash: 'sha256:abc123',
      }
    );

    assert.equal(metadata.rawFile, 'EmailInbox/2026/07/raw.txt');
    assert.equal(metadata.sourceHash, 'sha256:abc123');
  });

  it('should query notes by type', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    await service.saveNote(
      'meeting',
      'meeting.docx',
      Buffer.from('meeting'),
      {
        type: 'meeting',
        source: 'test',
        title: 'Meeting',
        date: '2026-07-08T09:00:00Z',
        tags: [],
      }
    );

    await service.saveNote(
      'email',
      'email.md',
      Buffer.from('email'),
      {
        type: 'email',
        source: 'test',
        title: 'Email',
        date: '2026-07-08T10:00:00Z',
        tags: [],
      }
    );

    const meetings = await service.queryNotes({ type: 'meeting' });
    const emails = await service.queryNotes({ type: 'email' });

    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].type, 'meeting');
    assert.equal(emails.length, 1);
    assert.equal(emails[0].type, 'email');
  });

  it('should query notes by date range', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    await service.saveNote(
      'meeting',
      'meeting1.docx',
      Buffer.from('meeting1'),
      {
        type: 'meeting',
        source: 'test',
        title: 'Meeting 1',
        date: '2026-07-01T09:00:00Z',
        tags: [],
      }
    );

    await service.saveNote(
      'meeting',
      'meeting2.docx',
      Buffer.from('meeting2'),
      {
        type: 'meeting',
        source: 'test',
        title: 'Meeting 2',
        date: '2026-07-08T09:00:00Z',
        tags: [],
      }
    );

    const july = await service.queryNotes({
      type: 'meeting',
      startDate: '2026-07-01T00:00:00Z',
      endDate: '2026-07-31T23:59:59Z',
    });

    assert.equal(july.length, 2);
  });

  it('should build unified index', async () => {
    await cleanup();
    const service = new NoteService(new URL(`file://${testRepo}/`));

    await service.saveNote('meeting', 'm.docx', Buffer.from('m'), {
      type: 'meeting',
      source: 'test',
      title: 'M',
      date: '2026-07-08T09:00:00Z',
      tags: [],
    });

    await service.saveNote('email', 'e.md', Buffer.from('e'), {
      type: 'email',
      source: 'test',
      title: 'E',
      date: '2026-07-08T10:00:00Z',
      tags: [],
    });

    const index = await service.loadIndex();

    assert.equal(index.notes.length, 2);
    assert.ok(index.notes.some(n => n.type === 'meeting'));
    assert.ok(index.notes.some(n => n.type === 'email'));
  });

  after(async () => {
    await cleanup();
  });
});
