// ================================================================
//  SENTINELLE SIGNAUX — GOLD + BTC / ETH / SOL → Telegram, H24
//  • Signaux BUY et SELL avec TP1 / TP2 / TP3 + stop-loss
//  • Analyse 3 timeframes (15 min / 1 h / 4 h) + régime de marché
//  • IA "gérant de fonds" (Claude, optionnelle) qui valide chaque signal
//  • Suivi automatique de chaque signal : TP touchés, stop déplacé,
//    résultat en R et en € sur un compte démo de 1 000 € (1 %/trade)
//  • Rapport tous les soirs 21 h + bilan de la semaine le dimanche
//  À exécuter toi-même sur MetaTrader 5 (compte démo d'abord)
//  Variables : TELEGRAM_TOKEN, CHAT_ID, ANTHROPIC_API_KEY (optionnel)
// ================================================================
import fs from 'node:fs';

const TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const AI_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
if (!TOKEN || !CHAT_ID) { console.error('❌ TELEGRAM_TOKEN ou CHAT_ID manquant'); process.exit(1); }

// ---------------- Réglages ----------------
// Prix de référence Kraken (le GOLD suit le jeton PAXG, adossé à l'or physique)
const MARCHES = [
  { nom: 'GOLD', label: 'GOLD (XAUUSD)', pair: 'PAXGUSD', dec: 2, crypto: false },
  { nom: 'BTC', label: 'BTC (BTCUSD)', pair: 'XBTUSD', dec: 1, crypto: true },
  { nom: 'ETH', label: 'ETH (ETHUSD)', pair: 'ETHUSD', dec: 2, crypto: true },
  { nom: 'SOL', label: 'SOL (SOLUSD)', pair: 'SOLUSD', dec: 2, crypto: true },
];
const CAPITAL_DEPART = 1000;   // compte démo virtuel (€)
const RISQUE = 0.01;           // 1 % du compte risqué par signal
const COUT_R = 0.05;           // spread + frais estimés, retirés de chaque trade (en R)
const PERTE_MAX_JOUR_R = 3;    // -3 R dans la journée → pause jusqu'à demain
const DRAWDOWN_MAX = 0.15;     // -15 % depuis le plus haut → arrêt total
const CONFIANCE_MIN = 65;
const SCORE_MIN_IA = 70;
const SCORE_MIN_SANS_IA = 80;
const MODELE_DECISION = 'claude-sonnet-5-5';
const MODELE_CHAT = 'claude-haiku-5-5';
const CYCLE_MS = 60_000;
const HEURE_RAPPORT = 21;      // rapport quotidien (heure de Paris)
const HEURE_BILAN = 20;        // bilan hebdo le dimanche (heure de Paris)
const FICHIER = './signaux.json';
const TP_TENDANCE = [1, 2, 3.5]; // TP en multiples du risque R
const TP_RANGE = [0.7, 1.2, 1.8];

// ---------------- État ----------------
const etatVide = () => ({
  capital: CAPITAL_DEPART, plusHaut: CAPITAL_DEPART, signaux: {}, historique: [],
  pause: false, pauseAuto: false, jour: '', rJour: 0, derniereBougie: {}, dernier: {},
  pertesSuite: 0, cooldownJusqua: 0, dernierRapport: '', dernierBilan: '', compteur: 0, debut: Date.now(),
});
let etat = etatVide();
try { etat = { ...etatVide(), ...JSON.parse(fs.readFileSync(FICHIER, 'utf8')) }; } catch {}
function sauver() {
  fs.writeFileSync(`${FICHIER}.tmp`, JSON.stringify(etat, null, 2));
  fs.renameSync(`${FICHIER}.tmp`, FICHIER);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const nb = (n, d = 2) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n, d = 2) => `${nb(n, d)} $`;
