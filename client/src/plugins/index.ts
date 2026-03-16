/**
 * Plugin index — import your plugins here and they will be registered
 * automatically when the app starts.
 *
 * Example:
 *   import './git-log';   // a file that calls registerPlugin({...})
 *
 * Each plugin file should call registerPlugin() at module load-time:
 *
 *   // client/src/plugins/git-log.tsx
 *   import { registerPlugin } from './registry';
 *   registerPlugin({
 *       id: 'git-log',
 *       title: 'Git Log',
 *       iconClass: 'devicon-git-plain colored',
 *       component: GitLogPane,
 *   });
 */

// ── Register your plugins below ───────────────────────────────────────────────

import './git-log';
import './db';
