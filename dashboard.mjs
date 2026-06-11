#!/usr/bin/env node
/**
 * Dashboard simple — Segunda Vuelta Presidencial Perú 2026.
 *
 * Scrapea la API oficial de ONPE (vía Chrome real, por el anti-bot), corre una
 * simulación Monte Carlo para estimar la PROBABILIDAD de victoria de cada
 * candidato, y genera un dashboard HTML autocontenido.
 *
 * Indicadores: diferencia de votos (actual y proyectada) + % de probabilidad.
 *
 * Uso:
 *   node dashboard.mjs               genera dashboard.html y lo abre (una vez)
 *   node dashboard.mjs --no-open     solo genera el archivo
 *   node dashboard.mjs --watch       MONITOR EN VIVO: re-scrapea cada 5 min,
 *                                     sirve en http://localhost:8800 y la página
 *                                     se recarga sola
 *   node dashboard.mjs --watch 3     igual, cada 3 minutos
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { createServer } from 'node:http';

const ORIGIN = 'https://resultadosegundavuelta.onpe.gob.pe';
const BASE = `${ORIGIN}/presentacion-backend`;
const ID = 10;
const REGIONES = encodeURIComponent('TODOS,PERÚ,EXTRANJERO');
const AMBITOS = { 1: 'PERÚ', 2: 'EXTRANJERO' };
const COD_S = '10'; // Sánchez - Juntos por el Perú
const COD_K = '8';  // Keiko   - Fuerza Popular
const PORT = 8800;
const OUT = `${process.cwd()}/dashboard.html`;

// ---- Parámetros del modelo Monte Carlo (transparentes y editables) ----
const N_SIM = 50_000;
const SD_PENDIENTE = 0.03; // incertidumbre del % por mesa pendiente
const SD_JEE = 0.04;       // incertidumbre del reparto de actas del JEE

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const cand = (data, cod) => data.find((d) => String(d.codigoAgrupacionPolitica) === cod) || {};

function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Abre Chrome una sola vez y supera el challenge anti-bot.
async function openBrowser() {
  // ONPE bloquea Chrome headless (viejo y nuevo), así que va headed obligatoriamente.
  // window-position fuera de pantalla: en uso local (launchd) no roba el foco visual.
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--window-position=-3000,-3000', '--window-size=1200,900'],
  });
  const page = await browser.newPage();
  await pasarChallenge(page);
  return { browser, page };
}

// El anti-bot de ONPE es INTERMITENTE: a veces sirve un challenge JS antes de
// dejar pasar. En vez de esperar a ciegas, recargamos hasta que un fetch de
// prueba devuelva JSON real (esperas crecientes). Tolera runners lentos y el reto.
async function pasarChallenge(page) {
  const test = `${BASE}/resumen-general/totales?idEleccion=${ID}&tipoFiltro=eleccion`;
  for (let intento = 0; intento < 10; intento++) {
    await page.goto(`${ORIGIN}/main/resumen`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500 + intento * 1500); // 2.5s, 4s, 5.5s, ...
    const ok = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        const t = await r.text();
        return r.status === 200 && t.trim().startsWith('{');
      } catch { return false; }
    }, test);
    if (ok) return;
  }
  const err = new Error('No se pudo superar el challenge anti-bot de ONPE tras 10 intentos');
  err.antibot = true; // marca para que el modo deploy lo trate como skip, no como falla
  throw err;
}

// Ejecuta los fetch desde el contexto de la página (mismo origen → JSON).
async function fetchData(page) {
  return page.evaluate(async ({ BASE, ID, REGIONES, AMBITOS }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const j = async (u) => {
      for (let i = 0; i < 4; i++) {
        const r = await fetch(u, { cache: 'no-store' });
        const txt = await r.text();
        if (r.status === 200 && txt.trim().startsWith('{')) return JSON.parse(txt);
        if (r.status === 204) return { __status: 204 };
        await sleep(800);
      }
      throw new Error(`Sin JSON: ${u}`);
    };
    const out = { ambitos: {} };
    out.totales = await j(`${BASE}/resumen-general/totales?idEleccion=${ID}&tipoFiltro=eleccion`);
    out.nacional = await j(`${BASE}/eleccion-presidencial/participantes-ubicacion-geografica-nombre?idEleccion=${ID}&tipoFiltro=eleccion`);
    for (const amb of Object.keys(AMBITOS)) {
      out.ambitos[amb] = {
        participantes: await j(`${BASE}/eleccion-presidencial/participantes-ubicacion-geografica-nombre?tipoFiltro=ambito_geografico&idAmbitoGeografico=${amb}&listRegiones=${REGIONES}&idEleccion=${ID}`),
        mesas: await j(`${BASE}/mesa/totales?tipoFiltro=ambito_geografico&listRegiones=${REGIONES}&ambitoGeografico=${amb}`),
      };
    }
    return out;
  }, { BASE, ID, REGIONES, AMBITOS });
}

function normalize(raw) {
  const t = raw.totales.data;
  const nac = raw.nacional.data;
  const sNac = cand(nac, COD_S), kNac = cand(nac, COD_K);
  const ambitos = Object.entries(AMBITOS).map(([id, nombre]) => {
    const part = raw.ambitos[id].participantes.data;
    const mesas = raw.ambitos[id].mesas.data;
    const s = cand(part, COD_S), k = cand(part, COD_K);
    const inst = mesas.mesasInstaladas || 0;
    const validos = (s.totalVotosValidos || 0) + (k.totalVotosValidos || 0);
    return {
      nombre,
      sanchezVotos: s.totalVotosValidos || 0,
      keikoVotos: k.totalVotosValidos || 0,
      pctSanchez: s.porcentajeVotosValidos || 0,
      pctKeiko: k.porcentajeVotosValidos || 0,
      pctK: (k.porcentajeVotosValidos || 0) / 100, // usado por la simulación
      instaladas: inst,
      pendientes: mesas.mesasPendientes || 0,
      vpm: inst > 0 ? validos / inst : 0,
    };
  });
  const votosS = sNac.totalVotosValidos, votosK = kNac.totalVotosValidos;
  return {
    t, votosS, votosK,
    pctK_nac: (kNac.porcentajeVotosValidos || 0) / 100,
    pctS_nac: (sNac.porcentajeVotosValidos || 0) / 100,
    margenActual: votosS - votosK,
    ambitos,
    jeeVotos: (t.enviadasJee || 0) * (votosS + votosK) / (t.contabilizadas || 1),
  };
}

function montecarlo(d) {
  let winsK = 0, sumMargen = 0, proyKpend = 0, proySpend = 0;
  for (const a of d.ambitos) {
    const v = a.pendientes * a.vpm;
    proyKpend += v * a.pctK;
    proySpend += v * (1 - a.pctK);
  }
  for (let i = 0; i < N_SIM; i++) {
    let addK = 0, addS = 0;
    for (const a of d.ambitos) {
      const v = a.pendientes * a.vpm;
      const shareK = clamp01(a.pctK + randn() * SD_PENDIENTE);
      addK += v * shareK; addS += v * (1 - shareK);
    }
    const shareJEE = clamp01(d.pctK_nac + randn() * SD_JEE);
    addK += d.jeeVotos * shareJEE; addS += d.jeeVotos * (1 - shareJEE);
    const finalK = d.votosK + addK, finalS = d.votosS + addS;
    sumMargen += finalS - finalK;
    if (finalK > finalS) winsK++;
  }
  return {
    probK: winsK / N_SIM,
    probS: 1 - winsK / N_SIM,
    margenProyMedio: sumMargen / N_SIM,
    netPendiente: proyKpend - proySpend,
  };
}

// timeZone explícito: el Action corre en UTC; sin esto las horas saldrían +5h.
const fecha = (ms) => new Date(ms).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' });

function html(d, mc, refreshSeconds, generadoMs) {
  const liderActual = d.margenActual > 0 ? 'Sánchez' : 'Keiko';
  const difActual = Math.abs(d.margenActual);
  const liderProy = mc.margenProyMedio > 0 ? 'Sánchez' : 'Keiko';
  const difProy = Math.abs(mc.margenProyMedio);
  const pctK = mc.probK * 100, pctS = mc.probS * 100;
  const favorito = pctK >= pctS ? 'Keiko Fujimori' : 'Roberto Sánchez';
  const colK = '#f59e0b', colS = '#ef4444';
  const refreshTag = refreshSeconds
    ? `<meta http-equiv="refresh" content="${refreshSeconds}">`
    : '';
  const ambitoCards = d.ambitos.map((a) => {
    const ganaS = a.sanchezVotos >= a.keikoVotos;
    return `<div class="card">
      <div class="label">${a.nombre === 'PERÚ' ? '🇵🇪 Perú (territorio nacional)' : '🌎 Extranjero'}</div>
      <div class="amb-row"><span style="color:var(--s)">Sánchez</span>
        <b style="color:var(--s)">${a.pctSanchez.toFixed(2)}%</b><span class="party">${fmt(a.sanchezVotos)} votos</span></div>
      <div class="amb-row"><span style="color:var(--k)">Keiko</span>
        <b style="color:var(--k)">${a.pctKeiko.toFixed(2)}%</b><span class="party">${fmt(a.keikoVotos)} votos</span></div>
      <div class="party" style="margin-top:10px">📋 ${fmt(a.instaladas)} actas contabilizadas · ${a.pendientes} pendientes ·
        gana ${ganaS ? 'Sánchez' : 'Keiko'}</div>
    </div>`;
  }).join('');
  const liveBadge = refreshSeconds
    ? `<span style="color:#22c55e">● EN VIVO</span> · refresco cada ${Math.round(refreshSeconds / 60)} min · `
    : '';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshTag}
<title>Dashboard ONPE — 2da Vuelta 2026</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--mut:#94a3b8;--fg:#f1f5f9;--k:${colK};--s:${colS}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg);padding:24px;max-width:1000px;margin:0 auto}
  h1{font-size:22px;font-weight:700}
  .sub{color:var(--mut);font-size:13px;margin-top:4px}
  .grid{display:grid;gap:16px;margin-top:20px}
  .cols-2{grid-template-columns:1fr 1fr}.cols-3{grid-template-columns:repeat(3,1fr)}
  .card{background:var(--card);border-radius:14px;padding:20px}
  .label{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .big{font-size:34px;font-weight:800;margin-top:6px}
  .cand{font-size:15px;font-weight:600}.party{color:var(--mut);font-size:12px}
  .prob{font-size:44px;font-weight:800;line-height:1}
  .bar{height:14px;border-radius:7px;background:#334155;overflow:hidden;margin-top:14px;display:flex}
  .bar>i{display:block;height:100%}
  .amb-row{display:flex;align-items:baseline;gap:10px;margin-top:8px;font-size:14px}
  .amb-row b{font-size:18px;min-width:64px}
  .h2{font-size:13px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin:24px 0 -4px}
  .winner{margin-top:20px;padding:16px 20px;border-radius:14px;background:linear-gradient(90deg,#1e293b,#334155);font-size:18px}
  .winner b{font-size:22px}
  .note{margin-top:22px;color:var(--mut);font-size:12.5px;line-height:1.6;border-top:1px solid #334155;padding-top:16px}
  @media(max-width:640px){.cols-2,.cols-3{grid-template-columns:1fr}}
</style></head><body>
  <h1>🗳️ Segunda Vuelta Presidencial Perú 2026</h1>
  <div class="sub">${liveBadge}Fuente: ONPE · Datos al ${fecha(d.t.fechaActualizacion)} ·
    Generado ${fecha(generadoMs)} · Actas: <b>${d.t.actasContabilizadas.toFixed(2)}%</b></div>

  <div class="grid cols-2">
    <div class="card">
      <div class="label">Probabilidad de ganar</div>
      <div class="cand" style="color:var(--k)">Keiko Fujimori</div>
      <div class="party">Fuerza Popular</div>
      <div class="prob" style="color:var(--k)">${pctK.toFixed(1)}%</div>
    </div>
    <div class="card">
      <div class="label">Probabilidad de ganar</div>
      <div class="cand" style="color:var(--s)">Roberto Sánchez</div>
      <div class="party">Juntos por el Perú</div>
      <div class="prob" style="color:var(--s)">${pctS.toFixed(1)}%</div>
    </div>
  </div>
  <div class="bar"><i style="width:${pctK}%;background:var(--k)"></i><i style="width:${pctS}%;background:var(--s)"></i></div>

  <div class="grid cols-3">
    <div class="card"><div class="label">Diferencia ACTUAL</div><div class="big">+${fmt(difActual)}</div>
      <div class="party">lidera ${liderActual} · ${(Math.abs(d.pctS_nac - d.pctK_nac) * 100).toFixed(3)} pts</div></div>
    <div class="card"><div class="label">Diferencia PROYECTADA</div><div class="big">+${fmt(difProy)}</div>
      <div class="party">tendería a ${liderProy} (media Monte Carlo)</div></div>
    <div class="card"><div class="label">Aporte neto pendientes</div><div class="big" style="color:var(--k)">+${fmt(Math.abs(mc.netPendiente))}</div>
      <div class="party">${mc.netPendiente > 0 ? 'favorece Keiko' : 'favorece Sánchez'} (voto del exterior)</div></div>
  </div>

  <div class="grid cols-3">
    <div class="card"><div class="label">Votos Sánchez</div><div class="big" style="font-size:24px">${fmt(d.votosS)}</div></div>
    <div class="card"><div class="label">Votos Keiko</div><div class="big" style="font-size:24px">${fmt(d.votosK)}</div></div>
    <div class="card"><div class="label">Actas en disputa (JEE)</div><div class="big" style="font-size:24px">${fmt(d.t.enviadasJee)}</div><div class="party">${fmt(d.t.pendientesJee)} mesas sin procesar</div></div>
  </div>

  <div class="h2">Desglose por ámbito (donde está la clave del resultado)</div>
  <div class="grid cols-2">${ambitoCards}</div>

  <div class="winner">Favorito según el modelo: <b style="color:${pctK >= pctS ? 'var(--k)' : 'var(--s)'}">${favorito}</b>
    — pero con probabilidad cercana al 50%: <b>EMPATE TÉCNICO</b>.</div>

  <div class="note">
    <b>Metodología:</b> Simulación Monte Carlo (${N_SIM.toLocaleString('es-PE')} iteraciones). Las mesas pendientes se
    reparten según el % de su propio ámbito (Perú vs Extranjero), donde el voto del exterior favorece fuertemente a Keiko.
    Las <b>${fmt(d.t.enviadasJee)} actas observadas en el JEE</b> no exponen su origen geográfico: se modelan con reparto
    incierto centrado en el % nacional (σ=${SD_JEE}), sin sesgar a ningún candidato.<br><br>
    <b>Advertencia:</b> el margen proyectado (~${fmt(difProy)} votos) es mucho menor que el universo de actas en el JEE.
    Cuando el margen es más chico que las actas en disputa, el resultado lo define el Jurado Electoral, NO el conteo.
    Esta probabilidad refleja incertidumbre real, no una predicción de alta confianza.
  </div>
</body></html>`;
}

async function generar(page) {
  const raw = await fetchData(page);
  const d = normalize(raw);
  const mc = montecarlo(d);
  return { d, mc };
}

async function runOnce() {
  console.log('Scrapeando ONPE y simulando...');
  const { browser, page } = await openBrowser();
  const { d, mc } = await generar(page);
  await browser.close();
  writeFileSync(OUT, html(d, mc, 0, Date.now()));
  logResumen(d, mc);
  console.log(`✓ Dashboard generado: ${OUT}`);
  if (!process.argv.includes('--no-open')) exec(`open "${OUT}"`);
}

async function runWatch(minutos) {
  const intervalMs = minutos * 60_000;
  const refreshSeconds = minutos * 60;

  // Mini servidor estático: lee el archivo en cada request (siempre la última versión).
  createServer((req, res) => {
    if (existsSync(OUT)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(OUT));
    } else {
      res.writeHead(503); res.end('Generando primer reporte...');
    }
  }).listen(PORT);
  const url = `http://localhost:${PORT}/`;
  console.log(`Monitor EN VIVO en ${url} (refresco cada ${minutos} min). Ctrl+C para detener.\n`);

  const { browser, page } = await openBrowser(); // Chrome se abre UNA sola vez
  let abierto = false;

  async function ciclo() {
    try {
      const { d, mc } = await generar(page);
      writeFileSync(OUT, html(d, mc, refreshSeconds, Date.now()));
      logResumen(d, mc, true);
      if (!abierto) { exec(`open "${url}"`); abierto = true; }
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString('es-PE')}] error en ciclo: ${e.message}`);
    }
  }

  await ciclo();
  setInterval(ciclo, intervalMs);

  const cerrar = async () => { await browser.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
}

function logResumen(d, mc, conHora = false) {
  const h = conHora ? `[${new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}] ` : '';
  console.log(`${h}Keiko ${(mc.probK * 100).toFixed(1)}% | Sánchez ${(mc.probS * 100).toFixed(1)}%  ·  ` +
    `dif actual ${fmt(Math.abs(d.margenActual))} · proy ${fmt(Math.abs(mc.margenProyMedio))} · actas ${d.t.actasContabilizadas.toFixed(2)}%`);
}

// Modo deploy: genera index.html con auto-refresh para hosting estático
// (usado por GitHub Actions). No abre navegador ni levanta servidor.
async function runDeploy(refreshMin) {
  console.log('Scrapeando ONPE para deploy...');
  const { browser, page } = await openBrowser();
  const { d, mc } = await generar(page);
  await browser.close();
  const outPath = `${process.cwd()}/index.html`;
  writeFileSync(outPath, html(d, mc, refreshMin * 60, Date.now()));
  logResumen(d, mc);
  console.log(`✓ index.html generado (auto-refresh cada ${refreshMin} min): ${outPath}`);
}

// ---- Entrada ----
const deployIdx = process.argv.indexOf('--deploy');
const watchIdx = process.argv.indexOf('--watch');
if (deployIdx !== -1) {
  const arg = process.argv[deployIdx + 1];
  const mins = arg && !arg.startsWith('--') ? Number(arg) : 5;
  runDeploy(Number.isFinite(mins) && mins > 0 ? mins : 5)
    .catch((e) => {
      // Bloqueo del anti-bot = skip silencioso (no falla la corrida de CI, no manda email).
      // Cualquier otro error sí falla, para no enmascarar bugs reales.
      if (e.antibot) { console.warn('SKIP:', e.message, '— se conserva el último snapshot.'); process.exit(0); }
      console.error('ERROR:', e.message); process.exit(1);
    });
} else if (watchIdx !== -1) {
  const arg = process.argv[watchIdx + 1];
  const mins = arg && !arg.startsWith('--') ? Number(arg) : 5;
  runWatch(Number.isFinite(mins) && mins > 0 ? mins : 5).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
} else {
  runOnce().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