const eur = (n) => `${nb(n)} €`;
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)} %`;
const fR = (r) => `${r >= 0 ? '+' : ''}${r.toFixed(2)} R`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const moyenne = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const marche = (nom) => MARCHES.find((x) => x.nom === nom);

function paris() {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, heure: Number(g('hour')), jourSemaine: g('weekday') };
}
// Le marché de l'or (MT5) est fermé du vendredi soir au dimanche soir
function orOuvert() {
  const d = new Date(); const j = d.getUTCDay(); const h = d.getUTCHours();
  if (j === 6) return false;
  if (j === 5 && h >= 21) return false;
  if (j === 0 && h < 22) return false;
  return true;
}

const cache = {};
async function enCache(cle, ttl, fn) {
  const c = cache[cle];
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn();
  cache[cle] = { t: Date.now(), v };
  return v;
}

// ---------------- Telegram ----------------
async function tg(methode, corps) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${methode}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps),
  });
  return r.json();
}
async function envoyer(texte) {
  try {
    const j = await tg('sendMessage', { chat_id: CHAT_ID, text: texte.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
    if (!j.ok) console.log('Telegram refuse :', j.description);
  } catch (e) { console.log('Telegram :', e.message); }
}

// ---------------- Données marché ----------------
async function kraken(chemin) {
  const r = await fetch(`https://api.kraken.com/0/public/${chemin}`);
  const j = await r.json();
  if (j.error?.length) throw new Error(j.error.join(', '));
  return j.result;
}
function ohlc(pair, intervalle) {
  const ttl = { 15: 55_000, 60: 300_000, 240: 900_000 }[intervalle];
  return enCache(`ohlc-${pair}-${intervalle}`, ttl, async () => {
    const res = await kraken(`OHLC?pair=${pair}&interval=${intervalle}`);
    const cle = Object.keys(res).find((k) => k !== 'last');
    return res[cle].map((c) => ({ t: c[0], h: +c[2], l: +c[3], c: +c[4], v: +c[6] })).slice(0, -1);
  });
}
async function prix(pair) {
  const res = await kraken(`Ticker?pair=${pair}`);
  return +res[Object.keys(res)[0]].c[0];
}
function fearGreed() {
  return enCache('fng', 3_600_000, async () => {
    try {
      const j = await (await fetch('https://api.alternative.me/fng/?limit=1')).json();
      return { valeur: +j.data[0].value, label: j.data[0].value_classification };
    } catch { return null; }
  });
}
function actus() {
  return enCache('actus', 1_800_000, async () => {
    try {
      const x = await (await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/')).text();
      return [...x.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].map((m) => m[1].trim()).slice(1, 9);
    } catch { return []; }
  });
}

// ---------------- Indicateurs ----------------
function ema(v, n) {
  const k = 2 / (n + 1); let e = v[0]; const out = [e];
  for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function rma(v, n) {
  const out = []; let s = 0;
  for (let i = 0; i < v.length; i++) {
    if (i < n) { s += v[i]; out.push(s / (i + 1)); } else out.push((out[i - 1] * (n - 1) + v[i]) / n);
  }
  return out;
}
function rsi(v, n = 14) {
  const g = [0]; const p = [0];
  for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g.push(Math.max(d, 0)); p.push(Math.max(-d, 0)); }
  const ag = rma(g, n); const ap = rma(p, n);
  return ag.map((x, i) => (ap[i] === 0 ? 100 : 100 - 100 / (1 + x / ap[i])));
}
function adxAtr(b, n = 14) {
  const pdm = [0]; const ndm = [0]; const tr = [b[0].h - b[0].l];
  for (let i = 1; i < b.length; i++) {
    const haut = b[i].h - b[i - 1].h; const bas = b[i - 1].l - b[i].l;
    pdm.push(haut > bas && haut > 0 ? haut : 0);
    ndm.push(bas > haut && bas > 0 ? bas : 0);
    tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  }
  const atr = rma(tr, n); const sp = rma(pdm, n); const sn = rma(ndm, n);
  const dx = atr.map((a, i) => {
    const pdi = a ? (100 * sp[i]) / a : 0; const ndi = a ? (100 * sn[i]) / a : 0;
    return pdi + ndi ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0;
  });
  return { adx: rma(dx, n), atr };
}
function indic(b) {
  const c = b.map((x) => x.c); const v = b.map((x) => x.v);
  const e20 = ema(c, 20); const e50 = ema(c, 50); const e200 = ema(c, 200);
  const r = rsi(c); const { adx, atr } = adxAtr(b);
  const i = c.length - 1;
  const d20 = c.slice(-20); const m20 = moyenne(d20);
  const sd = Math.sqrt(moyenne(d20.map((x) => (x - m20) ** 2)));
  return {
    t: b[i].t, prix: c[i], e20: e20[i], e50: e50[i], e200: e200[i],
    rsi: r[i], rsiAvant: r[i - 1], adx: adx[i], atr: atr[i], atrMoy: moyenne(atr.slice(-50)),
    bbHaut: m20 + 2 * sd, bbBas: m20 - 2 * sd, bbMilieu: m20,
    vol: v[i], volMoy: moyenne(v.slice(-21, -1)),
    haussier: e20[i] > e50[i] && c[i] > e50[i],
    baissier: e20[i] < e50[i] && c[i] < e50[i],
  };
}

// ---------------- Cerveau : analyse d'un marché ----------------
async function analyseMarche(m) {
  const [b15, b1h, b4h] = await Promise.all([ohlc(m.pair, 15), ohlc(m.pair, 60), ohlc(m.pair, 240)]);
  const t15 = indic(b15); const t1h = indic(b1h); const t4h = indic(b4h);
  const c1h = b1h.map((x) => x.c);
  const var24h = (c1h.at(-1) / c1h.at(-25) - 1) * 100;
  const fng = m.crypto ? await fearGreed() : null;

  let regime = 'NEUTRE';
  if (Math.abs(var24h) > (m.crypto ? 7 : 3) || t1h.atr > 2 * t1h.atrMoy) regime = 'CHAOS';
  else if (t1h.adx >= 22 && (t1h.haussier || t1h.baissier)) regime = 'TENDANCE';
  else if (t1h.adx < 18) regime = 'RANGE';

  let signal = null;
  if (regime === 'TENDANCE') {
    // Achat : 4 h + 1 h haussiers, rebond du RSI 15 min au-dessus de 50
    if (t4h.haussier && t1h.haussier && t15.rsiAvant < 50 && t15.rsi >= 50 && t15.rsi < 70 && t15.prix > t15.e50) {
      let score = 45;
      if (t4h.prix > t4h.e200) score += 15;
      if (t1h.adx > 28) score += 10;
      if (t15.vol > t15.volMoy * 1.2) score += 10;
      if (!fng || fng.valeur < 80) score += 10;
      if (t1h.rsi < 68) score += 10;
      signal = { sens: 'BUY', strat: 'TENDANCE', score, R: 1.5 * t1h.atr };
    // Vente : 4 h + 1 h baissiers, RSI 15 min qui repasse sous 50
    } else if (t4h.baissier && t1h.baissier && t15.rsiAvant > 50 && t15.rsi <= 50 && t15.rsi > 30 && t15.prix < t15.e50) {
      let score = 45;
      if (t4h.prix < t4h.e200) score += 15;
      if (t1h.adx > 28) score += 10;
      if (t15.vol > t15.volMoy * 1.2) score += 10;
      if (!fng || fng.valeur > 20) score += 10;
      if (t1h.rsi > 32) score += 10;
      signal = { sens: 'SELL', strat: 'TENDANCE', score, R: 1.5 * t1h.atr };
    }
  } else if (regime === 'RANGE') {
    // Marché calme : on joue le retour à la moyenne après un excès
    if (!t4h.baissier && t15.prix < t15.bbBas && t15.rsi < 30) {
      let score = 50;
      if (t15.vol > t15.volMoy * 1.5) score += 10;
      if (fng && fng.valeur < 35) score += 15; else if (!fng) score += 10;
      if (t1h.rsi < 40) score += 15;
      if (t4h.prix > t4h.e200) score += 10;
      signal = { sens: 'BUY', strat: 'RANGE', score, R: 1.2 * t1h.atr };
    } else if (!t4h.haussier && t15.prix > t15.bbHaut && t15.rsi > 70) {
      let score = 50;
      if (t15.vol > t15.volMoy * 1.5) score += 10;
      if (fng && fng.valeur > 65) score += 15; else if (!fng) score += 10;
      if (t1h.rsi > 60) score += 15;
      if (t4h.prix < t4h.e200) score += 10;
      signal = { sens: 'SELL', strat: 'RANGE', score, R: 1.2 * t1h.atr };
    }
  }
  return { m, t15, t1h, t4h, var24h, regime, signal, fng };
}

// ---------------- IA ----------------
const SYSTEME = `Tu es le gérant principal d'un fonds quantitatif multi-actifs (or, crypto). Tu as traversé tous les grands marchés (krachs de 1987, 2000, 2008, 2020, cycles crypto depuis 2013).
Ta règle d'or : protéger le capital d'abord. Tu ne valides que les signaux à forte probabilité avec un bon ratio gain/risque, et tu refuses sans hésiter tout signal douteux.
Tu raisonnes sur : l'alignement des timeframes, le régime de marché, la volatilité, le sentiment, l'actualité et les résultats récents de la stratégie.`;

async function claude(modele, systeme, contenu, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: modele, max_tokens: maxTokens, system: systeme, messages: [{ role: 'user', content: contenu }] }),
  });
  const j = await r.json();
  if (!j.content?.[0]?.text) throw new Error(j.error?.message || 'réponse vide');
  return j.content[0].text;
}

