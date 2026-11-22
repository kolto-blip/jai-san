import { config } from '../config.js';
import { createPgRepo } from './pg.js';
import { createJsonRepo } from './json.js';

export async function openRepo() {
  if (config.databaseUrl) return createPgRepo(config.databaseUrl);
  return createJsonRepo(config.dataDir);
}
