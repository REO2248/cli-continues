import * as clack from '@clack/prompts';
import { sourceColors } from '../display/format.js';
import { ALL_TOOLS } from '../parsers/registry.js';
import type { SessionSource, UnifiedSession } from '../types/index.js';
import { getAvailableTools } from '../utils/resume.js';

/**
 * Show interactive tool-selection TUI and return the chosen target tool.
 * Returns null if user cancels or no tools are available.
 *
 * Shared by pick, resume, and quick-resume commands to avoid 3x duplication.
 */
export async function selectTargetTool(
  session: UnifiedSession,
  options?: { excludeSource?: boolean },
): Promise<SessionSource | null> {
  const availableTools = await getAvailableTools();
  const exclude = options?.excludeSource ?? true;

  const targetOptions = availableTools
    .filter((t) => !exclude || t !== session.source)
    .map((t) => ({
      value: t,
      label:
        t === session.source
          ? `${sourceColors[t](t.charAt(0).toUpperCase() + t.slice(1))} (native resume)`
          : `${sourceColors[t](t.charAt(0).toUpperCase() + t.slice(1))}`,
    }));

  if (targetOptions.length === 0) {
    const missing = ALL_TOOLS.filter((t) => !availableTools.includes(t)).map(
      (t) => t.charAt(0).toUpperCase() + t.slice(1),
    );
    clack.log.warn(
      `Only ${sourceColors[session.source](session.source)} is installed. ` +
        `Install at least one more (${missing.join(', ')}) to enable cross-tool handoff.`,
    );
    return null;
  }

  const targetTool = (await clack.select({
    message: `Continue ${sourceColors[session.source](session.source)} session in:`,
    options: targetOptions,
    ...(exclude ? {} : { initialValue: session.source }),
  })) as SessionSource;

  if (clack.isCancel(targetTool)) {
    clack.cancel('Cancelled');
    return null;
  }

  return targetTool;
}

/**
 * Check if only the native tool is available and auto-resume if so.
 * Returns true if it handled the auto-resume (caller should return).
 */
export async function checkSingleToolAutoResume(
  session: UnifiedSession,
  nativeResumeFn: (s: UnifiedSession) => Promise<void>,
): Promise<boolean> {
  const availableTools = await getAvailableTools();
  if (availableTools.length === 1 && availableTools[0] === session.source) {
    clack.log.step(`Resuming natively in ${sourceColors[session.source](session.source)}...`);
    clack.outro(`Launching ${session.source}`);
    if (session.cwd) process.chdir(session.cwd);
    await nativeResumeFn(session);
    return true;
  }
  return false;
}
