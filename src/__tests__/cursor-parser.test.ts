import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeCursorHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-parser-'));
  tempDirs.push(dir);
  return dir;
}

function writeCursorTranscript(
  home: string,
  slug: string,
  sessionId: string,
  rows: unknown[],
  fileName = `${sessionId}.jsonl`,
): string {
  const dir = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

function writeFlatCursorTranscript(home: string, slug: string, sessionId: string, rows: unknown[]): string {
  const dir = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

function writeCursorRepoJson(home: string, slug: string, data: unknown): void {
  const dir = path.join(home, '.cursor', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(data), 'utf8');
}

async function loadCursorParser(home: string): Promise<typeof import('../parsers/cursor.js')> {
  vi.resetModules();
  vi.doMock('../utils/parser-helpers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/parser-helpers.js')>();
    return {
      ...actual,
      homeDir: () => home,
    };
  });
  return import('../parsers/cursor.js');
}

afterEach(() => {
  vi.doUnmock('../utils/parser-helpers.js');
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('cursor parser confidence warnings', () => {
  it('records transcript completeness as a fidelity warning without fabricating tool results', async () => {
    const home = makeCursorHome();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const originalPath = writeCursorTranscript(home, 'Users-test-project', sessionId, [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Review auth flow' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I checked the transcript.' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
    ]);

    const { extractCursorContext } = await loadCursorParser(home);
    const context = await extractCursorContext({
      id: sessionId,
      source: 'cursor',
      cwd: '/Users/test/project',
      repo: 'test/project',
      lines: 2,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T00:00:00.000Z'),
      updatedAt: new Date('2026-04-15T00:00:00.000Z'),
      originalPath,
      summary: 'Review auth flow',
    } satisfies UnifiedSession);

    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Cursor transcript completeness warning')]),
    );
    expect(context.sessionNotes?.reasoning).toBeUndefined();
    expect(context.markdown).not.toContain('Cursor transcript completeness warning');

    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'Bash');
    expect(bashSummary?.samples[0]?.summary).toBe('$ pnpm test');
    const bashData = bashSummary?.samples[0]?.data;
    expect(bashData?.category).toBe('shell');
    if (bashData?.category === 'shell') {
      expect(bashData.exitCode).toBeUndefined();
      expect(bashData.stdoutTail).toBeUndefined();
      expect(bashData.errorMessage).toBeUndefined();
    }
  });
});

describe('cursor parser hardening', () => {
  it('discovers nested transcript.jsonl and flat Cursor CLI transcript layouts', async () => {
    const home = makeCursorHome();
    const nestedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const flatId = 'ffffffff-1111-2222-3333-444444444444';
    writeCursorRepoJson(home, 'Users-test-project', { workspace: '/tmp/cursor-project' });
    writeCursorTranscript(
      home,
      'Users-test-project',
      nestedId,
      [
        {
          role: 'user',
          message: {
            content: [{ type: 'text', text: 'Nested transcript keeps parent id' }],
          },
        },
      ],
      'transcript.jsonl',
    );
    writeFlatCursorTranscript(home, 'Users-test-project', flatId, [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Flat transcript should also be discovered' }],
        },
      },
    ]);

    const { parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();

    expect(sessions.map((session) => session.id)).toEqual(expect.arrayContaining([nestedId, flatId]));
    expect(sessions.find((session) => session.id === nestedId)?.cwd).toBe('/tmp/cursor-project');
    expect(sessions.find((session) => session.id === nestedId)?.summary).toBe('Nested transcript keeps parent id');
    expect(sessions.find((session) => session.id === flatId)?.summary).toBe(
      'Flat transcript should also be discovered',
    );
  });

  it('extracts context from string content, user_query wrappers, tools, and malformed records without throwing', async () => {
    const home = makeCursorHome();
    const sessionId = '99999999-8888-7777-6666-555555555555';
    const originalPath = writeCursorTranscript(home, 'Users-test-project', sessionId, [
      {
        role: 'system',
        message: {
          content: [{ type: 'text', text: 'hidden prompt' }],
        },
      },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Apr 26, 2026, 9:53 PM (UTC-4)</timestamp>\n<user_query>\nFix auth\n</user_query>',
            },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: '<system_reminder>not human text</system_reminder>' }],
        },
      },
      {
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
        message: {
          content: [
            { type: 'text', text: 'I will inspect the file.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Edit',
              input: {
                file_path: 'src/auth.ts',
                old_string: 'bad',
                new_string: 'good',
              },
            },
          ],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: 'String content should become assistant text',
        },
      },
      {
        role: 'assistant',
        message: {},
      },
    ]);
    fs.appendFileSync(originalPath, '{"broken":\n', 'utf8');

    const { extractCursorContext, parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();
    const context = await extractCursorContext({
      id: sessionId,
      source: 'cursor',
      cwd: '/Users/test/project',
      repo: 'test/project',
      lines: fs.readFileSync(originalPath, 'utf8').split('\n').length - 1,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T00:00:00.000Z'),
      updatedAt: new Date('2026-04-15T00:00:00.000Z'),
      originalPath,
      summary: 'Fix auth',
    } satisfies UnifiedSession);

    expect(sessions.find((session) => session.id === sessionId)?.summary).toBe('Fix auth');
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Fix auth',
      'I will inspect the file.',
      'String content should become assistant text',
    ]);
    expect(context.recentMessages[0].timestamp?.toISOString()).toBe('2026-04-27T01:53:00.000Z');
    expect(context.filesModified).toContain('src/auth.ts');
    expect(context.sessionNotes?.model).toBe('claude-sonnet-4');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 10, output: 5 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 2, read: 3 });
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Cursor transcript completeness warning')]),
    );
    expect(context.sessionNotes?.reasoning).toBeUndefined();
    expect(context.toolSummaries.find((summary) => summary.name === 'Bash')?.samples[0]?.summary).toBe('$ pnpm test');
    expect(context.markdown).not.toContain('system_reminder');
    expect(context.markdown).not.toContain('local agent-transcripts are partial exports');
  });
});
