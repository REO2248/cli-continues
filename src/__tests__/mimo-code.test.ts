import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

interface MiMoCodeFixture {
  dbPath: string;
  root: string;
  cleanup: () => void;
}

interface SeedOptions {
  sessionId?: string;
  sessionTitle?: string;
  summaryAdditions?: number | null;
  summaryDeletions?: number | null;
  summaryFiles?: number | null;
  messages?: Array<{
    id: string;
    role: 'user' | 'assistant';
    timeCreatedOffsetMs: number;
    data?: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
  todos?: Array<{
    content: string;
    status: string;
    position: number;
  }>;
}

const originalEnv = {
  MIMOCODE_DB: process.env.MIMOCODE_DB,
  MIMOCODE_HOME: process.env.MIMOCODE_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function createMiMoCodeSqliteFixture(dbFileName: string, options: SeedOptions = {}): MiMoCodeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-code-parser-'));
  const dbDir = path.join(root, 'db');
  const dbPath = path.join(dbDir, dbFileName);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  const sessionId = options.sessionId ?? 'ses_test_mimo';
  const summaryAdditions = options.summaryAdditions ?? null;
  const summaryDeletions = options.summaryDeletions ?? null;
  const summaryFiles = options.summaryFiles ?? null;
  const messages = options.messages ?? [
    {
      id: 'msg_user_1',
      role: 'user' as const,
      timeCreatedOffsetMs: -3_000,
      parts: [{ type: 'text', text: 'Investigate login.ts failures' }],
    },
    {
      id: 'msg_assistant_1',
      role: 'assistant' as const,
      timeCreatedOffsetMs: -2_000,
      parts: [{ type: 'text', text: 'The validation branch is missing.' }],
    },
  ];

  db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('proj_mimo_test', '/home/user/project');
  db.prepare(
    `INSERT INTO session (
      id,
      project_id,
      slug,
      directory,
      title,
      version,
      summary_additions,
      summary_deletions,
      summary_files,
      time_created,
      time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    'proj_mimo_test',
    'test-mimo-session',
    '/home/user/project',
    options.sessionTitle ?? 'New session',
    '1.0.0',
    summaryAdditions,
    summaryDeletions,
    summaryFiles,
    now - 5_000,
    now,
  );

  for (const message of messages) {
    const timeCreated = now + message.timeCreatedOffsetMs;
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
      message.id,
      sessionId,
      timeCreated,
      JSON.stringify({ role: message.role, time: { created: timeCreated }, ...message.data }),
    );

    message.parts.forEach((part, index) => {
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        `${message.id}_part_${index + 1}`,
        message.id,
        sessionId,
        timeCreated + index,
        JSON.stringify(part),
      );
    });
  }

  for (const todo of options.todos ?? []) {
    db.prepare('INSERT INTO todo (session_id, content, status, position) VALUES (?, ?, ?, ?)').run(
      sessionId,
      todo.content,
      todo.status,
      todo.position,
    );
  }

  db.close();

  return {
    dbPath,
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createMiMoCodeChannelSqliteFixture(dbFileName: string, options: SeedOptions = {}): MiMoCodeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-code-parser-channel-'));
  const xdgDataHome = path.join(root, 'xdg-data');
  const dbDir = path.join(xdgDataHome, 'mimocode');
  const dbPath = path.join(dbDir, dbFileName);
  fs.mkdirSync(dbDir, { recursive: true });

  const fixture = createMiMoCodeSqliteFixture(dbFileName, options);
  fs.copyFileSync(fixture.dbPath, dbPath);
  fixture.cleanup();

  return {
    dbPath,
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function importMiMoCodeParser() {
  vi.resetModules();
  return import('../parsers/mimo-code.js');
}

afterEach(() => {
  process.env.MIMOCODE_DB = originalEnv.MIMOCODE_DB;
  process.env.MIMOCODE_HOME = originalEnv.MIMOCODE_HOME;
  process.env.XDG_DATA_HOME = originalEnv.XDG_DATA_HOME;
  vi.resetModules();
});

describe('MiMo-Code parser', () => {
  it('discovers channel-specific SQLite DB filenames when MIMOCODE_DB is unset', async () => {
    const fixture = createMiMoCodeChannelSqliteFixture('mimocode-preview.db', {
      sessionId: 'ses_channel',
      sessionTitle: 'Preview channel session',
    });

    try {
      process.env.XDG_DATA_HOME = path.join(fixture.root, 'xdg-data');
      delete process.env.MIMOCODE_DB;
      delete process.env.MIMOCODE_HOME;

      const { parseMiMoCodeSessions } = await importMiMoCodeParser();
      const sessions = await parseMiMoCodeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: 'ses_channel',
        originalPath: fixture.dbPath,
        summary: 'Preview channel session',
        source: 'mimo-code',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('prefers MIMOCODE_DB when resolving the SQLite database path (absolute)', async () => {
    const fixture = createMiMoCodeSqliteFixture('mimocode-preview.db', {
      sessionId: 'ses_override',
      sessionTitle: 'Override DB session',
    });

    try {
      process.env.XDG_DATA_HOME = path.join(fixture.root, 'xdg-data');
      process.env.MIMOCODE_DB = fixture.dbPath;
      delete process.env.MIMOCODE_HOME;

      const { parseMiMoCodeSessions } = await importMiMoCodeParser();
      const sessions = await parseMiMoCodeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: 'ses_override',
        originalPath: fixture.dbPath,
        summary: 'Override DB session',
        source: 'mimo-code',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('resolves relative MIMOCODE_DB under the data directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-code-parser-relative-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const fixture = createMiMoCodeSqliteFixture('relative-test.db', {
      sessionId: 'ses_relative',
      sessionTitle: 'Relative DB session',
    });

    try {
      fs.copyFileSync(fixture.dbPath, path.join(dataDir, 'relative-test.db'));
      process.env.MIMOCODE_HOME = root;
      process.env.MIMOCODE_DB = 'relative-test.db';
      delete process.env.XDG_DATA_HOME;

      const { parseMiMoCodeSessions } = await importMiMoCodeParser();
      const sessions = await parseMiMoCodeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: 'ses_relative',
        summary: 'Relative DB session',
        source: 'mimo-code',
      });
    } finally {
      fixture.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads from MIMOCODE_HOME/data/mimocode.db when set', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-code-parser-home-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const fixture = createMiMoCodeSqliteFixture('mimocode.db', {
      sessionId: 'ses_home',
      sessionTitle: 'MIMOCODE_HOME session',
    });

    try {
      fs.copyFileSync(fixture.dbPath, path.join(dataDir, 'mimocode.db'));
      process.env.MIMOCODE_HOME = root;
      delete process.env.MIMOCODE_DB;
      delete process.env.XDG_DATA_HOME;

      const { parseMiMoCodeSessions } = await importMiMoCodeParser();
      const sessions = await parseMiMoCodeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: 'ses_home',
        summary: 'MIMOCODE_HOME session',
        source: 'mimo-code',
      });
    } finally {
      fixture.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers sessions from channel DBs even when the default mimocode.db also exists', async () => {
    const defaultFixture = createMiMoCodeSqliteFixture('mimocode.db', {
      sessionId: 'ses_default',
      sessionTitle: 'Default DB session',
    });
    const channelFixture = createMiMoCodeChannelSqliteFixture('mimocode-preview.db', {
      sessionId: 'ses_preview',
      sessionTitle: 'Preview DB session',
    });

    try {
      const mergedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-code-parser-merged-'));
      const xdgDataHome = path.join(mergedRoot, 'xdg-data');
  const dbDir = path.join(xdgDataHome, 'mimocode');
      fs.mkdirSync(dbDir, { recursive: true });
      fs.copyFileSync(defaultFixture.dbPath, path.join(dbDir, 'mimocode.db'));
      fs.copyFileSync(channelFixture.dbPath, path.join(dbDir, 'mimocode-preview.db'));

      process.env.XDG_DATA_HOME = xdgDataHome;
      process.env.MIMOCODE_DB = '';
      delete process.env.MIMOCODE_HOME;

      const { parseMiMoCodeSessions } = await importMiMoCodeParser();
      const sessions = await parseMiMoCodeSessions();

      expect(sessions.map((session) => session.id)).toContain('ses_default');
      expect(sessions.map((session) => session.id)).toContain('ses_preview');
    } finally {
      defaultFixture.cleanup();
      channelFixture.cleanup();
    }
  });

  it('keeps high-value non-text SQLite parts in extracted recent messages', async () => {
    const fixture = createMiMoCodeSqliteFixture('mimocode.db', {
      sessionId: 'ses_parts',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Inspect the failing auth flow' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [
            { type: 'reasoning', text: 'Need to inspect login.ts and confirm the guard path.' },
            {
              type: 'tool',
              callID: 'call_read_1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { file_path: 'src/login.ts' },
                output: 'Guard returns early without validating the token.',
              },
            },
          ],
        },
      ],
    });

    try {
      process.env.MIMOCODE_DB = fixture.dbPath;
      delete process.env.MIMOCODE_HOME;
      delete process.env.XDG_DATA_HOME;

      const { parseMiMoCodeSessions, extractMiMoCodeContext } = await importMiMoCodeParser();
      const [session] = await parseMiMoCodeSessions();
      const context = await extractMiMoCodeContext(session);
      const assistantMessages = context.recentMessages.filter((message) => message.role === 'assistant');

      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toContain('Need to inspect login.ts');
      expect(assistantMessages[0].content).toContain('read');
      expect(assistantMessages[0].toolCalls).toEqual([
        {
          id: 'call_read_1',
          name: 'read',
          arguments: { file_path: 'src/login.ts' },
          result: 'Guard returns early without validating the token.',
          success: true,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it('extracts tool summaries with MiMo-style tool names', async () => {
    const fixture = createMiMoCodeSqliteFixture('mimocode.db', {
      sessionId: 'ses_tools',
      summaryAdditions: 5,
      summaryDeletions: 2,
      summaryFiles: 1,
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Fix auth and search docs' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [
            {
              type: 'tool',
              callID: 'call_read_1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { file_path: 'src/login.ts' },
                output: 'Read src/login.ts successfully.',
              },
            },
            {
              type: 'tool',
              callID: 'call_bash_1',
              tool: 'bash',
              state: {
                status: 'error',
                input: { command: 'pnpm test auth' },
                error: 'Command failed with exit code 1.',
              },
            },
            {
              type: 'tool',
              callID: 'call_websearch_1',
              tool: 'websearch',
              state: {
                status: 'completed',
                input: { query: 'node.js sqlite' },
                output: 'Search results',
              },
            },
            {
              type: 'tool',
              callID: 'call_webfetch_1',
              tool: 'webfetch',
              state: {
                status: 'completed',
                input: { url: 'https://example.com/docs' },
                output: 'Fetched page content.',
              },
            },
          ],
        },
      ],
    });

    try {
      process.env.MIMOCODE_DB = fixture.dbPath;
      delete process.env.MIMOCODE_HOME;
      delete process.env.XDG_DATA_HOME;

      const { parseMiMoCodeSessions, extractMiMoCodeContext } = await importMiMoCodeParser();
      const [session] = await parseMiMoCodeSessions();
      const context = await extractMiMoCodeContext(session);
      const summaries = new Map(context.toolSummaries.map((summary) => [summary.name, summary]));

      expect(summaries.get('read')?.samples[0]?.summary).toContain('completed');
      expect(summaries.get('bash')?.samples[0]?.summary).toContain('error');
      expect(summaries.get('bash')?.errorCount).toBe(1);
      expect(summaries.get('websearch')?.samples[0]?.data?.category).toBe('search');
      expect(summaries.get('webfetch')?.samples[0]?.data?.category).toBe('fetch');
      expect(summaries.get('Edit')?.samples[0]?.summary).toContain('1 file(s) changed (+5 -2)');
    } finally {
      fixture.cleanup();
    }
  });

  it('extracts rich SQLite session notes, modified files, and pending tasks', async () => {
    const patchText = `*** Begin Patch
*** Update File: src/auth.ts
 @@
 -return false;
 +return validateToken(token);
 *** End Patch`;
    const fixture = createMiMoCodeSqliteFixture('mimocode.db', {
      sessionId: 'ses_rich',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -4_000,
          parts: [{ type: 'text', text: 'Fix auth validation and preserve context' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -3_000,
          data: {
            modelID: 'mimo-auto',
            tokens: {
              input: 200,
              output: 80,
              reasoning: 10,
              cache: { read: 5, write: 2 },
            },
          },
          parts: [
            { type: 'reasoning', text: 'Need to inspect the auth guard before patching.' },
            {
              type: 'tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'printf ok > generated.txt' },
                output: 'ok',
              },
            },
            {
              type: 'tool',
              tool: 'apply_patch',
              state: {
                status: 'completed',
                input: { patch: patchText },
                output: 'Done',
              },
            },
          ],
        },
      ],
      todos: [{ content: 'Re-run auth tests', status: 'pending', position: 1 }],
    });

    try {
      process.env.MIMOCODE_DB = fixture.dbPath;
      delete process.env.MIMOCODE_HOME;
      delete process.env.XDG_DATA_HOME;

      const { parseMiMoCodeSessions, extractMiMoCodeContext } = await importMiMoCodeParser();
      const [session] = await parseMiMoCodeSessions();
      const context = await extractMiMoCodeContext(session);
      const summaries = new Map(context.toolSummaries.map((summary) => [summary.name, summary]));

      expect(context.sessionNotes).toMatchObject({
        model: 'mimo-auto',
        tokenUsage: { input: 200, output: 80 },
        cacheTokens: { read: 5, creation: 2 },
        thinkingTokens: 10,
      });
      expect(context.sessionNotes?.reasoning?.[0]).toContain('Need to inspect the auth guard');
      expect(context.filesModified).toEqual(expect.arrayContaining(['generated.txt', 'src/auth.ts']));
      expect(context.pendingTasks).toEqual(['Re-run auth tests']);
      expect(summaries.get('bash')?.samples[0]?.data).toMatchObject({
        category: 'shell',
        command: 'printf ok > generated.txt',
      });
      expect(summaries.get('apply_patch')?.samples[0]?.data).toMatchObject({
        category: 'edit',
        filePath: 'src/auth.ts',
      });
      expect(context.markdown).toContain('Tokens Used');
    } finally {
      fixture.cleanup();
    }
  });

  it('marks completed bash tools with non-zero exit metadata as failed', async () => {
    const fixture = createMiMoCodeSqliteFixture('mimocode.db', {
      sessionId: 'ses_exit',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Run the failing command' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [
            {
              type: 'tool',
              callID: 'call_bash_exit',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'pnpm test failing' },
                output: 'exit code 1\nTests failed',
                metadata: { exit: 1, truncated: false },
              },
            },
            {
              type: 'text',
              text: 'The command failed because the assertion is wrong.',
            },
          ],
        },
      ],
    });

    try {
      process.env.MIMOCODE_DB = fixture.dbPath;
      delete process.env.MIMOCODE_HOME;
      delete process.env.XDG_DATA_HOME;

      const { parseMiMoCodeSessions, extractMiMoCodeContext } = await importMiMoCodeParser();
      const [session] = await parseMiMoCodeSessions();
      const context = await extractMiMoCodeContext(session);
      const assistant = context.recentMessages.find((message) => message.role === 'assistant');
      const bashSummary = context.toolSummaries.find((summary) => summary.name === 'bash');

      expect(assistant?.toolCalls?.[0]).toMatchObject({
        id: 'call_bash_exit',
        name: 'bash',
        success: false,
        metadata: { exit: 1, truncated: false },
      });
      expect(context.sessionNotes?.sourceMetadata).toMatchObject({
        slug: 'test-mimo-session',
        version: '1.0.0',
        projectId: 'proj_mimo_test',
      });
      expect(bashSummary?.errorCount).toBe(1);
      expect(bashSummary?.samples[0].data).toMatchObject({
        category: 'shell',
        command: 'pnpm test failing',
        exitCode: 1,
        errored: true,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('registry adapter produces mimo run --session <id> for native resume', async () => {
    const { adapters } = await import('../parsers/registry.js');
    const adapter = adapters['mimo-code'];

    expect(adapter).toBeDefined();
    expect(adapter.name).toBe('mimo-code');
    expect(adapter.label).toBe('MiMo Code');
    expect(adapter.binaryName).toBe('mimo');

    const mockSession = {
      id: 'ses_test123',
      source: 'mimo-code' as const,
      cwd: '/tmp',
      lines: 1,
      bytes: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: '/tmp/test.db',
    };

    expect(adapter.nativeResumeArgs(mockSession)).toEqual(['run', '--session', 'ses_test123']);
    expect(adapter.crossToolArgs('hello world', '/tmp')).toEqual(['run', 'hello world']);
    expect(adapter.resumeCommandDisplay(mockSession)).toBe('mimo run --session ses_test123');
  });
});
