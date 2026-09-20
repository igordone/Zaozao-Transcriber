import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { getConfigPath } from './paths.js';

function resolveEnvVars(text) {
  return text.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

export function loadConfig() {
  const configPath = getConfigPath();
  const file = readFileSync(configPath, 'utf-8');
  return parse(resolveEnvVars(file));
}