function stats(liste) {
  const g = liste.filter((x) => x.r > 0).length;
  return {
    trades: liste.length, gagnants: g,
    reussite: liste.length ? Math.round((g / liste.length) * 100) : 0,
    totalR: liste.reduce((s, x) => s + x.r, 0),
    totalEur: liste.reduce((s, x) => s + x.eur, 0),
  };
}

async function avisIA(A) {
  if (!AI_KEY) return { decision: 'VALIDER', confiance: null, risque: 0.7, raison: 'IA pas encore activée : règles techniques strictes seules' };
  const r = (x) => Math.round(x * 100) / 100;
  const tf = (t) => ({ prix: r(t.prix), ema20: r(t.e20), ema50: r(t.e50), ema200: r(t.e200), rsi: r(t.rsi), adx: r(t.adx), atr: r(t.atr), haussier: t.haussier, baissier: t.baissier });
  const donnees = {
    actif: A.m.label, sens: A.signal.sens, strategie: A.signal.strat, score_technique: A.signal.score,
    regime: A.regime, variation_24h_pct: r(A.var24h),
    tf_15min: tf(A.t15), tf_1h: tf(A.t1h), tf_4h: tf(A.t4h),
    risque_R_en_dollars: r(A.signal.R),
    fear_greed_crypto: A.fng, actualites: A.m.crypto ? await actus() : [],
    resultats_20_derniers: stats(etat.historique.slice(-20)),
  };
  const consigne = `Un signal ${A.signal.sens} vient de sortir. Données :\n${JSON.stringify(donnees)}\n\n`
    + 'Décide en gérant de fonds. Réponds UNIQUEMENT avec ce JSON :\n'
    + '{"decision":"VALIDER" ou "REFUSER","confiance":0-100,"risque":0.3-1 (taille de position, 1 = normale),"raison":"une ou deux phrases en français"}';
  try {
    const texte = await claude(MODELE_DECISION, SYSTEME, consigne, 300);
    const m = texte.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('format');
    return JSON.parse(m[0]);
  } catch (e) {
    return { decision: 'REFUSER', confiance: 0, risque: 0, raison: `IA injoignable (${e.message}) : on ne prend aucun risque` };
  }
}

