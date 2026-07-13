import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';
import { generateNarrative } from './narrate.js';

const folder = process.argv[2];
if (!folder) {
  console.error('Uso: node src/narrateOnly.js "caminho/da/pasta/da/sessao"');
  process.exit(1);
}

const config = loadConfig();
const transcriptPath = join(folder, 'transcricao.md');
const narrativePath = join(folder, 'narrativa.md');

const rawMarkdown = readFileSync(transcriptPath, 'utf-8');

const startTime = Date.now();
console.log(`⏱️ Narrativa iniciada em: ${new Date(startTime).toLocaleString('pt-BR')}`);

generateNarrative(rawMarkdown, config.narrative, (partial) => {
  writeFileSync(narrativePath, partial, 'utf-8');
})
  .then((narrative) => {
    writeFileSync(narrativePath, narrative, 'utf-8');
    console.log(`📖 Narrativa salva em: ${narrativePath}`);

    const endTime = Date.now();
    const durationMin = ((endTime - startTime) / 1000 / 60).toFixed(1);
    console.log(`⏱️ Narrativa finalizada em: ${new Date(endTime).toLocaleString('pt-BR')}`);
    console.log(`⏱️ Tempo total de narrativa: ${durationMin} minutos`);
  })
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });