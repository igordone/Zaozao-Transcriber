import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const configPath = join(__dirname, '..', 'config.yaml');
  const file = readFileSync(configPath, 'utf-8');
  return parse(file);
}