// ---------------- Signaux : ouverture et suivi ----------------
async function ouvrir(A, ia) {
  const { m, t15, signal } = A;
  const d = signal.sens === 'BUY' ? 1 : -1;
  const p = t15.prix; const R = signal.R;
  const mult = Math.min(1, Math.max(0.3, Number(ia.risque) || 0.7));
  const niveaux = (signal.strat === 'TENDANCE' ? TP_TENDANCE : TP_RANGE).map((k) => p + d * k * R);
  etat.compteur += 1;
  etat.signaux[m.nom] = {
    num: etat.compteur, nom: m.nom, sens: signal.sens, strat: signal.strat,
    entree: p, sl: p - d * R, slInit: p - d * R, R, tps: niveaux,
    niveau: 0, reste: 1, rAcquis: 0, risqueEur: etat.capital * RISQUE * mult, date: Date.now(),
  };
  sauver();
  const f = (x) => usd(x, m.dec);
  await envoyer(
    `${d === 1 ? '🟢' : '🔻'} <b>SIGNAL #${etat.compteur} · ${m.label} · ${signal.sens}</b>\n\n`
    + `📍 Entrée : <b>${f(p)}</b>\n`
    + `🎯 TP1 : ${f(niveaux[0])}\n🎯 TP2 : ${f(niveaux[1])}\n🎯 TP3 : ${f(niveaux[2])}\n`
    + `🛑 SL : ${f(p - d * R)} (à ${f(R)} de l'entrée)\n\n`
    + `📊 Score ${signal.score}/100 · ${signal.strat === 'TENDANCE' ? 'suivi de tendance' : 'retour à la moyenne'}\n`
    + `🤖 IA : ${ia.confiance === null ? 'non activée' : `${ia.confiance} % de confiance`}\n<i>${esc(ia.raison)}</i>\n\n`
    + `💡 Risque conseillé : 1 % de ton compte. Au TP1, ferme 1/3 et remonte le stop à l'entrée.\n`
    + '<i>Prix Kraken : quelques $ d\'écart possibles avec ton courtier, garde les mêmes distances.</i>',
  );
}

async function cloturer(nom, motif, rBrut, prixSortie) {
  const s = etat.signaux[nom]; const m = marche(nom);
  const r = rBrut - COUT_R;
  const gain = r * s.risqueEur;
  etat.capital += gain;
  etat.rJour += r;
  etat.historique.push({ num: s.num, nom, sens: s.sens, strat: s.strat, entree: s.entree, sortie: prixSortie, niveau: s.niveau, r, eur: gain, motif, date: Date.now() });
  delete etat.signaux[nom];
  if (r < 0) {
    etat.pertesSuite += 1;
    if (etat.pertesSuite >= 2) {
      etat.cooldownJusqua = Date.now() + 2 * 3_600_000; etat.pertesSuite = 0;
      await envoyer('🧊 2 pertes d\'affilée : pas de nouveau signal pendant 2 h (discipline de pro).');
    }
  } else etat.pertesSuite = 0;
  sauver();
  await envoyer(
    `${r >= 0 ? '✅' : '🔴'} <b>${motif}</b> · #${s.num} ${m.label} ${s.sens}\n`
    + `Sortie : ${usd(prixSortie, m.dec)}\n`
    + `Résultat : <b>${fR(r)}</b> (${gain >= 0 ? '+' : ''}${eur(gain)} sur le compte démo)\n`
    + `Compte démo : ${eur(etat.capital)}`,
  );
}

