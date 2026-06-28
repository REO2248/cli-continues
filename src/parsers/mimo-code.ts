import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { z } from 'zod';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionNotes,
  ToolCall,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { SqliteMessageRow, SqlitePartRow, SqliteProjectRow, SqliteSessionRow } from '../types/schemas.js';
import { countDiffStats, extractStdoutTail } from '../utils/diff.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import {
  extractExitCode,
  fetchSummary,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
} from '../utils/tool-summarizer.js';

/** Minimal typed interface for node:sqlite DatabaseSync */
interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

const MiMoCodeTokenUsageSchema = z
  .object({
    total: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache: z
      .object({
        read: z.number().optional(),
        write: z.number().optional(),
      })
      .optional(),
  })
  .optional();

const SqliteMsgDataSchema = z
  .object({
    role: z.string(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    cost: z.number().optional(),
    tokens: MiMoCodeTokenUsageSchema,
  })
  .passthrough();

type MiMoCodeTokenUsage = z.infer<typeof MiMoCodeTokenUsageSchema>;

const SqlitePartDataSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

function getMiMoCodeBaseDir(): string {
  if (process.env.MIMOCODE_HOME) {
    return path.join(process.env.MIMOCODE_HOME, 'data');
  }
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'mimocode')
    : path.join(homeDir(), '.local', 'share', 'mimocode');
}

