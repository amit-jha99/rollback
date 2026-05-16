import chalk from 'chalk';

/** Hard-coded version string shown in the welcome banner. */
export const ROLLBACK_VERSION = '1.0.0';

/**
 * Print the Rollback welcome banner to stdout.
 * Called at the top of every CLI invocation.
 */
export function printWelcome(): void {
  const lines = [
    '╔════════════════════════════════════════╗',
    '║   🔁 Welcome to Rollback               ║',
    '║   AI-powered code reviewer             ║',
    '║   that catches what humans miss        ║',
    `║   v${ROLLBACK_VERSION.padEnd(36)}║`,
    '║   By Amit Jha\'s Production             ║',
    '╚════════════════════════════════════════╝',
  ];
  console.log(chalk.cyan(lines.join('\n')));
}

/**
 * Format a risk level as a colored emoji + label for terminal output.
 */
export function formatRisk(level: 'low' | 'medium' | 'high'): string {
  switch (level) {
    case 'low':
      return chalk.green('🟢 Low Risk    (safe to merge)');
    case 'medium':
      return chalk.yellow('🟡 Medium Risk (review carefully)');
    case 'high':
      return chalk.red('🔴 High Risk   (do not merge)');
  }
}
