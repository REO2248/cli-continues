import { describe, expect, it } from 'vitest';
import { adapters } from '../parsers/registry.js';
import type { UnifiedSession } from '../types/index.js';
import { getDefaultHandoffInitArgs, getResumeCommand, resolveCrossToolForwarding } from '../utils/resume.js';

describe('cross-tool forwarding', () => {
  it('enforces codex precedence yolo > full-auto > sandbox', () => {
    const resolved = resolveCrossToolForwarding('codex', {
      rawArgs: ['--yolo', '--full-auto', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    });

    expect(resolved.mappedArgs).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(resolved.passthroughArgs).toEqual([]);
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });

  it('passes unmapped flags through unchanged', () => {
    const resolved = resolveCrossToolForwarding('claude', {
      rawArgs: ['--search', '--unknown-flag', 'value'],
    });

    expect(resolved.mappedArgs).toEqual([]);
    expect(resolved.passthroughArgs).toEqual(['--search', '--unknown-flag', 'value']);
    expect(resolved.extraArgs).toEqual(['--search', '--unknown-flag', 'value']);
  });

  it('keeps unsupported known flags as passthrough when target has no mapping', () => {
    const resolved = resolveCrossToolForwarding('claude', {
      rawArgs: ['--full-auto'],
    });

    expect(resolved.mappedArgs).toEqual([]);
    expect(resolved.passthroughArgs).toEqual(['--full-auto']);
  });

  it('maps add-dir category into gemini include-directories', () => {
    const resolved = resolveCrossToolForwarding('gemini', {
      rawArgs: ['--add-dir', '/tmp/workspace'],
    });

    expect(resolved.mappedArgs).toEqual(['--include-directories', '/tmp/workspace']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps cursor target using agent semantics', () => {
    expect(adapters.cursor.binaryName).toBe('agent');

    const resolved = resolveCrossToolForwarding('cursor', {
      rawArgs: ['--sandbox', 'workspace-write', '--model', 'gpt-5', '--approve-mcps'],
    });

    expect(resolved.mappedArgs).toEqual(['--model', 'gpt-5', '--sandbox', 'enabled', '--approve-mcps']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps droid yolo-like forwarding into skip-permissions-unsafe', () => {
    const resolved = resolveCrossToolForwarding('droid', {
      rawArgs: ['--yolo', '--model', 'gpt-5.3-codex'],
    });

    expect(resolved.mappedArgs).toEqual(['--skip-permissions-unsafe', '--model', 'gpt-5.3-codex']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps kimi allow-all forwarding into --yolo and preserves mapped args', () => {
    const resolved = resolveCrossToolForwarding('kimi', {
      rawArgs: ['--allow-all', '--add-dir', '/tmp/workspace', '--model', 'kimi-k2.5'],
    });

    expect(resolved.mappedArgs).toEqual(['--yolo', '--model', 'kimi-k2.5', '--add-dir', '/tmp/workspace']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps amp yolo-like forwarding into --dangerously-allow-all', () => {
    const resolved = resolveCrossToolForwarding('amp', {
      rawArgs: ['--yolo'],
    });

    expect(resolved.mappedArgs).toEqual(['--dangerously-allow-all']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps kiro yolo-like forwarding into --trust-all-tools', () => {
    const resolved = resolveCrossToolForwarding('kiro', {
      rawArgs: ['--yolo', '--agent', 'reviewer'],
    });

    expect(resolved.mappedArgs).toEqual(['--trust-all-tools', '--agent', 'reviewer']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps crush ask-for-approval never into --yolo', () => {
    const resolved = resolveCrossToolForwarding('crush', {
      rawArgs: ['--ask-for-approval', 'never'],
    });

    expect(resolved.mappedArgs).toEqual(['--yolo']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps qwen-code allow-all forwarding into approval-mode yolo', () => {
    const resolved = resolveCrossToolForwarding('qwen-code', {
      rawArgs: ['--allow-all'],
    });

    expect(resolved.mappedArgs).toEqual(['--approval-mode', 'yolo']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('applies required default init flags for handoff targets', () => {
    expect(getDefaultHandoffInitArgs('claude')).toEqual(['--dangerously-skip-permissions']);
    expect(getDefaultHandoffInitArgs('copilot')).toEqual(['--allow-all']);
    expect(getDefaultHandoffInitArgs('gemini')).toEqual(['--yolo']);
    expect(getDefaultHandoffInitArgs('cursor')).toEqual(['--yolo']);
    expect(getDefaultHandoffInitArgs('droid')).toEqual(['--skip-permissions-unsafe']);
    expect(getDefaultHandoffInitArgs('kimi')).toEqual(['--yolo']);
    expect(getDefaultHandoffInitArgs('amp')).toEqual(['--dangerously-allow-all']);
    expect(getDefaultHandoffInitArgs('kiro')).toEqual(['--trust-all-tools']);
    expect(getDefaultHandoffInitArgs('crush')).toEqual(['--yolo']);
    expect(getDefaultHandoffInitArgs('qwen-code')).toEqual(['--yolo']);

    expect(getDefaultHandoffInitArgs('codex')).toEqual([
      '-c',
      'model_reasoning_effort="high"',
      '--ask-for-approval',
      'never',
      '--sandbox',
      'danger-full-access',
      '-c',
      'model_reasoning_summary="detailed"',
      '-c',
      'model_supports_reasoning_summaries=true',
    ]);
  });

  it('keeps codex init configs but drops ask/sandbox defaults when yolo-equivalent is already set', () => {
    const args = getDefaultHandoffInitArgs('codex', ['--dangerously-bypass-approvals-and-sandbox']);

    expect(args).toEqual([
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'model_reasoning_summary="detailed"',
      '-c',
      'model_supports_reasoning_summaries=true',
    ]);
  });

  it('shows mapped forward args in cross-tool command preview', () => {
    const session: UnifiedSession = {
      id: 'abc123456789',
      source: 'claude',
      cwd: '/tmp/project',
      lines: 10,
      bytes: 120,
      createdAt: new Date('2026-02-20T00:00:00.000Z'),
      updatedAt: new Date('2026-02-20T00:00:00.000Z'),
      originalPath: '/tmp/session.jsonl',
    };

    const command = getResumeCommand(session, 'codex', {
      rawArgs: ['--yolo', '--search'],
    });

    expect(command).toContain('continues resume abc123456789 --in codex');
    expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(command).toContain('--search');
  });

  it('includes default yolo flag in gemini command preview when no forwarding args are provided', () => {
    const session: UnifiedSession = {
      id: 'abc123456789',
      source: 'claude',
      cwd: '/tmp/project',
      lines: 10,
      bytes: 120,
      createdAt: new Date('2026-02-20T00:00:00.000Z'),
      updatedAt: new Date('2026-02-20T00:00:00.000Z'),
      originalPath: '/tmp/session.jsonl',
    };

    const command = getResumeCommand(session, 'gemini');

    expect(command).toContain('continues resume abc123456789 --in gemini');
    expect(command).toContain('--yolo');
  });

  it('includes default skip-permissions flag in droid command preview when no forwarding args are provided', () => {
    const session: UnifiedSession = {
      id: 'abc123456789',
      source: 'claude',
      cwd: '/tmp/project',
      lines: 10,
      bytes: 120,
      createdAt: new Date('2026-02-20T00:00:00.000Z'),
      updatedAt: new Date('2026-02-20T00:00:00.000Z'),
      originalPath: '/tmp/session.jsonl',
    };

    const command = getResumeCommand(session, 'droid');

    expect(command).toContain('continues resume abc123456789 --in droid');
    expect(command).toContain('--skip-permissions-unsafe');
  });

  it('includes default yolo flag in qwen command preview when no forwarding args are provided', () => {
    const session: UnifiedSession = {
      id: 'abc123456789',
      source: 'claude',
      cwd: '/tmp/project',
      lines: 10,
      bytes: 120,
      createdAt: new Date('2026-02-20T00:00:00.000Z'),
      updatedAt: new Date('2026-02-20T00:00:00.000Z'),
      originalPath: '/tmp/session.jsonl',
    };

    const command = getResumeCommand(session, 'qwen-code');

    expect(command).toContain('continues resume abc123456789 --in qwen-code');
    expect(command).toContain('--yolo');
  });
});
