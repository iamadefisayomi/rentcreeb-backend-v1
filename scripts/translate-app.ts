/**
 * Drafts the mobile app's translations with the backend's AI provider (lib/ai.ts: any OpenAI-compatible API,
 * NVIDIA by default). Only the app's own English UI text is sent, never user data.
 *
 *   cd backend && npx tsx scripts/translate-app.ts                 all four languages, only missing strings
 *   npx tsx scripts/translate-app.ts --lang yo --limit 200          one language, first 200 missing
 *   AI_MODEL=<model id> npx tsx scripts/translate-app.ts            use a stronger model for this run
 *
 * Reads  ../src/i18n/strings.json        (every visible English string; refresh with `npm run i18n:extract` in the app)
 * Writes ../src/i18n/auto/<lang>.json    (machine drafts; hand-checked fixes go in src/i18n/<lang>.ts and win)
 * Saves after every batch, so it can be stopped and re-run; finished strings are skipped.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { aiEnabled, aiJson, aiModel } from '../src/lib/ai';

const I18N = join(__dirname, '..', '..', 'src', 'i18n');
const LANGS: Record<string, string> = {
  pcm: 'Nigerian Pidgin (Naijá), as written in everyday Lagos chat: friendly, simple, natural; not broken English',
  yo: 'Yoruba (Èdè Yorùbá) with correct tone marks and under-dots (ẹ, ọ, ṣ)',
  ig: 'Igbo (Asụsụ Igbo) with correct dotted vowels (ị, ọ, ụ) and ṅ',
  ha: 'Hausa (Harshen Hausa) in standard Kano orthography with hooked letters (ɓ, ɗ, ƙ, ƴ)',
};
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const only = arg('--lang'); const limit = Number(arg('--limit') ?? Infinity); const BATCH = Number(arg('--batch') ?? 25);
const CONCURRENCY = Number(arg('--concurrency') ?? 8);

const SYSTEM = (lang: string) => `You translate the user interface of RentCreeb, a Nigerian app for renting homes, paying rent, booking inspections,
home repairs (artisans), landlords, agents, developers and investors. Translate every English string into ${lang}.
Rules:
- Keep it short and natural for a phone screen; match the tone (buttons stay short, sentences stay sentences).
- Keep placeholders like {name}, {n}, {pct} exactly as they are.
- Keep brand and product names in English: RentCreeb, RentSave, NIN, OTP, BVN, CAC, Paystack, escrow, Wi-Fi, app names, ₦ amounts.
- Keep emojis, line breaks (\\n), punctuation style and capitalisation style (ALL CAPS stays caps).
- Place names (Lagos areas, states, cities) stay as they are.
- If a string is a single English word that is normally kept in Nigerian usage (e.g. "Duplex", "Studio"), you may keep it.
Reply with ONLY a JSON object mapping each English string (exactly as given) to its translation.`;

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');

async function translateBatch(code: string, batch: string[]) {
  const input = JSON.stringify(Object.fromEntries(batch.map((s) => [s, ''])), null, 1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await aiJson<Record<string, string>>([
      { role: 'system', content: SYSTEM(LANGS[code]) },
      { role: 'user', content: `Translate the values for these keys:\n${input}` },
    ], { maxTokens: 8000, temperature: 0.2, timeoutMs: 600_000 });
    if (!out) { await new Promise((r) => setTimeout(r, 5000 * attempt)); continue; }
    const good: Record<string, string> = {};
    for (const s of batch) {
      const tr = out[s];
      if (typeof tr !== 'string' || !tr.trim()) continue;
      if (placeholders(tr) !== placeholders(s)) continue; // broken {placeholder}: leave it in English
      good[s] = tr.trim();
    }
    return good;
  }
  return {};
}

async function main() {
  if (!aiEnabled()) { console.error('No AI key: set AI_API_KEY or NVIDIA_API_KEY in backend/.env'); process.exit(1); }
  const all: string[] = JSON.parse(readFileSync(join(I18N, 'strings.json'), 'utf8'));
  console.log(`model ${aiModel()}, ${all.length} strings`);
  // Every (language, batch) is a job; a small worker pool runs them side by side (the model is slow, not rate bound).
  const autos: Record<string, Record<string, string>> = {};
  const jobs: { code: string; batch: string[] }[] = [];
  for (const code of Object.keys(LANGS)) {
    if (only && only !== code) continue;
    const auto: Record<string, string> = autos[code] = JSON.parse(readFileSync(join(I18N, 'auto', `${code}.json`), 'utf8'));
    const manual = readFileSync(join(I18N, `${code}.ts`), 'utf8');
    const isManual = (s: string) => manual.includes(`'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}':`) || manual.includes(`"${s}":`);
    const todo = all.filter((s) => !auto[s] && !isManual(s)).slice(0, limit);
    console.log(`${code}: ${todo.length} to translate`);
    for (let i = 0; i < todo.length; i += BATCH) jobs.push({ code, batch: todo.slice(i, i + BATCH) });
  }
  const total = jobs.length; let done = 0; const started = Date.now();
  const save = (code: string) => {
    const sorted = Object.fromEntries(Object.entries(autos[code]).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(join(I18N, 'auto', `${code}.json`), JSON.stringify(sorted, null, 1) + '\n');
  };
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const got = await translateBatch(job.code, job.batch);
      Object.assign(autos[job.code], got); save(job.code); done++;
      console.log(`[${done}/${total}] ${job.code} +${Object.keys(got).length}/${job.batch.length} (${Math.round((Date.now() - started) / 60000)} min)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log('DONE');
}
main().catch((e) => { console.error(e); process.exit(1); });
