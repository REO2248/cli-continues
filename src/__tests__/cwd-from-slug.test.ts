import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { cwdFromSlug } from '../utils/slug.js';

describe('cwdFromSlug', () => {
  const itWindows = process.platform === 'win32' ? it : it.skip;

  itWindows('resolves Windows drive-letter slugs using existing path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-slug-'));
    const target = path.join(base, 'project-alpha');
    fs.mkdirSync(target, { recursive: true });

    const normalized = target.replace(/\\/g, '/');
    const slug = normalized.replace(':', '').replace(/[/.]/g, '-');
    const resolved = cwdFromSlug(slug).replace(/\\/g, '/');

    expect(resolved.toLowerCase()).toBe(normalized.toLowerCase());

    fs.rmSync(base, { recursive: true, force: true });
  });

  itWindows('falls back to drive-letter path format when no candidate exists', () => {
    expect(cwdFromSlug('D-Workspace-project-alpha')).toBe('D:/Workspace/project/alpha');
  });

  it('falls back to Unix path format for drive-letter-like slugs on non-Windows when path exists', () => {
    if (process.platform === 'win32') return;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-slug-drive-'));
    const target = path.join(base, 'D', 'Workspace', 'project', 'alpha');
    fs.mkdirSync(target, { recursive: true });

    // Cursor-style slug: leading `-` represents the leading `/`
    const slug = '-' + target.slice(1).replace(/[/.]/g, '-');
    const resolved = cwdFromSlug(slug);
    expect(resolved).toBe(target);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('returns empty string for drive-letter-like slug when path does not exist', () => {
    if (process.platform === 'win32') return;
    expect(cwdFromSlug('-D-Workspace-project-alpha')).toBe('');
  });

  it('resolves underscores in paths via backtracking', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-slug-underscore-'));
    const target = path.join(base, 'libktts_workspace');
    fs.mkdirSync(target, { recursive: true });

    // Cursor-style slug: leading `-` represents the leading `/`
    const slug = '-' + target.slice(1).replace(/[/.]/g, '-');
    const resolved = cwdFromSlug(slug);

    expect(resolved).toBe(target);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('returns empty string when fallback path does not exist', () => {
    const result = cwdFromSlug('-this-path-definitely-does-not-exist-xyz');
    expect(result).toBe('');
  });

  it('keeps Unix fallback behavior for non-drive slugs', () => {
    // When the path exists, it should be found via backtracking
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-slug-fallback-'));
    const target = path.join(base, 'Users', 'alice', 'my-project');
    fs.mkdirSync(target, { recursive: true });

    // Cursor-style slug: leading `-` represents the leading `/`
    const slug = '-' + target.slice(1).replace(/[/.]/g, '-');
    const resolved = cwdFromSlug(slug);
    expect(resolved).toBe(target);

    fs.rmSync(base, { recursive: true, force: true });
  });
});
