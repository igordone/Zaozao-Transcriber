const HALLUCINATION_PATTERNS = [
  /^obrigado\.?$/i,
  /^e a[íi]\.?$/i,
  /^tchau\.?$/i,
  /^oi\.?$/i,
  /^ol[áa]\.?$/i,
  /legenda(do|s)? (por|pela)/i,
  /amara\.org/i,
];

function stripNonSpeechTags(text) {
  return text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeToSeconds(ts) {
  const [h, m, s] = ts.split(':');
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

export async function transcribeMergedWithLocalWhisper(filePath, config) {
  const { whisper } = await import('@lumen-labs-dev/whisper-node');

  const result = await whisper(filePath, {
    modelName: config.local.model,
    whisperOptions: { language: 'pt', threads: 4 },
  });

  return result
    .map((seg) => ({
      start: timeToSeconds(seg.start),
      end: timeToSeconds(seg.end),
      text: stripNonSpeechTags(seg.speech),
    }))
    .filter((seg) => {
      const duration = seg.end - seg.start;
      if (duration < 0.35) return false;
      if (!seg.text || seg.text.length < 3) return false;
      return !HALLUCINATION_PATTERNS.some((p) => p.test(seg.text));
    });
}