async function suivre(nom, p) {
  const s = etat.signaux[nom]; const m = marche(nom);
  const d = s.sens === 'BUY' ? 1 : -1;
  const rA = (x) => (d * (x - s.entree)) / s.R;

  if (d * (p - s.sl) <= 0) {
    const motif = s.niveau === 0 ? 'SL touché' : s.niveau === 1 ? 'Retour à l\'entrée (trade sans perte)' : 'Stop sur TP1 (gains sécurisés)';
    return cloturer(nom, motif, s.rAcquis + s.reste * rA(s.sl), s.sl);
  }
  while (s.niveau < 3 && d * (p - s.tps[s.niveau]) >= 0) {
    const tp = s.tps[s.niveau]; const rTp = rA(tp);
    if (s.niveau < 2) {
      s.rAcquis += rTp / 3; s.reste -= 1 / 3; s.niveau += 1;
      s.sl = s.niveau === 1 ? s.entree : s.tps[0];
      sauver();
      await envoyer(
        `🎯 <b>TP${s.niveau} TOUCHÉ</b> · #${s.num} ${m.label} ${s.sens}\n`
        + `${fR(rTp)} sur 1/3 de la position\n`
        + `🛡️ Stop déplacé ${s.niveau === 1 ? 'à l\'entrée : le trade ne peut plus perdre' : 'sur le TP1'}`,
      );
    } else {
      s.rAcquis += s.reste * rTp; s.reste = 0; s.niveau = 3;
      return cloturer(nom, '🏁 TP3 TOUCHÉ · TP FINAL', s.rAcquis, tp);
    }
  }
  const dureeMax = (s.strat === 'RANGE' ? 12 : 72) * 3_600_000;
  if (Date.now() - s.date > dureeMax) return cloturer(nom, 'Clôture : trade trop long', s.rAcquis + s.reste * rA(p), p);
}

// ---------------- Boucle H24 ----------------
async function gererTemps() {
  const { date, heure, jourSemaine } = paris();
  if (etat.jour !== date) {
    etat.jour = date; etat.rJour = 0;
    if (etat.pauseAuto) { etat.pause = false; etat.pauseAuto = false; await envoyer('▶️ Nouvelle journée : Sentinelle reprend les signaux.'); }
    sauver();
  }
  if (heure >= HEURE_RAPPORT && etat.dernierRapport !== date) {
    etat.dernierRapport = date; sauver();
    await rapport();
  }
  if (jourSemaine.startsWith('dim') && heure >= HEURE_BILAN && etat.dernierBilan !== date) {
    etat.dernierBilan = date; sauver();
    await bilan();
  }
}

async function controleRisque() {
  etat.plusHaut = Math.max(etat.plusHaut, etat.capital);
  if (!etat.pause && etat.rJour <= -PERTE_MAX_JOUR_R) {
    etat.pause = true; etat.pauseAuto = true;
    await envoyer(`⛔ Perte max du jour atteinte (${fR(etat.rJour)}). Plus de signaux jusqu'à demain.`);
  }
  if (!etat.pause && etat.capital < etat.plusHaut * (1 - DRAWDOWN_MAX)) {
    etat.pause = true; etat.pauseAuto = false;
    await envoyer(`🚨 <b>Coupe-circuit</b> : -${Math.round(DRAWDOWN_MAX * 100)} % depuis le plus haut. Sentinelle s'arrête. Envoie /reprendre pour relancer.`);
  }
  sauver();
}

