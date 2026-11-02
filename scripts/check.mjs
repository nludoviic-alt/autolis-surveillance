// Surveillance extérieure d'Autolis (demandée le 2026-11-02 après une panne du serveur passée inaperçue).
// Tourne sur GitHub toutes les 5 minutes, HORS du serveur surveillé : si le serveur tombe, l'alerte part quand même.
//
// État gardé dans un ticket GitHub ouvert portant l'étiquette « panne » :
//   * tout va bien et aucun ticket   → rien ;
//   * un contrôle échoue (2 essais)  → ticket ouvert + message Telegram « en panne » ;
//   * la panne continue              → le ticket est mis à jour ; Telegram seulement si les contrôles en échec changent,
//                                      et un rappel toutes les 3 heures ;
//   * tout revient                   → ticket fermé + message Telegram « de nouveau en ligne » avec la durée.
// Sans Node ni dépendance à installer : Node 20+ (fetch intégré).

const CHECKS = [
  { name: 'Site', url: 'https://auto-lis.com/' },
  { name: 'Santé (base + e-mails)', url: 'https://auto-lis.com/api/health' },
  { name: 'Admin', url: 'https://admin.auto-lis.com/healthz' },
];
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 20_000;
const REMINDER_EVERY_MS = 3 * 3600 * 1000;
const LABEL = 'panne';

const { GITHUB_TOKEN, GITHUB_REPOSITORY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(check) {
  const started = Date.now();
  try {
    const res = await fetch(check.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'autolis-surveillance (GitHub Actions)', 'cache-control': 'no-cache' },
    });
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, ms };
    return { ok: false, ms, why: `réponse ${res.status}${res.status === 522 ? ' (Cloudflare ne joint plus le serveur)' : res.status === 503 ? ' (service indisponible)' : ''}` };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, ms: Date.now() - started, why: timeout ? `pas de réponse en ${TIMEOUT_MS / 1000} s` : `erreur réseau (${err?.cause?.code || err?.message || 'inconnue'})` };
  }
}

/** Two tries, 20 s apart, before calling a check failed: one network hiccup is not an outage. */
async function run(check) {
  const first = await probe(check);
  if (first.ok) return { ...check, ...first };
  await sleep(RETRY_DELAY_MS);
  return { ...check, ...(await probe(check)) };
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} : ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram non configuré (secrets TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents) : message non envoyé.');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('Telegram a refusé le message :', res.status, await res.text());
}

const fmtDuration = (ms) => {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')}`;
};
const paris = (d) => d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });

const results = await Promise.all(CHECKS.map(run));
const failing = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'KO  '} ${r.name.padEnd(24)} ${String(r.ms).padStart(6)} ms  ${r.url}${r.ok ? '' : `  → ${r.why}`}`);

if (DRY_RUN) {
  console.log(failing.length ? `\n${failing.length} contrôle(s) en échec (essai à blanc : ni ticket ni Telegram).` : '\nTout répond.');
  process.exit(0);
}

const open = (await gh(`/issues?state=open&labels=${LABEL}&per_page=1`))[0] ?? null;
const now = new Date();
const failingKey = failing.map((r) => r.name).sort().join(' + ');
const lines = failing.map((r) => `• ${r.name} : ${r.why}`).join('\n');
const body = (since) =>
  `Panne détectée par la surveillance extérieure.\n\n**Depuis** : ${paris(since)} (heure de Paris)\n**Dernier contrôle** : ${paris(now)}\n\n` +
  failing.map((r) => `- **${r.name}** — ${r.url} — ${r.why}`).join('\n') +
  `\n\n<!-- since=${since.toISOString()} key=${failingKey} reminded=${now.toISOString()} -->`;

if (failing.length && !open) {
  await gh('/issues', { method: 'POST', body: JSON.stringify({ title: `🔴 Autolis en panne — ${failingKey}`, body: body(now), labels: [LABEL] }) });
  await telegram(`🔴 Autolis en panne (${paris(now)})\n${lines}\n\nContrôle toutes les 5 min ; message au retour.`);
} else if (failing.length && open) {
  const since = new Date(open.body.match(/since=([^ ]+)/)?.[1] ?? open.created_at);
  const prevKey = open.body.match(/key=(.*?) reminded=/)?.[1] ?? '';
  const reminded = new Date(open.body.match(/reminded=([^ ]+) -->/)?.[1] ?? open.created_at);
  const changed = prevKey !== failingKey;
  const remind = now - reminded >= REMINDER_EVERY_MS;
  const newBody = body(since).replace(/reminded=[^ ]+ -->/, `reminded=${(changed || remind ? now : reminded).toISOString()} -->`);
  await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ title: `🔴 Autolis en panne — ${failingKey}`, body: newBody }) });
  if (changed) await telegram(`🟠 Autolis : la panne évolue (depuis ${fmtDuration(now - since)})\n${lines}`);
  else if (remind) await telegram(`🔴 Rappel : Autolis toujours en panne depuis ${fmtDuration(now - since)}\n${lines}`);
} else if (!failing.length && open) {
  const since = new Date(open.body.match(/since=([^ ]+)/)?.[1] ?? open.created_at);
  await gh(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `✅ Tout répond de nouveau (${paris(now)}). Durée de la panne : ${fmtDuration(now - since)}.` }) });
  await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  await telegram(`✅ Autolis de nouveau en ligne (${paris(now)})\nDurée de la panne : ${fmtDuration(now - since)}.`);
} else {
  console.log('\nTout répond, aucune panne en cours.');
}
