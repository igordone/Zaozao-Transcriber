import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

let rootDir = null;

export function getRootDir() {
  if (rootDir) return rootDir;

  if (process.env.ZAOZAO_ROOT) {
    rootDir = process.env.ZAOZAO_ROOT;
    return rootDir;
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  rootDir = join(__dirname, '..');
  return rootDir;
}

export function getEnvPath() {
  return join(getRootDir(), '.env');
}

export function getConfigPath() {
  return join(getRootDir(), 'config.yaml');
}

export function getCharactersPath() {
  return join(getRootDir(), 'src', 'characters.json');
}

export function getOutputDir() {
  return join(getRootDir(), 'src', 'output');
}

export function setRootDir(dir) {
  rootDir = dir;
}