async function cycle() {
  await gererTemps();
  for (const m of MARCHES) {
    if (etat.signaux[m.nom]) {
      try { await suivre(m.nom, await prix(m.pair)); } catch (e) { console.log(`Suivi ${m.nom} :`, e.message); }
    }
  }
  for (const m of MARCHES) {
    try {
      const A = await analyseMarche(m);
      etat.dernier[m.nom] = { prix: A.t15.prix, regime: A.regime, rsi15: Math.round(A.t15.rsi), var24h: Math.round(A.var24h * 10) / 10 };
      if (etat.derniereBougie[m.nom] === A.t15.t) continue; // attendre une nouvelle bougie 15 min
      etat.derniereBougie[m.nom] = A.t15.t;
      sauver();

      const s = etat.signaux[m.nom];
      if (s?.strat === 'TENDANCE' && ((s.sens === 'BUY' && A.t1h.baissier) || (s.sens === 'SELL' && A.t1h.haussier))) {
        const d = s.sens === 'BUY' ? 1 : -1;
        await cloturer(m.nom, 'Clôture : la tendance 1 h s\'est retournée', s.rAcquis + s.reste * ((d * (A.t15.prix - s.entree)) / s.R), A.t15.prix);
        continue;
      }
      if (s || !A.signal || etat.pause || Date.now() < etat.cooldownJusqua) continue;
      if (!m.crypto && !orOuvert()) continue;
      if (A.signal.score < (AI_KEY ? SCORE_MIN_IA : SCORE_MIN_SANS_IA)) continue;

      const ia = await avisIA(A);
      if (ia.decision === 'VALIDER' && (ia.confiance === null || ia.confiance >= CONFIANCE_MIN)) await ouvrir(A, ia);
      else await envoyer(`⚪ Signal ${m.label} ${A.signal.sens} (score ${A.signal.score}) refusé par l'IA · ${ia.confiance} %\n<i>${esc(ia.raison)}</i>`);
    } catch (e) { console.log(`Analyse ${m.nom} :`, e.message); }
  }
  await controleRisque();
}

// ---------------- Rapports ----------------
async function rapport() {
  const auj = etat.historique.filter((x) => Date.now() - x.date < 86_400_000);
  const sj = stats(auj); const st = stats(etat.historique);
  const jours = Math.max(1, Math.round((Date.now() - etat.debut) / 86_400_000));
  let marches = '';
  for (const m of MARCHES) {
    const d = etat.dernier[m.nom];
    if (d) marches += `\n${m.nom} ${usd(d.prix, m.dec)} · ${pct(d.var24h)} · ${d.regime}`;
  }
  await envoyer(
    `📊 <b>Rapport du jour</b> (jour ${jours})\n`
    + `Aujourd'hui : ${sj.trades} trade(s) · ${fR(sj.totalR)} (${eur(sj.totalEur)})\n`
    + `Depuis le début : ${st.trades} trades · ${st.reussite} % gagnants · ${fR(st.totalR)}\n`
    + `Compte démo : <b>${eur(etat.capital)}</b> (${pct((etat.capital / CAPITAL_DEPART - 1) * 100)})\n`
    + `Signaux ouverts : ${Object.keys(etat.signaux).length}\n${marches}`,
  );
}

async function bilan() {
  const semaine = etat.historique.filter((x) => Date.now() - x.date < 7 * 86_400_000);
  const s = stats(semaine);
  const lignes = semaine.map((x) => `${x.r >= 0 ? '🟢' : '🔴'} #${x.num} ${x.nom} ${x.sens} : ${fR(x.r)}`).join('\n') || 'Aucun trade cette semaine.';
  await envoyer(
    `🗓️ <b>BILAN DE LA SEMAINE</b> (résultats réels, pertes comprises)\n`
    + `${s.trades} trades · ${s.reussite} % gagnants · <b>${fR(s.totalR)}</b>\n`
    + `Sur le compte démo : ${s.totalEur >= 0 ? '+' : ''}${eur(s.totalEur)} → ${eur(etat.capital)}\n\n${lignes}`,
  );
}

function simuler(b) {
  const c = b.map((x) => x.c);
  const e20 = ema(c, 20); const e50 = ema(c, 50); const e200 = ema(c, 200);
  const r = rsi(c); const { atr } = adxAtr(b);
  let pos = null; let cumul = 0; let pic = 0; let dd = 0; const res = [];
  const fin = (rr) => { res.push(rr - COUT_R); cumul += rr - COUT_R; pic = Math.max(pic, cumul); dd = Math.max(dd, pic - cumul); pos = null; };
  for (let i = 200; i < b.length; i++) {
    const x = b[i];
    if (pos) {
      const d = pos.d;
      const rA = (v) => (d * (v - pos.e)) / pos.R;
      if (d === 1 ? x.l <= pos.sl : x.h >= pos.sl) { fin(pos.ra + pos.reste * rA(pos.sl)); continue; }
      while (pos && pos.niv < 3) {
        const tp = pos.tps[pos.niv];
        if (!(d === 1 ? x.h >= tp : x.l <= tp)) break;
        if (pos.niv < 2) { pos.ra += rA(tp) / 3; pos.reste -= 1 / 3; pos.niv += 1; pos.sl = pos.niv === 1 ? pos.e : pos.tps[0]; } else { pos.ra += pos.reste * rA(tp); fin(pos.ra); }
      }
      if (pos && ((d === 1 && e20[i] < e50[i]) || (d === -1 && e20[i] > e50[i]))) fin(pos.ra + pos.reste * rA(x.c));
    } else {
      let d = 0;
      if (e20[i] > e50[i] && x.c > e200[i] && r[i - 1] < 50 && r[i] >= 50 && r[i] < 70) d = 1;
      else if (e20[i] < e50[i] && x.c < e200[i] && r[i - 1] > 50 && r[i] <= 50 && r[i] > 30) d = -1;
      if (d) {
        const R = 1.5 * atr[i];
        pos = { d, e: x.c, R, sl: x.c - d * R, tps: TP_TENDANCE.map((k) => x.c + d * k * R), niv: 0, reste: 1, ra: 0 };
      }
    }
  }
  return { n: res.length, g: res.filter((v) => v > 0).length, totalR: cumul, ddR: dd, jours: Math.round((b.length - 200) / 24) };
}

