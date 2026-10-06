import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface AppPaths {
  appData: string;
  config: string;
  database: string;
  logs: string;
  cache: string;
  index: string;
  sessions: string;
  checkpoints: string;
}

/** %APPDATA%\NexusCode\… on Windows, platform equivalents elsewhere. */
export function resolveAppPaths(): AppPaths {
  const base = path.join(app.getPath('appData'), 'NexusCode');
  const paths: AppPaths = {
    appData: base,
    config: path.join(base, 'config'),
    database: path.join(base, 'database'),
    logs: path.join(base, 'logs'),
    cache: path.join(base, 'cache'),
    index: path.join(base, 'index'),
    sessions: path.join(base, 'sessions'),
    checkpoints: path.join(base, 'checkpoints')
  };
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  return paths;
}
