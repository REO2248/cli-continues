import * as clack from '@clack/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { formatSessionColored } from '../display/format.js';
import type { SessionSource } from '../types/index.js';
import { findSession, formatSession, getAllSessions } from '../utils/index.js';
import { getResumeCommand, resume } from '../utils/resume.js';
import { selectTargetTool } from './_shared.js';

/**
 * Resume a specific session by ID
 */
export async function resumeCommand(
  sessionId: string,
  options: { in?: string; reference?: boolean; noTui?: boolean },
  context: { isTTY: boolean },
): Promise<void> {
  try {
    const spinner = context.isTTY && !options.noTui ? ora('Finding session...').start() : null;
    const session = await findSession(sessionId);
    if (spinner) spinner.stop();

    if (!session) {
      // Try to find similar sessions
      const allSessions = await getAllSessions();
      const similar = allSessions
        .filter(
          (s) =>
            s.id.toLowerCase().includes(sessionId.toLowerCase()) ||
            s.summary?.toLowerCase().includes(sessionId.toLowerCase()),
        )
        .slice(0, 3);

      console.error(chalk.red(`Session not found: ${sessionId}`));

      if (similar.length > 0) {
        console.log(chalk.yellow('\nDid you mean one of these?'));
        for (const s of similar) {
          console.log('  ' + formatSessionColored(s));
        }
      }

      process.exitCode = 1;
      return;
    }

    const target = options.in as SessionSource | undefined;
    const mode = options.reference ? ('reference' as const) : ('inline' as const);

    // In non-interactive mode, just resume directly
    if (!context.isTTY || options.noTui) {
      console.log(chalk.gray('Session: ') + formatSession(session));
      console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target)));
      console.log();

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, target, mode);
      return;
    }

    // Interactive mode - show details and prompt for target if not specified
    if (context.isTTY && !target) {
      clack.intro(chalk.bold('Resume session'));

      console.log(formatSessionColored(session));
      console.log();

      const selectedTarget = await selectTargetTool(session);
      if (!selectedTarget) return;

      clack.log.step(`Handing off to ${selectedTarget}...`);
      clack.outro(`Launching ${selectedTarget}`);

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, selectedTarget, mode);
    } else {
      // Target specified, just resume
      console.log(chalk.gray('Session: ') + formatSession(session));
      console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target)));
      console.log();

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, target, mode);
    }
  } catch (error) {
    if (clack.isCancel(error)) {
      clack.cancel('Cancelled');
      return;
    }
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}