async function backtest() {
  let t = '🧪 <b>Backtest</b> (tendance BUY + SELL, bougies 1 h, sans IA)\n';
  for (const m of MARCHES) {
    try {
      const s = simuler(await ohlc(m.pair, 60));
      t += `\n<b>${m.label}</b> · ${s.jours} jours\n${s.n} trades · ${s.n ? Math.round((s.g / s.n) * 100) : 0} % gagnants · <b>${fR(s.totalR)}</b> (≈ ${eur(s.totalR * CAPITAL_DEPART * RISQUE)})\nPire baisse : -${s.ddR.toFixed(2)} R\n`;
    } catch (e) { t += `\n${m.label} : données indisponibles (${esc(e.message)})\n`; }
  }
  t += '\n<i>1 R = 1 % du compte. Le passé ne garantit pas le futur : c\'est le suivi en direct qui compte.</i>';
  await envoyer(t);
}

// ---------------- Commandes Telegram ----------------
async function commande(texte) {
  const cmd = texte.split(/[\s@]/)[0].toLowerCase();
  if (!cmd.startsWith('/')) return discuter(texte);

  if (cmd === '/start' || cmd === '/aide') {
    return envoyer(
      '🛡️ <b>Sentinelle Signaux</b> — GOLD · BTC · ETH · SOL, H24\n\n'
      + '/signaux — signaux en cours\n/status — état du robot\n/historique — derniers trades\n'
      + '/bilan — bilan de la semaine\n/analyse — analyse des marchés maintenant\n/rapport — rapport du jour\n'
      + '/backtest — test sur l\'historique\n/pause · /reprendre · /reset\n\n'
      + '📲 Passe les signaux sur MetaTrader 5 (compte démo d\'abord), 1 % de risque par trade.\n'
      + '💬 Écris-moi n\'importe quelle question, l\'IA te répond.',
    );
  }
  if (cmd === '/status') {
    const st = stats(etat.historique);
    const cool = Date.now() < etat.cooldownJusqua ? `\n🧊 Pause discipline jusqu'à ${new Date(etat.cooldownJusqua).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}` : '';
    return envoyer(
      `🛡️ <b>Sentinelle Signaux</b> ${etat.pause ? '⏸️ en pause' : '▶️ actif H24'}\n`
      + `Compte démo : <b>${eur(etat.capital)}</b> (${pct((etat.capital / CAPITAL_DEPART - 1) * 100)})\n`
      + `Trades : ${st.trades} · ${st.reussite} % gagnants · ${fR(st.totalR)}\n`
      + `Signaux ouverts : ${Object.keys(etat.signaux).length}\n`
      + `GOLD : ${orOuvert() ? 'marché ouvert' : 'marché fermé (week-end)'}\n`
      + `🤖 IA : ${AI_KEY ? 'activée' : 'pas encore activée'}${cool}`,
    );
  }
  if (cmd === '/signaux') {
    const liste = Object.values(etat.signaux);
    if (!liste.length) return envoyer('Aucun signal ouvert. Sentinelle attend une vraie opportunité.');
    let t = '📡 <b>Signaux en cours</b>\n';
    for (const s of liste) {
      const m = marche(s.nom); const d = s.sens === 'BUY' ? 1 : -1;
      const p = await prix(m.pair);
      t += `\n<b>#${s.num} ${m.label} ${s.sens}</b> · entrée ${usd(s.entree, m.dec)}\n`
        + `Prix : ${usd(p, m.dec)} (${fR(s.rAcquis + s.reste * ((d * (p - s.entree)) / s.R))})\n`
        + `TP atteints : ${s.niveau}/3 · 🛑 ${usd(s.sl, m.dec)}\n`;
    }
    return envoyer(t);
  }
  if (cmd === '/historique') {
    if (!etat.historique.length) return envoyer('Aucun trade terminé pour l\'instant.');
    const st = stats(etat.historique);
    const lignes = etat.historique.slice(-10).reverse()
      .map((x) => `${x.r >= 0 ? '✅' : '🔴'} #${x.num} ${x.nom} ${x.sens} ${fR(x.r)} · ${x.motif}`).join('\n');
    return envoyer(`📜 <b>Historique</b>\n${st.trades} trades · ${st.reussite} % gagnants · <b>${fR(st.totalR)}</b> (${eur(st.totalEur)})\n\n${lignes}`);
  }
  if (cmd === '/bilan') return bilan();
  if (cmd === '/analyse') {
    let t = '🔎 <b>Analyse en direct</b>\n';
    const fng = await fearGreed();
    if (fng) t += `Sentiment crypto : ${fng.valeur}/100 (${fng.label})\n`;
    for (const m of MARCHES) {
      try {
        const A = await analyseMarche(m);
        const tend = (x) => (x.haussier ? '📈' : x.baissier ? '📉' : '➖');
        const ferme = !m.crypto && !orOuvert() ? ' · marché fermé' : '';
        t += `\n<b>${m.label}</b> ${usd(A.t15.prix, m.dec)} · 24 h ${pct(A.var24h)}${ferme}\n`
          + `Régime : ${A.regime} · 4h ${tend(A.t4h)} 1h ${tend(A.t1h)} 15m ${tend(A.t15)} · RSI ${A.t15.rsi.toFixed(0)}\n`
          + `Signal : ${A.signal ? `${A.signal.sens} ${A.signal.strat} (score ${A.signal.score})` : 'aucun'}\n`;
      } catch (e) { t += `\n${m.label} : indisponible (${esc(e.message)})\n`; }
    }
    return envoyer(t);
  }
  if (cmd === '/rapport') return rapport();
  if (cmd === '/backtest') { await envoyer('🧪 Calcul en cours…'); return backtest(); }
  if (cmd === '/pause') { etat.pause = true; etat.pauseAuto = false; sauver(); return envoyer('⏸️ Pause : plus de nouveaux signaux. Les signaux ouverts restent suivis.'); }
  if (cmd === '/reprendre') { etat.pause = false; etat.pauseAuto = false; etat.cooldownJusqua = 0; etat.plusHaut = etat.capital; sauver(); return envoyer('▶️ Sentinelle reprend les signaux H24.'); }
  if (cmd === '/reset') { etat = etatVide(); sauver(); return envoyer('🔄 Remise à zéro : compte démo à 1 000 €, historique effacé.'); }
  return envoyer('Commande inconnue. Envoie /aide');
}