function getMiMoCodeDbPaths(): string[] {
  if (process.env.MIMOCODE_DB) {
    const dbValue = process.env.MIMOCODE_DB;
    if (path.isAbsolute(dbValue)) {
      return [dbValue];
    }
    return [path.join(getMiMoCodeBaseDir(), dbValue)];
  }

  const baseDir = getMiMoCodeBaseDir();
  const defaultDbPath = path.join(baseDir, 'mimocode.db');
  const dbPaths: string[] = [];
  if (fs.existsSync(defaultDbPath)) {
    dbPaths.push(defaultDbPath);
  }

  try {
    const channelDbPaths = fs
      .readdirSync(baseDir)
      .filter((entry) => /^mimocode-[^.]+\.db$/u.test(entry))
      .map((entry) => path.join(baseDir, entry))
      .sort((left, right) => {
        const rightStat = fs.statSync(right);
        const leftStat = fs.statSync(left);
        return rightStat.mtimeMs - leftStat.mtimeMs || left.localeCompare(right);
      });
    for (const channelDbPath of channelDbPaths) {
      if (!dbPaths.includes(channelDbPath)) {
        dbPaths.push(channelDbPath);
      }
    }
  } catch (err) {
    logger.debug('mimo-code: failed to inspect channel SQLite DB variants', baseDir, err);
  }

  return dbPaths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function previewUnknown(value: unknown, maxLength = 160): string {
  if (typeof value === 'string') {
    return truncate(normalizeWhitespace(value), maxLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return truncate(normalizeWhitespace(JSON.stringify(value)), maxLength);
  } catch (err) {
    logger.debug('mimo-code: failed to stringify preview value', err);
    return '';
  }
}

function extractGenericPartPreview(
  partData: Record<string, unknown>,
  preferredKeys: string[] = ['text', 'title', 'summary', 'message', 'content', 'patch', 'diff'],
): string {
  for (const key of preferredKeys) {
    const preview = previewUnknown(partData[key]);
    if (preview) return preview;
  }
  const state = isRecord(partData.state) ? partData.state : undefined;
  if (state) {
    for (const key of ['output', 'error', 'title', 'input']) {
      const preview = previewUnknown(state[key]);
      if (preview) return preview;
    }
  }
  return '';
}

function normalizeToolArguments(input: unknown): Record<string, unknown> | undefined {
  if (isRecord(input)) return input;
  if (input === undefined) return undefined;
  return { value: input };
}

function renderToolPart(partData: Record<string, unknown>): {
  content: string;
  toolCall: ToolCall;
  summary: string;
  toolName: string;
  isError: boolean;
} | null {
  const toolName = typeof partData.tool === 'string' ? partData.tool : 'tool';
  const state = isRecord(partData.state) ? partData.state : {};
  const metadata = getRecordValue(state, 'metadata');
  const status = typeof state.status === 'string' ? state.status : undefined;
  const outputString = stringifyToolValue(state.output);
  const errorString = stringifyToolValue(state.error);
  const fullResult = outputString && outputString.length > 0 ? outputString : errorString;
  const resultPreview = fullResult ? previewUnknown(fullResult) : '';
  const argPreview = previewUnknown(state.input, 120);
  const exitCode = firstNumber(metadata, ['exit', 'exitCode']);
  const metadataIndicatesError = exitCode !== undefined && exitCode !== 0;

  const detailBits = [argPreview, resultPreview].filter(Boolean);
  const statusLabel = status ? ` ${status}` : '';
  const content = [`[tool:${toolName}${statusLabel}]`, ...detailBits].join(' ').trim();

  const summaryBits = [status, argPreview && `input=${argPreview}`, resultPreview && `result=${resultPreview}`].filter(
    Boolean,
  );
  const summary = summaryBits.length > 0 ? summaryBits.join(' | ') : 'invoked';
  let success: boolean | undefined;
  if (status === 'error' || metadataIndicatesError) success = false;
  else if (status === 'completed') success = true;

  const normalizedArguments = normalizeToolArguments(state.input);

  return {
    content,
    toolName,
    summary,
    isError: success === false,
    toolCall: {
      name: toolName,
      ...(typeof partData.callID === 'string' ? { id: partData.callID } : {}),
      ...(normalizedArguments ? { arguments: normalizedArguments } : {}),
      ...(fullResult ? { result: fullResult } : {}),
      ...(success !== undefined ? { success } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

function renderHighValuePart(partData: Record<string, unknown>): {
  content?: string;
  toolCall?: ToolCall;
} {
  switch (partData.type) {
    case 'text':
      return { content: typeof partData.text === 'string' ? partData.text : undefined };
    case 'reasoning': {
      const preview = extractGenericPartPreview(partData, ['text', 'summary', 'content']);
      return preview ? { content: `[reasoning] ${preview}` } : {};
    }
    case 'tool': {
      const rendered = renderToolPart(partData);
      return rendered ? { content: rendered.content, toolCall: rendered.toolCall } : {};
    }
    case 'patch':
    case 'compaction':
    case 'snapshot':
    case 'agent':
    case 'retry':
    case 'subtask': {
      const preview = extractGenericPartPreview(partData);
      return preview ? { content: `[${partData.type}] ${preview}` } : {};
    }
    default:
      return {};
  }
}

function getRecordValue(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringifyToolValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.debug('mimo-code: failed to stringify tool value', err);
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function extractPatchFiles(patchText: string): string[] {
  const files = new Set<string>();
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    const filePath = match[1]?.trim();
    if (filePath) files.add(filePath);
  }
  for (const match of patchText.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gmu)) {
    const filePath = match[1]?.trim();
    if (filePath && filePath !== '/dev/null') files.add(filePath);
  }
  return Array.from(files);
}

function trackPatchFiles(patchText: string, collector: SummaryCollector): string[] {
  const files = extractPatchFiles(patchText);
  for (const filePath of files) collector.trackFile(filePath);
  return files;
}

function trackPatchPart(partData: Record<string, unknown>, collector: SummaryCollector): void {
  const files = Array.isArray(partData.files)
    ? partData.files.filter((file): file is string => typeof file === 'string')
    : [];
  for (const filePath of files) collector.trackFile(filePath);

  const patchText =
    firstString(partData, ['patch', 'diff', 'text']) ||
    firstString(getRecordValue(partData, 'state'), ['patch', 'diff', 'output']);
  if (patchText) trackPatchFiles(patchText, collector);
}

function trackShellFileWrites(command: string, collector: SummaryCollector): void {
  const redirectMatch = command.match(/(?:^|\s)(?:>|>>)\s*['"]?([^\s;|&'"]+)/u);
  if (redirectMatch?.[1]) {
    collector.trackFile(redirectMatch[1]);
    return;
  }
  const teeMatch = command.match(/(?:^|\s)tee\s+(?:-[a-zA-Z]+\s+)*['"]?([^\s;|&'"]+)/u);
  if (teeMatch?.[1]) {
    collector.trackFile(teeMatch[1]);
    return;
  }
  const mvCpMatch = command.match(/^(?:mv|cp)\s+.+\s+['"]?([^\s;|&'"]+)$/u);
  if (mvCpMatch?.[1]) collector.trackFile(mvCpMatch[1]);
}

function summarizeMiMoCodeToolPart(partData: Record<string, unknown>, collector: SummaryCollector): void {
  if (partData.type === 'patch') {
    trackPatchPart(partData, collector);
    return;
  }

  if (partData.type !== 'tool' || typeof partData.tool !== 'string') return;

  const toolName = partData.tool;
  const state = getRecordValue(partData, 'state');
  const input = getRecordValue(state, 'input');
  const metadata = getRecordValue(state, 'metadata');
  const status = typeof state.status === 'string' ? state.status : undefined;
  const output = stringifyToolValue(state.output) ?? stringifyToolValue(state.error);
  const outputPreview = output ? truncate(normalizeWhitespace(output), 100) : undefined;

  switch (toolName) {
    case 'bash': {
      const command = firstString(input, ['command', 'cmd']);
      if (!command) return;

      const exitCode = firstNumber(metadata, ['exit', 'exitCode']) ?? extractExitCode(output);
      const errored = status === 'error' || (exitCode !== undefined && exitCode !== 0);
      const stdoutTail = output ? extractStdoutTail(output, 5) : undefined;

      const summary = errored ? `${shellSummary(command, output)} (error)` : shellSummary(command, output);
      collector.add('bash', summary, {
        data: {
          category: 'shell',
          command,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(stdoutTail && !errored ? { stdoutTail } : {}),
          ...(errored ? { errored, errorMessage: outputPreview } : {}),
        },
        isError: errored,
      });
      trackShellFileWrites(command, collector);
      break;
    }

    case 'glob': {
      const pattern = firstString(input, ['pattern', 'path', 'query']);
      const resultCount = firstNumber(metadata, ['count', 'resultCount']);
      collector.add(
        'glob',
        resultCount !== undefined ? `glob "${pattern}" - ${resultCount} matches` : globSummary(pattern),
        {
          data: { category: 'glob', pattern, ...(resultCount !== undefined ? { resultCount } : {}) },
        },
      );
      break;
    }

    case 'grep': {
      const pattern = firstString(input, ['pattern', 'query', 'regex']);
      const targetPath = firstString(input, ['path', 'include', 'filePath', 'file_path']);
      const matchCount = firstNumber(metadata, ['count', 'matchCount', 'matches']);
      collector.add('grep', grepSummary(pattern, targetPath), {
        data: {
          category: 'grep',
          pattern,
          ...(targetPath ? { targetPath } : {}),
          ...(matchCount !== undefined ? { matchCount } : {}),
        },
      });
      break;
    }

    case 'read': {
      const filePath = firstString(input, ['filePath', 'file_path', 'path']);
      if (!filePath) return;
      const summary = status ? `${fileSummary('read', filePath)} (${status})` : fileSummary('read', filePath);
      collector.add('read', summary, {
        data: { category: 'read', filePath },
      });
      break;
    }

    case 'write': {
      const filePath = firstString(input, ['filePath', 'file_path', 'path']);
      if (!filePath) return;
      collector.add('write', fileSummary('write', filePath), {
        data: { category: 'write', filePath },
        filePath,
        isWrite: true,
      });
      break;
    }

    case 'edit':
    case 'apply_patch': {
      const patchText =
        firstString(input, ['patchText', 'patch', 'diff']) || firstString(partData, ['patch', 'diff', 'text']);
      const files = patchText ? trackPatchFiles(patchText, collector) : [];
      const filePath = firstString(input, ['filePath', 'file_path', 'path']) || files[0] || '(multiple)';
      const diffStats = patchText ? countDiffStats(patchText) : undefined;
      collector.add(
        toolName,
        patchText ? `patch: ${truncate(files.slice(0, 3).join(', ') || filePath, 70)}` : fileSummary('edit', filePath),
        {
          data: {
            category: 'edit',
            filePath,
            ...(patchText ? { diff: patchText.slice(0, 2000) } : {}),
            ...(diffStats ? { diffStats } : {}),
          },
          filePath: filePath === '(multiple)' ? undefined : filePath,
          isWrite: filePath !== '(multiple)',
        },
      );
      break;
    }

    case 'web_search':
    case 'websearch': {
      const query = firstString(input, ['query', 'search']);
      collector.add(toolName, searchSummary(query), {
        data: { category: 'search', query, ...(outputPreview ? { resultPreview: outputPreview } : {}) },
      });
      break;
    }

    case 'web_fetch':
    case 'webfetch': {
      const url = firstString(input, ['url']);
      collector.add(toolName, fetchSummary(url), {
        data: { category: 'fetch', url, ...(outputPreview ? { resultPreview: outputPreview } : {}) },
      });
      break;
    }

    case 'codesearch': {
      const query = firstString(input, ['query', 'search']);
      collector.add('codesearch', searchSummary(query), {
        data: { category: 'search', query, ...(outputPreview ? { resultPreview: outputPreview } : {}) },
      });
      break;
    }

    case 'actor': {
      const desc = firstString(input, ['description', 'prompt', 'task']);
      collector.add('actor', desc ? `actor "${truncate(desc, 60)}"` : 'actor', {
        data: { category: 'task', description: desc ? truncate(desc, 60) : 'actor' },
      });
      break;
    }

    case 'skill': {
      const skillName = firstString(input, ['name']);
      collector.add('skill', skillName ? `skill "${skillName}"` : 'skill', {
        data: { category: 'mcp', toolName: 'skill', ...(skillName ? { params: skillName } : {}) },
      });
      break;
    }

    default: {
      const params = stringifyToolValue(input);
      collector.add(toolName, mcpSummary(toolName, params ? truncate(params, 100) : '', outputPreview), {
        data: {
          category: 'mcp',
          toolName,
          ...(params ? { params: truncate(params, 100) } : {}),
          ...(outputPreview ? { result: outputPreview } : {}),
        },
        isError: status === 'error',
      });
    }
  }
}

function hasSqliteDb(): boolean {
  return getMiMoCodeDbPaths().some((dbPath) => fs.existsSync(dbPath));
}

function openDb(dbPath: string): { db: SqliteDatabase; close: () => void } | null {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true }) as SqliteDatabase;
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('mimo-code: failed to open SQLite database', dbPath, err);
    return null;
  }
}

function parseSessionsFromSqlite(): UnifiedSession[] {
  const sessionsById = new Map<string, UnifiedSession>();

  for (const dbPath of getMiMoCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const rows = db
        .prepare(
          'SELECT id, project_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, time_created, time_updated FROM session ORDER BY time_updated DESC',
        )
        .all() as SqliteSessionRow[];

      const projectRows = db.prepare('SELECT id, worktree FROM project').all() as SqliteProjectRow[];
      const projectMap = new Map(projectRows.map((p: SqliteProjectRow) => [p.id, p.worktree]));

      for (const row of rows) {
        const cwd = row.directory || projectMap.get(row.project_id) || '';

        const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM message WHERE session_id = ?').get(row.id) as
          | { cnt: number }
          | undefined;

        let summary = row.title || '';
        if (!summary || summary.startsWith('New session')) {
          const firstMsg = db
            .prepare(
              'SELECT m.id, p.data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND m.data LIKE \'%"role":"user"%\' AND p.data LIKE \'%"type":"text"%\' ORDER BY m.time_created ASC LIMIT 1',
            )
            .get(row.id) as { id: string; data: string } | undefined;

          if (firstMsg) {
            try {
              const partData = JSON.parse(firstMsg.data);
              if (partData.text) {
                summary = partData.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
              }
            } catch (err) {
              logger.debug('mimo-code: failed to parse SQLite first-message part', row.id, err);
            }
          }
        }

        const nextSession: UnifiedSession = {
          id: row.id,
          source: 'mimo-code',
          cwd,
          repo: extractRepoFromCwd(cwd),
          lines: msgCount?.cnt ?? 0,
          bytes: 0,
          createdAt: new Date(row.time_created),
          updatedAt: new Date(row.time_updated),
          originalPath: dbPath,
          summary: summary?.slice(0, 60) || row.slug || undefined,
          model: undefined,
        };

        const existing = sessionsById.get(nextSession.id);
        if (!existing || existing.updatedAt.getTime() < nextSession.updatedAt.getTime()) {
          sessionsById.set(nextSession.id, nextSession);
        }
      }
    } catch (err) {
      logger.debug('mimo-code: SQLite session query failed', dbPath, err);
    } finally {
      close();
    }
  }

  return Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function parseMiMoCodeSessions(): Promise<UnifiedSession[]> {
  if (!hasSqliteDb()) return [];
  return parseSessionsFromSqlite();
}

function readAllMessages(sessionId: string): ConversationMessage[] {
  for (const dbPath of getMiMoCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const msgRows = db
        .prepare(
          'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC',
        )
        .all(sessionId) as SqliteMessageRow[];
      if (msgRows.length === 0) continue;

      const messages: ConversationMessage[] = [];

      for (const msgRow of msgRows) {
        const msgDataResult = SqliteMsgDataSchema.safeParse(JSON.parse(msgRow.data));
        if (!msgDataResult.success) continue;
        const role: 'user' | 'assistant' = msgDataResult.data.role === 'user' ? 'user' : 'assistant';

        const partRows = db
          .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC')
          .all(msgRow.id) as SqlitePartRow[];

        const contentParts: string[] = [];
        const toolCalls: NonNullable<ConversationMessage['toolCalls']> = [];
        for (const partRow of partRows) {
          let rawPartData: unknown;
          try {
            rawPartData = JSON.parse(partRow.data);
          } catch (err) {
            logger.debug('mimo-code: failed to parse SQLite part JSON', msgRow.id, err);
            continue;
          }

          const partDataResult = SqlitePartDataSchema.safeParse(rawPartData);
          if (!partDataResult.success) continue;
          const rendered = renderHighValuePart(partDataResult.data);
          if (rendered.content) contentParts.push(rendered.content);
          if (rendered.toolCall) toolCalls.push(rendered.toolCall);
        }

        const content = contentParts.join('\n').trim();
        if (content) {
          messages.push({
            role,
            content,
            timestamp: new Date(msgRow.time_created),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }
      }

      return messages;
    } catch (err) {
      logger.debug('mimo-code: SQLite message query failed for session', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return [];
}

function extractToolData(
  sessionId: string,
  config: VerbosityConfig,
): {
  summaries: ToolUsageSummary[];
  filesModified: string[];
} {
  for (const dbPath of getMiMoCodeDbPaths()) {
    const collector = new SummaryCollector(config);
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const sessionRow = db
        .prepare('SELECT summary_additions, summary_deletions, summary_files FROM session WHERE id = ?')
        .get(sessionId) as
        | {
            summary_additions: number | null;
            summary_deletions: number | null;
            summary_files: number | null;
          }
        | undefined;

      let foundSession = false;
      const added = sessionRow?.summary_additions ?? 0;
      const removed = sessionRow?.summary_deletions ?? 0;
      const files = sessionRow?.summary_files ?? 0;
      if (files > 0 || added > 0 || removed > 0) {
        collector.add('Edit', `${files} file(s) changed (+${added} -${removed})`, {
          data: {
            category: 'edit',
            filePath: `(${files} files)`,
            diffStats: { added, removed },
          },
        });
      }
      foundSession = Boolean(sessionRow);

      const partRows = db
        .prepare('SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC')
        .all(sessionId) as SqlitePartRow[];

      for (const partRow of partRows) {
        let rawPartData: unknown;
        try {
          rawPartData = JSON.parse(partRow.data);
        } catch (err) {
          logger.debug('mimo-code: failed to parse SQLite tool-summary part JSON', sessionId, err);
          continue;
        }

        const partDataResult = SqlitePartDataSchema.safeParse(rawPartData);
        if (!partDataResult.success) continue;
        summarizeMiMoCodeToolPart(partDataResult.data, collector);
      }

      if (foundSession || partRows.length > 0) {
        return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
      }
    } catch (err) {
      logger.debug('mimo-code: SQLite tool summary query failed', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return { summaries: [], filesModified: [] };
}

function addTokenUsage(notes: SessionNotes, tokens: MiMoCodeTokenUsage): void {
  if (!tokens) return;
  notes.tokenUsage = {
    input: (notes.tokenUsage?.input ?? 0) + (tokens.input ?? 0),
    output: (notes.tokenUsage?.output ?? 0) + (tokens.output ?? 0),
  };
  if (tokens.reasoning && tokens.reasoning > 0) {
    notes.thinkingTokens = (notes.thinkingTokens ?? 0) + tokens.reasoning;
  }
  if (tokens.cache) {
    notes.cacheTokens = {
      read: (notes.cacheTokens?.read ?? 0) + (tokens.cache.read ?? 0),
      creation: (notes.cacheTokens?.creation ?? 0) + (tokens.cache.write ?? 0),
    };
  }
}

function addReasoningHighlight(partData: Record<string, unknown>, reasoning: string[], maxHighlights: number): void {
  if (reasoning.length >= maxHighlights || partData.type !== 'reasoning') return;
  const text = firstString(partData, ['text', 'summary', 'content']);
  if (text.length <= 20) return;
  const firstLine = text.split(/[.\n]/u)[0]?.trim();
  if (firstLine) reasoning.push(truncate(firstLine, 200));
}

function extractSessionNotes(sessionId: string): SessionNotes | undefined {
  for (const dbPath of getMiMoCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const notes: SessionNotes = {};
    const reasoning: string[] = [];
    const { db, close } = handle;

    try {
      const msgRows = db
        .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
        .all(sessionId) as Array<{ id: string; time_created: number; data: string }>;
      if (msgRows.length === 0) continue;

      for (const row of msgRows) {
        let rawMsgData: unknown;
        try {
          rawMsgData = JSON.parse(row.data);
        } catch (err) {
          logger.debug('mimo-code: failed to parse SQLite message notes JSON', dbPath, row.id, err);
          continue;
        }

        const msgDataResult = SqliteMsgDataSchema.safeParse(rawMsgData);
        if (!msgDataResult.success) continue;
        const msgData = msgDataResult.data;

        if (msgData.role === 'assistant' && msgData.modelID && !notes.model) {
          notes.model = msgData.modelID;
        }
        addTokenUsage(notes, msgData.tokens);
      }

      const firstCreated = msgRows[0]?.time_created;
      const lastCreated = msgRows[msgRows.length - 1]?.time_created;
      if (firstCreated !== undefined && lastCreated !== undefined && lastCreated >= firstCreated) {
        notes.activeTimeMs = lastCreated - firstCreated;
      }

      const partRows = db
        .prepare(
          'SELECT data FROM part WHERE session_id = ? AND data LIKE \'%"type":"reasoning"%\' ORDER BY time_created ASC, id ASC',
        )
        .all(sessionId) as SqlitePartRow[];
      for (const partRow of partRows) {
        let rawPartData: unknown;
        try {
          rawPartData = JSON.parse(partRow.data);
        } catch (err) {
          logger.debug('mimo-code: failed to parse SQLite reasoning part JSON', dbPath, sessionId, err);
          continue;
        }

        const partDataResult = SqlitePartDataSchema.safeParse(rawPartData);
        if (partDataResult.success) {
          addReasoningHighlight(partDataResult.data, reasoning, 10);
        }
      }

      if (reasoning.length > 0) notes.reasoning = reasoning;
      const sessionRow = db.prepare('SELECT project_id, slug, version FROM session WHERE id = ?').get(sessionId) as
        | { project_id?: string; slug?: string; version?: string }
        | undefined;
      if (sessionRow) {
        notes.sourceMetadata = {
          ...(sessionRow.slug ? { slug: sessionRow.slug } : {}),
          ...(sessionRow.version ? { version: sessionRow.version } : {}),
          ...(sessionRow.project_id ? { projectId: sessionRow.project_id } : {}),
        };
      }
      return Object.keys(notes).length > 0 ? notes : undefined;
    } catch (err) {
      logger.debug('mimo-code: failed to extract SQLite session notes', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return undefined;
}

function extractPendingTasks(sessionId: string): string[] {
  for (const dbPath of getMiMoCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const rows = db
        .prepare('SELECT content, status FROM todo WHERE session_id = ? ORDER BY position ASC')
        .all(sessionId) as Array<{ content: string; status: string }>;
      return rows.filter((task) => task.status !== 'completed').map((task) => task.content);
    } catch (err) {
      logger.debug('mimo-code: failed to extract SQLite pending tasks', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return [];
}

export async function extractMiMoCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const recentMessages = readAllMessages(session.id);
  const toolData = extractToolData(session.id, resolvedConfig);
  const filesModified = toolData.filesModified;
  const pendingTasks = extractPendingTasks(session.id);
  const sessionNotes = extractSessionNotes(session.id);

  const trimmed = trimMessages(recentMessages, resolvedConfig.recentMessages);
  const timeline = buildMiMoCodeTimeline(trimmed, resolvedConfig.handoff.timelineWindow);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolData.summaries,
    sessionNotes,
    resolvedConfig,
    'inline',
    timeline,
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries: toolData.summaries,
    ...(sessionNotes ? { sessionNotes } : {}),
    timeline,
    markdown,
  };
}

function buildMiMoCodeTimeline(messages: ConversationMessage[], timelineWindow?: number): SessionEvent[] {
  type Cluster = { message: SessionEvent; tools: SessionEvent[] };
  const clusters: Cluster[] = [];
  let sequence = 0;

  for (const message of messages) {
    const messageEvent: SessionEvent = {
      kind: 'message',
      sequence: sequence++,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      sourceId: message.sourceId,
    };
    const toolEvents: SessionEvent[] = [];
    for (const toolCall of message.toolCalls ?? []) {
      toolEvents.push({
        kind: 'tool_call',
        sequence: sequence++,
        timestamp: message.timestamp,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        status: toolCall.success === undefined ? undefined : toolCall.success ? 'success' : 'error',
        arguments: toolCall.arguments,
        result: toolCall.result,
        metadata: toolCall.metadata,
      });
    }
    clusters.push({ message: messageEvent, tools: toolEvents });
  }

  const totalEvents = clusters.reduce((sum, cluster) => sum + 1 + cluster.tools.length, 0);

  if (timelineWindow !== undefined && timelineWindow > 0 && totalEvents > timelineWindow) {
    const messageCount = clusters.length;
    if (messageCount > timelineWindow) {
      const tail = clusters.slice(-timelineWindow);
      tail.forEach((cluster) => {
        cluster.tools = [];
      });
      clusters.length = 0;
      clusters.push(...tail);
      const trimmedEvents: SessionEvent[] = [];
      for (const cluster of clusters) trimmedEvents.push(cluster.message);
      return trimmedEvents;
    }
    let toolBudget = Math.max(0, timelineWindow - messageCount);
    const allowed: number[] = clusters.map(() => 0);
    for (let i = clusters.length - 1; i >= 0 && toolBudget > 0; i--) {
      const take = Math.min(toolBudget, clusters[i].tools.length);
      allowed[i] = take;
      toolBudget -= take;
    }
    for (let i = 0; i < clusters.length; i++) {
      clusters[i].tools = allowed[i] > 0 ? clusters[i].tools.slice(-allowed[i]) : [];
    }
  }

  const events: SessionEvent[] = [];
  for (const cluster of clusters) {
    events.push(cluster.message);
    for (const tool of cluster.tools) events.push(tool);
  }
  return events;
}