async function discuter(texte) {
  if (!AI_KEY) return envoyer('🤖 L\'IA n\'est pas encore activée. Ajoute ta clé ANTHROPIC_API_KEY pour discuter avec Sentinelle.');
  try {
    const contexte = { marches: etat.dernier, signaux_ouverts: etat.signaux, compte_demo: Math.round(etat.capital * 100) / 100, stats: stats(etat.historique.slice(-20)) };
    const rep = await claude(
      MODELE_CHAT,
      `${SYSTEME}\nTu parles à ton client en français, simplement et franchement, 8 lignes maximum. Tu ne promets jamais de gains.`,
      `Contexte du robot : ${JSON.stringify(contexte)}\n\nQuestion : ${texte}`,
      500,
    );
    return envoyer(esc(rep));
  } catch (e) { return envoyer(`IA indisponible : ${esc(e.message)}`); }
}

let offset = 0;
async function ecouter() {
  while (true) {
    try {
      const j = await tg('getUpdates', { offset, timeout: 25 });
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || String(msg.chat.id) !== CHAT_ID) continue; // n'obéit qu'à toi
        try { await commande(msg.text.trim()); } catch (e) { await envoyer(`Erreur : ${esc(e.message)}`); }
      }
    } catch (e) { console.log('Écoute :', e.message); await dormir(5000); }
  }
}

// ---------------- Démarrage ----------------
process.on('unhandledRejection', (e) => console.log('Erreur :', e?.message || e));
await envoyer('✅ <b>Sentinelle Signaux est en ligne</b>\nGOLD · BTC · ETH · SOL · BUY et SELL · H24\nEnvoie /aide');
console.log('Sentinelle Signaux démarrée');
ecouter();
while (true) {
  try { await cycle(); } catch (e) { console.log('Cycle :', e.message); }
  await dormir(CYCLE_MS);
}
