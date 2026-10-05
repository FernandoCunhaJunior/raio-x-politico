"use strict";

// Painel das eleições (painel.html). Dados: data/painel/AAAA.json e data/painel/indice.json (scripts/painel.py).
// Estado na URL: painel.html#ano=2022&uf=BA&cargo=GOVERNADOR&modo=voto&turno=2

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (x) => (x ?? 0).toLocaleString("pt-BR");
const fmtD = (x, d = 1) => x == null || !isFinite(x) ? "—" : x.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (x, d = 1) => x == null || !isFinite(x) ? "—" : `${fmtD(x, d)}%`;
const pct = (a, b) => (b ? (100 * a) / b : null);
const sinal = (x, d = 1, suf = "") => x == null || !isFinite(x) ? "" : `${x > 0 ? "+" : x < 0 ? "−" : "±"}${fmtD(Math.abs(x), d)}${suf}`;
const brl2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brlCurto = (v) => v == null ? "—" : v >= 1e9 ? `R$ ${fmtD(v / 1e9, 2)} bi` : v >= 1e6 ? `R$ ${fmtD(v / 1e6, 1)} mi`
  : v >= 1e3 ? `R$ ${fmtD(v / 1e3, 0)} mil` : `R$ ${fmtD(v, 0)}`;

let META = null, INDICE = null, MAPA = null;
const cache = new Map();
function getJson(url) {
  if (!cache.has(url)) {
    const fonte = META ? `${url}?v=${META.versao}` : url;
    cache.set(url, fetch(fonte, META ? {} : { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ao carregar ${url}`);
      return r.json();
    }));
  }
  return cache.get(url);
}

const NOMES_UF = { AC: "Acre", AL: "Alagoas", AM: "Amazonas", AP: "Amapá", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MG: "Minas Gerais", MS: "Mato Grosso do Sul", MT: "Mato Grosso", PA: "Pará",
  PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", PR: "Paraná", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RO: "Rondônia",
  RR: "Roraima", RS: "Rio Grande do Sul", SC: "Santa Catarina", SE: "Sergipe", SP: "São Paulo", TO: "Tocantins", BR: "Brasil",
  ZZ: "Exterior" };
const NOMES_CARGO = { TODOS: "Todos os cargos", PRESIDENTE: "Presidente", GOVERNADOR: "Governador", SENADOR: "Senador",
  "DEPUTADO FEDERAL": "Deputado federal", "DEPUTADO ESTADUAL": "Deputado estadual", "DEPUTADO DISTRITAL": "Deputado distrital",
  PREFEITO: "Prefeito", VEREADOR: "Vereador" };
const PLURAL_CARGO = { PRESIDENTE: "presidente", GOVERNADOR: "governadores", SENADOR: "senadores", "DEPUTADO FEDERAL": "deputados federais",
  "DEPUTADO ESTADUAL": "deputados estaduais", "DEPUTADO DISTRITAL": "deputados distritais", PREFEITO: "prefeitos", VEREADOR: "vereadores",
  TODOS: "eleitos" };
const LEGISLATIVOS = new Set(["DEPUTADO FEDERAL", "DEPUTADO ESTADUAL", "DEPUTADO DISTRITAL", "VEREADOR", "SENADOR"]);
const GRUPOS = ["Esquerda", "Centro-esquerda", "Centro", "Centro-direita", "Direita", "Sem classificação"];
const COR_ESP = ["#6b5cc2", "#a79fdb", "#9a9a9f", "#86aed0", "#3f78ad", "#cfccc6"]; // mesmas cores do site (style.css .esp-N)
const ABREV = { REPUBLICANOS: "REP", SOLIDARIEDADE: "SD", CIDADANIA: "CID", PATRIOTA: "PATRI", MOBILIZA: "MOB", DEMOCRATA: "DEM.", "PC do B": "PCdoB" };
const siglaCurta = (s) => ABREV[s] || s;
const tipoAno = (a) => (a % 4 === 0 ? "municipal" : "geral");

// ---------- Espectro (mesma regra de app.js) ----------
const siglaNorm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
function regra(sigla, ano) {
  const s = siglaNorm(sigla);
  return (META.espectro?.regras || []).find((x) => x[0] === s && ano >= x[1]) || null;
}
function grupoEspectro(sigla, ano) {
  const r = regra(sigla, ano);
  if (!r) return 5;
  const f = (META.espectro.faixas || []).find(([lim]) => r[3] <= lim)?.[1] || "";
  const g = f === "Extrema-esquerda" ? "Esquerda" : f === "Extrema-direita" ? "Direita" : f;
  return Math.max(0, GRUPOS.indexOf(g));
}
const notaPartido = (sigla, ano) => regra(sigla, ano)?.[3] ?? null;
const faixaNota = (n) => (META.espectro?.faixas || []).find(([lim]) => n <= lim)?.[1] || "";

// Escala divergente da nota ideológica (0 = esquerda, 10 = direita)
const PARADAS = [[1.5, [74, 58, 168]], [3, [123, 111, 201]], [4.5, [190, 184, 228]], [5, [222, 221, 227]],
  [5.5, [190, 211, 230]], [7, [111, 156, 204]], [8.5, [36, 86, 145]]];
function corNota(n) {
  if (n == null || !isFinite(n)) return null;
  if (n <= PARADAS[0][0]) return `rgb(${PARADAS[0][1]})`;
  for (let i = 1; i < PARADAS.length; i++) {
    const [b, cb] = PARADAS[i], [a, ca] = PARADAS[i - 1];
    if (n <= b) {
      const t = (n - a) / (b - a);
      return `rgb(${ca.map((x, k) => Math.round(x + (cb[k] - x) * t)).join(",")})`;
    }
  }
  return `rgb(${PARADAS[PARADAS.length - 1][1]})`;
}
const textoSobre = (n) => (n != null && (n < 3.2 || n > 6.8) ? "#fff" : "#1d1d1f");
// Escala sequencial (para %): do neutro ao vermelho UNAI
function corSeq(t) {
  if (t == null || !isFinite(t)) return null;
  const a = [238, 236, 233], b = [158, 18, 24];
  return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * Math.max(0, Math.min(1, t)))).join(",")})`;
}

// ---------- Estado na URL ----------
function lerEstado() {
  const h = new URLSearchParams(location.hash.slice(1));
  let ano = +h.get("ano");
  if (!INDICE.anos.includes(ano)) ano = INDICE.anos[INDICE.anos.length - 1];
  return { ano, uf: (h.get("uf") || "BR").toUpperCase(), cargo: h.get("cargo") || "TODOS", modo: h.get("modo") || "", turno: h.get("turno") || "" };
}
function irPara(e) {
  const h = new URLSearchParams();
  h.set("ano", e.ano);
  if (e.uf && e.uf !== "BR") h.set("uf", e.uf);
  if (e.cargo && e.cargo !== "TODOS") h.set("cargo", e.cargo);
  if (e.modo) h.set("modo", e.modo);
  if (e.turno) h.set("turno", e.turno);
  location.hash = h.toString();
}

// ---------- Dica flutuante ----------
let dica = null;
function ligarDicas() {
  dica = document.createElement("div");
  dica.className = "pn-dica";
  dica.hidden = true;
  document.body.appendChild(dica);
  const mostra = (ev) => {
    const alvo = ev.target.closest?.("[data-dica]");
    if (!alvo || !alvo.dataset.dica) { dica.hidden = true; return; }
    dica.innerHTML = alvo.dataset.dica;
    dica.hidden = false;
    const x = ev.clientX ?? 0, y = ev.clientY ?? 0;
    const r = dica.getBoundingClientRect();
    dica.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14))}px`;
    dica.style.top = `${y + r.height + 24 > window.innerHeight ? y - r.height - 12 : y + 16}px`;
  };
  document.addEventListener("mousemove", mostra);
  document.addEventListener("pointerdown", (ev) => { if (ev.pointerType !== "mouse") mostra(ev); });
  document.addEventListener("scroll", () => { dica.hidden = true; }, { passive: true });
}
const dicaAttr = (html) => `data-dica="${esc(html)}"`;

// ---------- Componentes ----------
function kpi(rot, val, { sub = "", delta = null, destaque = false, dicaHtml = "" } = {}) {
  const d = delta ? `<span class="pn-delta ${delta.cls || ""}">${delta.txt}</span>` : "";
  return `<div class="pn-kpi${destaque ? " destaque" : ""}"${dicaHtml ? " " + dicaAttr(dicaHtml) : ""}>
    <div class="rot">${rot}</div><div class="val">${val}</div>${d}${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}
const deltaPP = (a, b, ref) => (a == null || b == null ? null : { txt: `${sinal(a - b, 1, " p.p.")} vs ${ref}`, cls: a - b > 0 ? "sobe" : a - b < 0 ? "desce" : "" });
const deltaN = (a, b, ref) => (a == null || b == null || !b ? null : { txt: `${sinal(pct(a - b, b), 1, "%")} vs ${ref}`, cls: a > b ? "sobe" : a < b ? "desce" : "" });

function barraEsp(valores, { alt = 26, rotulos = true, dicaPre = "" } = {}) {
  const tot = valores.reduce((a, b) => a + b, 0);
  if (!tot) return `<div class="pn-esp-barra vazia" style="height:${alt}px"></div>`;
  return `<div class="pn-esp-barra" style="height:${alt}px">${valores.map((v, i) => v ? `<span style="width:${(100 * v) / tot}%;background:${COR_ESP[i]};color:${i === 1 || i === 3 || i === 5 ? "#1d1d1f" : "#fff"}"
    ${dicaAttr(`${dicaPre}<b>${GRUPOS[i]}</b>: ${fmtPct(pct(v, tot))} (${fmtN(v)})`)}>${rotulos && (100 * v) / tot >= 9 ? Math.round((100 * v) / tot) + "%" : ""}</span>` : "").join("")}</div>`;
}
const legendaEsp = () => `<div class="pn-leg">${GRUPOS.map((g, i) => `<span><i style="background:${COR_ESP[i]}"></i>${g}</span>`).join("")}</div>`;
function reguaNota() {
  const pts = [];
  for (let n = 0; n <= 10; n += 0.25) pts.push(`${corNota(n)} ${n * 10}%`);
  return `<div class="pn-regua"><div class="trilho" style="background:linear-gradient(90deg, ${pts.join(",")})"></div>
    <div class="rot"><span>0 · esquerda</span><span>centro · 5</span><span>direita · 10</span></div></div>`;
}

// ---------- Mapa ----------
function defsMapa() {
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${MAPA.locations.map((l) =>
    `<path id="uf-${l.id.toUpperCase()}" d="${l.path}"/>`).join("")}</defs></svg>`;
}
const centros = {};
function calcularCentros() {
  const svg = document.querySelector(".pn-defs-medir");
  if (!svg) return;
  for (const p of svg.querySelectorAll("path")) {
    const b = p.getBBox();
    centros[p.dataset.uf] = [b.x + b.width / 2, b.y + b.height / 2];
  }
  // ajustes de rótulo em estados de formato irregular
  const aj = { GO: [0, 8], PE: [18, 0], MA: [-6, 10], AL: [10, 2], RN: [8, -2], PB: [16, 0], SE: [8, 4], ES: [8, 4], RJ: [8, 4], SC: [6, 0], PA: [-10, 0], MG: [6, 4] };
  for (const [uf, [dx, dy]] of Object.entries(aj)) if (centros[uf]) { centros[uf][0] += dx; centros[uf][1] += dy; }
}
// valores: {UF: {cor, rot?, dica}}
function mapaSvg(valores, { ufAtual = "BR", rotulos = true, classe = "", clicavel = true } = {}) {
  const peq = new Set(["DF", "SE", "AL", "RN", "PB", "ES", "RJ", "PE"]);
  return `<svg class="pn-mapa ${classe}" viewBox="${MAPA.viewBox}" role="img" aria-label="Mapa do Brasil por estado">
    ${MAPA.locations.map((l) => {
      const uf = l.id.toUpperCase(), v = valores[uf] || {};
      return `<use href="#uf-${uf}" class="${uf === ufAtual ? "atual" : ""}${clicavel ? " clic" : ""}" data-uf="${uf}"
        style="fill:${v.cor || "var(--surface-2)"}" ${clicavel ? dicaAttr(v.dica || `<b>${esc(NOMES_UF[uf])}</b><br>sem dado`) : (v.dica ? dicaAttr(v.dica) : "")}/>`;
    }).join("")}
    ${rotulos ? MAPA.locations.map((l) => {
      const uf = l.id.toUpperCase(), v = valores[uf] || {}, c = centros[uf];
      if (!c || !v.rot) return "";
      return `<text x="${c[0]}" y="${c[1]}" class="${peq.has(uf) ? "peq" : ""}" style="fill:${v.corTexto || "#1d1d1f"}">${esc(v.rot)}</text>`;
    }).join("") : ""}
  </svg>`;
}

// ---------- Gráficos ----------
// Hemiciclo: cadeiras por partido, da esquerda para a direita
function hemiciclo(partidos) {
  const N = partidos.reduce((a, p) => a + p.n, 0);
  if (!N) return "";
  const R = Math.max(1, Math.min(16, Math.round(Math.sqrt(N) / 2.1)));
  const r0 = R === 1 ? 1 : 0.42, raios = Array.from({ length: R }, (_, i) => (R === 1 ? 1 : r0 + ((1 - r0) * i) / (R - 1)));
  const soma = raios.reduce((a, b) => a + b, 0);
  const porFila = raios.map((r) => Math.max(1, Math.round((N * r) / soma)));
  let dif = N - porFila.reduce((a, b) => a + b, 0);
  for (let i = R - 1, guarda = 0; dif !== 0 && guarda < 10000; i = (i - 1 + R) % R, guarda++) {
    if (dif > 0) { porFila[i]++; dif--; } else if (porFila[i] > 1) { porFila[i]--; dif++; }
  }
  const assentos = [];
  raios.forEach((r, i) => {
    const n = porFila[i];
    for (let k = 0; k < n; k++) {
      const ang = n === 1 ? Math.PI / 2 : Math.PI - (Math.PI * k) / (n - 1);
      assentos.push({ ang, r, x: r * Math.cos(ang), y: r * Math.sin(ang) });
    }
  });
  assentos.sort((a, b) => b.ang - a.ang || a.r - b.r);
  const passo = R === 1 ? 0.5 : (1 - r0) / (R - 1);
  const rCad = Math.min(passo * 0.42, ...raios.map((r, i) => ((Math.PI * r) / Math.max(1, porFila[i] - 1)) * 0.42)) || 0.04;
  const ordem = [...partidos].sort((a, b) => (a.nota ?? 5) - (b.nota ?? 5));
  let k = 0;
  const pts = ordem.flatMap((p) => Array.from({ length: p.n }, () => {
    const a = assentos[k++];
    return `<circle cx="${(a.x + 1.1).toFixed(4)}" cy="${(1.08 - a.y).toFixed(4)}" r="${rCad.toFixed(4)}" fill="${COR_ESP[p.g]}"
      ${dicaAttr(`<b>${esc(p.sigla)}</b>: ${fmtN(p.n)} cadeira${p.n > 1 ? "s" : ""}<br>${GRUPOS[p.g]}${p.nota != null ? ` · nota ${fmtD(p.nota, 2)}` : ""}`)}/>`;
  }));
  return `<svg class="pn-hemiciclo" viewBox="0 0 2.2 1.16" role="img" aria-label="Distribuição de ${N} cadeiras por partido">${pts.join("")}
    <text x="1.1" y="1.06" text-anchor="middle" class="tot">${fmtN(N)}</text></svg>`;
}

// Área empilhada 100% ao longo dos anos. series: [{ano, vals[6]}]
function areaEmpilhada(series, { alt = 230 } = {}) {
  if (series.length < 2) return `<p class="muted">Série histórica indisponível para este recorte.</p>`;
  const W = 620, H = alt, M = { l: 40, r: 10, t: 10, b: 26 };
  const x = (i) => M.l + (i / (series.length - 1)) * (W - M.l - M.r);
  const y = (f) => M.t + (1 - f) * (H - M.t - M.b);
  const acum = series.map((s) => { const t = s.vals.reduce((a, b) => a + b, 0) || 1; let c = 0; return s.vals.map((v) => (c += v / t)); });
  const camadas = GRUPOS.map((g, k) => {
    const topo = series.map((_, i) => `${x(i)},${y(acum[i][k])}`);
    const base = series.map((_, i) => `${x(i)},${y(k ? acum[i][k - 1] : 0)}`).reverse();
    return `<polygon points="${[...topo, ...base].join(" ")}" fill="${COR_ESP[k]}" ${dicaAttr(`<b>${g}</b><br>${series.map((s) => {
      const t = s.vals.reduce((a, b) => a + b, 0); return `${s.ano}: ${fmtPct(pct(s.vals[k], t))}`; }).join("<br>")}`)}/>`;
  }).join("");
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(f)}" y2="${y(f)}" class="grade"/>
    <text x="${M.l - 5}" y="${y(f) + 4}" text-anchor="end" class="eixo">${f * 100}%</text>`).join("");
  const ex = series.map((s, i) => `<text x="${x(i)}" y="${H - 7}" text-anchor="${i === series.length - 1 ? "end" : i ? "middle" : "start"}" class="eixo">${s.ano}</text>`).join("");
  return `<svg class="pn-graf" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução por espectro">${camadas}${grade}${ex}</svg>`;
}

// Linhas. series: [{nome, cor, tracejado?, pontos: [[ano, v]]}]
function graficoLinhas(series, { min = 0, max = null, suf = "%", fundoNota = false, alt = 220, dec = 0 } = {}) {
  const anos = [...new Set(series.flatMap((s) => s.pontos.filter((p) => p[1] != null).map((p) => p[0])))].sort((a, b) => a - b);
  if (anos.length < 2) return `<p class="muted">Série histórica indisponível para este recorte.</p>`;
  const vals = series.flatMap((s) => s.pontos.map((p) => p[1])).filter((v) => v != null);
  const top = max ?? Math.max(5, Math.ceil((Math.max(...vals) * 1.15) / 5) * 5);
  const W = 620, H = alt, M = { l: 44, r: 12, t: 12, b: 26 };
  const x = (a) => M.l + (anos.indexOf(a) / (anos.length - 1)) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - (v - min) / (top - min)) * (H - M.t - M.b);
  let fundo = "";
  if (fundoNota) {
    const pts = []; for (let n = min; n <= top; n += 0.5) pts.push(`<stop offset="${((n - min) / (top - min)) * 100}%" stop-color="${corNota(n)}"/>`);
    fundo = `<defs><linearGradient id="gNota" x1="0" y1="1" x2="0" y2="0">${pts.join("")}</linearGradient></defs>
      <rect x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="url(#gNota)" opacity=".3"/>`;
  }
  const passos = dec === 0 && top - min <= 10 && Number.isInteger(top - min) ? top - min : 4, grade = Array.from({ length: passos + 1 }, (_, i) => min + ((top - min) * i) / passos).map((v) =>
    `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" class="grade"/><text x="${M.l - 5}" y="${y(v) + 4}" text-anchor="end" class="eixo">${fmtD(v, dec)}${suf}</text>`).join("");
  const ex = anos.map((a, i) => `<text x="${x(a)}" y="${H - 7}" text-anchor="${i === anos.length - 1 ? "end" : i ? "middle" : "start"}" class="eixo">${a}</text>`).join("");
  const ls = series.map((s) => {
    const p = s.pontos.filter((q) => q[1] != null && anos.includes(q[0]));
    if (!p.length) return "";
    return `<g><polyline points="${p.map((q) => `${x(q[0])},${y(q[1])}`).join(" ")}" fill="none" stroke="${s.cor}" stroke-width="3" ${s.tracejado ? 'stroke-dasharray="7 5"' : ""} stroke-linejoin="round"/>
      ${p.map((q) => `<circle cx="${x(q[0])}" cy="${y(q[1])}" r="5" fill="${s.cor}" stroke="var(--surface)" stroke-width="2" ${dicaAttr(`<b>${esc(s.nome)}</b><br>${q[0]}: ${fmtD(q[1], dec || 1)}${suf}`)}/>`).join("")}</g>`;
  }).join("");
  return `<svg class="pn-graf" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução ao longo dos anos">${fundo}${grade}${ex}${ls}</svg>
    <div class="pn-leg">${series.map((s) => `<span><i style="background:${s.cor}"></i>${esc(s.nome)}${s.tracejado ? " (tracejado)" : ""}</span>`).join("")}</div>`;
}

// Barras horizontais (HTML). itens: [{rot, v, txt, cor?, sub?, dica?, ponto?}]
function barrasH(itens, { max = null, cor = "var(--vermelho)" } = {}) {
  if (!itens.length) return `<p class="muted">Sem dados.</p>`;
  const m = max ?? Math.max(...itens.map((i) => Math.abs(i.v)), 1e-9);
  return `<div class="pn-barras">${itens.map((i) => `<div class="pn-bl" ${i.dica ? dicaAttr(i.dica) : ""}>
    <span class="pn-bl-rot">${i.ponto != null ? `<i class="pn-ponto" style="background:${COR_ESP[i.ponto]}"></i>` : ""}<span>${esc(i.rot)}${i.sub ? `<small>${esc(i.sub)}</small>` : ""}</span></span>
    <span class="pn-bl-pista"><span style="width:${Math.max(0.5, (100 * Math.abs(i.v)) / m)}%;background:${i.cor || cor}"></span></span>
    <b>${i.txt}</b></div>`).join("")}</div>`;
}

// Barras divergentes (ganhos e perdas)
function barrasDiv(itens) {
  if (!itens.length) return `<p class="muted">Sem variação em relação à eleição anterior.</p>`;
  const m = Math.max(...itens.map((i) => Math.abs(i.v)), 1);
  return `<div class="pn-div">${itens.map((i) => `<div class="pn-div-l" ${dicaAttr(i.dica)}>
    <span class="pn-div-rot"><i class="pn-ponto" style="background:${COR_ESP[i.ponto]}"></i>${esc(i.rot)}</span>
    <span class="pn-div-neg">${i.v < 0 ? `<b>${sinal(i.v, 0)}</b><span style="width:${(100 * -i.v) / m}%"></span>` : ""}</span>
    <span class="pn-div-pos">${i.v > 0 ? `<span style="width:${(100 * i.v) / m}%"></span><b>${sinal(i.v, 0)}</b>` : ""}</span></div>`).join("")}</div>`;
}

// Colunas (taxa de sucesso por faixa)
function colunas(itens, { suf = "%" } = {}) {
  const m = Math.max(...itens.map((i) => i.v || 0), 1e-9);
  return `<div class="pn-cols">${itens.map((i) => `<div class="pn-col" ${dicaAttr(i.dica || "")}>
    <b>${fmtD(i.v, i.v < 1 ? 2 : 1)}${suf}</b><span class="pista"><span style="height:${Math.max(1, (100 * (i.v || 0)) / m)}%"></span></span>
    <small>${esc(i.rot)}</small></div>`).join("")}</div>`;
}

// Pirâmide etária (gênero x idade); idx 0 = candidaturas, 1 = eleitos
const FAIXAS_IDADE = ["Até 29", "30 a 39", "40 a 49", "50 a 59", "60 ou mais"];
function piramide(pir, idx, titulo, escalaMax) {
  const F = pir.Feminino.map((x) => x[idx]), Mm = pir.Masculino.map((x) => x[idx]);
  const tot = [...F, ...Mm].reduce((a, b) => a + b, 0);
  if (!tot) return "";
  const m = escalaMax || Math.max(...F, ...Mm) / tot * 100 || 1;
  const sF = F.reduce((a, b) => a + b, 0), sM = Mm.reduce((a, b) => a + b, 0);
  return `<div class="pn-pir"><div class="pn-pir-tit">${titulo} <small>(${fmtN(tot)})</small></div>
    <div class="pn-pir-cab"><span class="f">Mulheres · ${fmtPct(pct(sF, tot))}</span><span></span><span class="m">Homens · ${fmtPct(pct(sM, tot))}</span></div>
    ${[4, 3, 2, 1, 0].map((i) => `<div class="pn-pir-l">
      <span class="f" ${dicaAttr(`Mulheres, ${FAIXAS_IDADE[i]}: ${fmtN(F[i])} (${fmtPct(pct(F[i], tot))})`)}><b>${fmtPct(pct(F[i], tot), 0)}</b><span style="width:${(pct(F[i], tot) / m) * 100}%"></span></span>
      <span class="idade">${FAIXAS_IDADE[i]}</span>
      <span class="m" ${dicaAttr(`Homens, ${FAIXAS_IDADE[i]}: ${fmtN(Mm[i])} (${fmtPct(pct(Mm[i], tot))})`)}><span style="width:${(pct(Mm[i], tot) / m) * 100}%"></span><b>${fmtPct(pct(Mm[i], tot), 0)}</b></span>
    </div>`).join("")}</div>`;
}

// ---------- Dados derivados ----------
const turnoFinal = (v) => (v ? String(Math.max(...Object.keys(v).map(Number))) : null);
// Valor de um estado para o mapa no modo escolhido
function valorMapa(d, e, uf, modo, turno) {
  const b = d.g[`${uf}|${e.cargo}`];
  const nome = `<b>${esc(NOMES_UF[uf])}</b>`;
  if (modo === "abst") {
    const p = d.part[`${uf}|${e.cargo}`]?.[turno] || d.part[`${uf}|${e.cargo}`]?.["1"];
    if (!p || !p[0]) return { dica: `${nome}<br>sem dado` };
    const v = pct(p[2], p[0]);
    return { num: v, rot: fmtD(v, 1), dica: `${nome}<br>Abstenção: <b>${fmtPct(v, 2)}</b><br>${fmtN(p[2])} de ${fmtN(p[0])} eleitores` };
  }
  if (!b) return { dica: `${nome}<br>sem dado` };
  if (modo === "voto") {
    const v = b.votos?.[turno] || b.votos?.["1"];
    if (!v || v.nota == null) return { dica: `${nome}<br>sem votação nesta base` };
    const t = v.esp.reduce((a, c) => a + c, 0);
    return { cor: corNota(v.nota), num: v.nota, rot: fmtD(v.nota, 1), corTexto: textoSobre(v.nota), esp: v.esp,
      dica: `${nome}<br>Índice do voto: <b>${fmtD(v.nota, 2)}</b> (${esc(faixaNota(v.nota))})<br>${GRUPOS.map((g, i) => v.esp[i] ? `${g}: ${fmtPct(pct(v.esp[i], t))}` : "").filter(Boolean).join("<br>")}` };
  }
  if (modo === "eleitos") {
    if (b.so_votos || b.nota == null) return { dica: `${nome}<br>sem eleitos classificados` };
    const el = b.esp.map((x) => x[1]), t = el.reduce((a, c) => a + c, 0);
    return { cor: corNota(b.nota), num: b.nota, rot: fmtD(b.nota, 1), corTexto: textoSobre(b.nota), esp: el,
      dica: `${nome}<br>Índice dos eleitos: <b>${fmtD(b.nota, 2)}</b> (${esc(faixaNota(b.nota))})<br>${fmtN(t)} eleitos<br>${GRUPOS.map((g, i) => el[i] ? `${g}: ${fmtN(el[i])}` : "").filter(Boolean).join("<br>")}` };
  }
  if (modo === "vencedor") {
    let sig = null, det = "";
    const porVoto = e.cargo === "PRESIDENTE" || (e.cargo === "TODOS" && tipoAno(e.ano) === "geral");
    if (porVoto && b.votos) {
      const v = b.votos[turno] || b.votos[turnoFinal(b.votos)];
      if (v?.top?.length) { sig = v.top[0][0]; det = `${fmtPct(pct(v.top[0][1], v.total))} dos votos válidos${v.top[1] ? `<br>2º: ${esc(v.top[1][0])} (${fmtPct(pct(v.top[1][1], v.total))})` : ""}`; }
    } else if (!porVoto) {
      const cargoVenc = e.cargo === "TODOS" ? "PREFEITO" : e.cargo;
      const bb = e.cargo === "TODOS" ? d.g[`${uf}|${cargoVenc}`] : b;
      const p = bb?.partidos?.filter((x) => x[2]) || [];
      if (p.length) { sig = p[0][0]; det = `${fmtN(p[0][2])} de ${fmtN(bb.n[1])} ${PLURAL_CARGO[cargoVenc]} eleitos${p[1] ? `<br>2º: ${esc(p[1][0])} (${fmtN(p[1][2])})` : ""}`; }
    }
    if (!sig) return { dica: `${nome}<br>sem dado` };
    const g = grupoEspectro(sig, e.ano);
    return { cor: COR_ESP[g], rot: siglaCurta(sig), corTexto: g === 1 || g === 3 || g === 5 ? "#1d1d1f" : "#fff", sig, g,
      dica: `${nome}<br><b>${esc(sig)}</b> · ${GRUPOS[g]}<br>${det}` };
  }
  if (modo === "mulheres") {
    if (b.so_votos || !b.n[1]) return { dica: `${nome}<br>sem dado` };
    const f = b.perfil.genero.Feminino || [0, 0];
    const v = pct(f[1], b.n[1]);
    return { num: v, rot: fmtD(v, 0), dica: `${nome}<br>Mulheres eleitas: <b>${fmtPct(v)}</b> (${fmtN(f[1])} de ${fmtN(b.n[1])})` };
  }
  if (modo === "barradas") {
    if (b.so_votos) return { dica: `${nome}<br>sem dado` };
    const n = (b.restr.sit.Indeferida || 0) + (b.restr.sit.Cassada || 0), v = pct(n, b.n[0]);
    return { num: v, rot: fmtD(v, 1), dica: `${nome}<br>Indeferidas ou cassadas: <b>${fmtPct(v)}</b> (${fmtN(n)} de ${fmtN(b.n[0])})` };
  }
  return {};
}
function coresSequenciais(vals) {
  const ns = Object.values(vals).map((v) => v.num).filter((x) => x != null && isFinite(x));
  if (!ns.length) return null;
  const a = Math.min(...ns), b = Math.max(...ns);
  for (const v of Object.values(vals)) if (v.num != null) {
    const t = b === a ? 0.6 : (v.num - a) / (b - a);
    v.cor = corSeq(0.08 + 0.92 * t);
    v.corTexto = t > 0.55 ? "#fff" : "#1d1d1f";
  }
  return [a, b];
}

const MODOS = {
  voto: { rot: "Viés do voto", dica: "Média da nota ideológica dos partidos, ponderada pelos votos válidos de cada partido (2014 em diante)." },
  eleitos: { rot: "Viés dos eleitos", dica: "Média da nota ideológica dos partidos dos eleitos (cada eleito conta 1)." },
  vencedor: { rot: "Quem venceu", dica: "Partido mais votado (presidente) ou com mais eleitos no estado." },
  mulheres: { rot: "Mulheres eleitas", dica: "% de mulheres entre os eleitos." },
  barradas: { rot: "Candidaturas barradas", dica: "% de candidaturas indeferidas ou cassadas." },
  abst: { rot: "Abstenção", dica: "% do eleitorado que não votou (2014 em diante)." },
};
function modosDisponiveis(d, e) {
  const temVoto = Object.entries(d.g).some(([k, b]) => k.endsWith(`|${e.cargo}`) && b.votos);
  const out = [];
  if (temVoto) out.push("voto");
  if (e.cargo !== "PRESIDENTE") out.push("eleitos");
  out.push("vencedor");
  if (e.cargo !== "PRESIDENTE") out.push("mulheres", "barradas");
  if (Object.keys(d.part).length) out.push("abst");
  return out;
}

// ---------- Seções ----------
function secResumo(d, e, b, ant, bAnt) {
  if (b.so_votos) {
    const v = b.votos[turnoFinal(b.votos)];
    return `<div class="pn-kpis">${v.top.slice(0, 4).map(([s, n], i) => kpi(i ? `${i + 1}º mais votado` : "Mais votado no estado", esc(s),
      { destaque: !i, sub: `${fmtPct(pct(n, v.total))} dos votos válidos · ${fmtN(n)} votos` })).join("")}
      ${v.nota != null ? kpi("Índice do voto", fmtD(v.nota, 2), { sub: `${esc(faixaNota(v.nota))} · escala 0 (esq.) a 10 (dir.)`, dicaHtml: MODOS.voto.dica }) : ""}</div>`;
  }
  const [cand, el] = b.n;
  const fem = b.perfil.genero.Feminino || [0, 0];
  const femAnt = bAnt?.perfil?.genero?.Feminino;
  const dir = b.esp[3][1] + b.esp[4][1], esq = b.esp[0][1] + b.esp[1][1];
  const dirAnt = bAnt?.esp ? bAnt.esp[3][1] + bAnt.esp[4][1] : null;
  const p = d.part[`${e.uf}|${e.cargo}`]?.["1"], pA = ant?.part?.[`${e.uf}|${e.cargo}`]?.["1"];
  const abst = p ? pct(p[2], p[0]) : null, abstA = pA ? pct(pA[2], pA[0]) : null;
  const vf = b.votos?.["1"];
  if (e.cargo === "PRESIDENTE") return resumoPresidente(d, e, b, ant, bAnt, abst, abstA, p);
  return `<div class="pn-kpis">
    ${kpi("Candidaturas", fmtN(cand), { destaque: true, delta: deltaN(cand, bAnt?.n?.[0], ant?.ano), sub: `${fmtN(el)} eleitos · ${fmtD(cand / Math.max(1, el), 1)} por vaga` })}
    ${kpi("Índice ideológico dos eleitos", b.nota != null ? fmtD(b.nota, 2) : "—", { sub: b.nota != null ? `${esc(faixaNota(b.nota))} · escala 0 (esq.) a 10 (dir.)` : "", delta: b.nota != null && bAnt?.nota != null ? { txt: `${sinal(b.nota - bAnt.nota, 2)} vs ${ant.ano}`, cls: "" } : null, dicaHtml: MODOS.eleitos.dica })}
    ${vf?.nota != null ? kpi(`Índice do voto${b.votos_cargo !== e.cargo ? ` (${NOMES_CARGO[b.votos_cargo].toLowerCase()})` : ""}`, fmtD(vf.nota, 2), { sub: `${esc(faixaNota(vf.nota))} · 1º turno, ponderado pelos votos válidos`, dicaHtml: MODOS.voto.dica }) : ""}
    ${kpi("Direita + centro-direita", fmtPct(pct(dir, el)), { sub: `dos eleitos · esquerda + centro-esquerda: ${fmtPct(pct(esq, el))}`, delta: deltaPP(pct(dir, el), dirAnt != null ? pct(dirAnt, bAnt.n[1]) : null, ant?.ano) })}
    ${kpi("Mulheres eleitas", fmtPct(pct(fem[1], el)), { sub: `${fmtN(fem[1])} eleitas · eram ${fmtPct(pct(fem[0], cand))} das candidaturas`, delta: deltaPP(pct(fem[1], el), femAnt ? pct(femAnt[1], bAnt.n[1]) : null, ant?.ano) })}
    ${kpi("Estreantes eleitos", fmtPct(pct(b.ren[2], el)), { sub: `venceram na 1ª candidatura · ${fmtPct(pct(b.ren[0], el))} reeleitos para o mesmo cargo` })}
    ${abst != null ? kpi("Abstenção", fmtPct(abst, 2), { sub: `1º turno · ${fmtN(p[2])} eleitores`, delta: abstA != null ? { txt: `${sinal(abst - abstA, 1, " p.p.")} vs ${ant.ano}`, cls: "" } : null }) : ""}
    ${b.din?.pub_total != null ? kpi("Verba pública", brlCurto(b.din.pub_total), { sub: "Fundo Eleitoral + Fundo Partidário nas campanhas" }) : ""}
  </div>`;
}

// Presidente: um eleito só — o resumo mostra a disputa
function resumoPresidente(d, e, b, ant, bAnt, abst, abstA, p) {
  const [cand] = b.n;
  const fem = b.perfil.genero.Feminino || [0, 0];
  const t1 = b.votos?.["1"], t2 = b.votos?.["2"];
  const disputa = (v, t) => v?.top?.length ? kpi(`${t}º turno`, `${esc(v.top[0][0])} ${fmtPct(pct(v.top[0][1], v.total))}`,
    { destaque: t === (t2 ? 2 : 1), sub: v.top.slice(1, 3).map(([s, n]) => `${esc(s)} ${fmtPct(pct(n, v.total))}`).join(" · ") }) : "";
  const venc = b.partidos.find((x) => x[2]);
  return `<div class="pn-kpis">
    ${disputa(t2, 2)}${disputa(t1, 1)}
    ${venc ? kpi("Eleito", esc(venc[0]), { sub: `${GRUPOS[grupoEspectro(venc[0], e.ano)]}${notaPartido(venc[0], e.ano) != null ? ` · nota ${fmtD(notaPartido(venc[0], e.ano), 2)}` : ""}` }) : ""}
    ${t1?.nota != null ? kpi("Índice do voto", fmtD(t1.nota, 2), { sub: `${esc(faixaNota(t1.nota))} · 1º turno, ponderado pelos votos válidos`,
      delta: bAnt?.votos?.["1"]?.nota != null ? { txt: `${sinal(t1.nota - bAnt.votos["1"].nota, 2)} vs ${ant.ano}`, cls: "" } : null, dicaHtml: MODOS.voto.dica }) : ""}
    ${kpi("Candidaturas", fmtN(cand), { sub: `${fmtN(fem[0])} de mulheres` })}
    ${abst != null ? kpi("Abstenção", fmtPct(abst, 2), { sub: `1º turno · ${fmtN(p[2])} eleitores`, delta: abstA != null ? { txt: `${sinal(abst - abstA, 1, " p.p.")} vs ${ant.ano}`, cls: "" } : null }) : ""}
    ${b.din?.pub_total != null ? kpi("Verba pública", brlCurto(b.din.pub_total), { sub: "nas campanhas presidenciais" }) : ""}
  </div>`;
}

function destaques(d, e, b, ant, bAnt) {
  const itens = [];
  if (b.so_votos) return "";
  const [cand, el] = b.n;
  const plural = PLURAL_CARGO[e.cargo];
  const part = b.partidos.filter((x) => x[2]);
  const vf = b.votos?.[turnoFinal(b.votos)];
  if (vf?.top?.length > 1 && (b.votos_cargo === "PRESIDENTE" || b.votos_cargo === "GOVERNADOR")) {
    const t = turnoFinal(b.votos);
    itens.push(`${NOMES_CARGO[b.votos_cargo]}${t === "2" ? ", 2º turno" : ""}${e.uf !== "BR" ? ` em ${esc(NOMES_UF[e.uf])}` : ""}: <b>${esc(vf.top[0][0])}</b> teve ${fmtPct(pct(vf.top[0][1], vf.total))} dos votos válidos, contra ${fmtPct(pct(vf.top[1][1], vf.total))} do ${esc(vf.top[1][0])}.`);
  }
  if (e.cargo === "PRESIDENTE" && b.votos?.["1"]?.esp) {
    const v = b.votos["1"], t = v.total;
    itens.push(`No 1º turno, partidos de esquerda e centro-esquerda somaram <b>${fmtPct(pct(v.esp[0] + v.esp[1], t), 0)}</b> dos votos válidos; direita e centro-direita, <b>${fmtPct(pct(v.esp[3] + v.esp[4], t), 0)}</b>.`);
  }
  if (part.length && el > 1 && e.cargo !== "PRESIDENTE") {
    const [s, , n, a] = part[0];
    itens.push(`<b>${esc(s)}</b> foi o partido que mais elegeu: ${fmtN(n)} ${plural}${bAnt ? ` (${a ? `${sinal(n - a, 0)} em relação a ${ant.ano}` : `não tinha eleitos com essa sigla em ${ant.ano}`})` : ""}.`);
  }
  if (bAnt && el >= 5) {
    const ganhos = b.partidos.filter((x) => x[2] - x[3] !== 0).sort((x, y) => (y[2] - y[3]) - (x[2] - x[3]));
    if (ganhos.length > 1 && ganhos[0][2] - ganhos[0][3] > 0) {
      const g = ganhos[0], p = ganhos[ganhos.length - 1];
      itens.push(`Maior crescimento: <b>${esc(g[0])}</b> (${sinal(g[2] - g[3], 0)}${g[4] ? `, comparado a ${esc(g[4])}` : ""}). Maior queda: <b>${esc(p[0])}</b> (${sinal(p[2] - p[3], 0)}).`);
    }
  }
  if (e.cargo === "PRESIDENTE") return itens.length ? `<ul class="pn-destaques">${itens.map((i) => `<li>${i}</li>`).join("")}</ul>` : "";
  const dir = pct(b.esp[3][1] + b.esp[4][1], el), esq = pct(b.esp[0][1] + b.esp[1][1], el), cen = pct(b.esp[2][1], el);
  if (el > 2) itens.push(`Entre os eleitos, <b>${fmtPct(dir, 0)}</b> são de partidos de direita ou centro-direita, <b>${fmtPct(esq, 0)}</b> de esquerda ou centro-esquerda e ${fmtPct(cen, 0)} de centro${b.esp[5][1] ? ` (${fmtPct(pct(b.esp[5][1], el), 0)} em partidos sem classificação, como União e PRD)` : ""}.`);
  if (b.din?.frec) {
    const f = b.din.frec, alto = f[4], baixo = [f[0][0] + f[1][0], f[0][1] + f[1][1]];
    if (alto[0] >= 20 && baixo[0] >= 20) itens.push(`Dinheiro pesa: quem arrecadou mais de R$ 1 milhão teve <b>${fmtPct(pct(alto[1], alto[0]), 0)}</b> de chance de se eleger; abaixo de R$ 50 mil, <b>${fmtPct(pct(baixo[1], baixo[0]), 1)}</b>.`);
  }
  const fem = b.perfil.genero.Feminino || [0, 0];
  if (el > 2) itens.push(`Mulheres foram ${fmtPct(pct(fem[0], cand), 0)} das candidaturas, mas só <b>${fmtPct(pct(fem[1], el), 0)}</b> dos eleitos.`);
  return itens.length ? `<ul class="pn-destaques">${itens.map((i) => `<li>${i}</li>`).join("")}</ul>` : "";
}

function secMapa(d, e, b) {
  const modos = modosDisponiveis(d, e);
  const modo = modos.includes(e.modo) ? e.modo : modos[0];
  const comTurno = modo === "voto" || modo === "vencedor" || modo === "abst";
  const temT2 = comTurno && (modo === "abst" ? Object.values(d.part).some((x) => x["2"])
    : Object.entries(d.g).some(([k, x]) => k.endsWith(`|${e.cargo}`) && x.votos?.["2"]));
  const turno = temT2 ? (e.turno || "1") : "1";
  const ufs = d.ufs.filter((u) => u !== "ZZ");
  const vals = Object.fromEntries(ufs.map((u) => [u, valorMapa(d, e, u, modo, turno)]));
  let escala = "";
  if (modo === "voto" || modo === "eleitos") escala = reguaNota();
  else if (modo === "vencedor") {
    const cont = {};
    for (const [u, v] of Object.entries(vals)) if (v.sig) { (cont[v.sig] = cont[v.sig] || { n: 0, g: v.g, ufs: [] }).n++; cont[v.sig].ufs.push(u); }
    escala = `<div class="pn-venc">${Object.entries(cont).sort((a, c) => c[1].n - a[1].n).map(([s, c]) =>
      `<span ${dicaAttr(c.ufs.join(", "))}><i style="background:${COR_ESP[c.g]}"></i><b>${esc(s)}</b> ${c.n} estado${c.n > 1 ? "s" : ""}</span>`).join("")}</div>`;
  } else {
    const ext = coresSequenciais(vals);
    if (ext) escala = `<div class="pn-escala-seq"><span>${fmtPct(ext[0])}</span><i></i><span>${fmtPct(ext[1])}</span></div>`;
  }
  // Ranking lateral
  const lista = Object.entries(vals).filter(([, v]) => v.num != null || v.sig);
  if (modo === "voto" || modo === "eleitos") lista.sort((a, c) => a[1].num - c[1].num);
  else if (modo === "vencedor") lista.sort((a, c) => a[1].g - c[1].g || a[1].sig.localeCompare(c[1].sig) || a[0].localeCompare(c[0]));
  else lista.sort((a, c) => c[1].num - a[1].num);
  const maxNum = Math.max(...lista.map((x) => x[1].num || 0), 1e-9);
  const ranking = `<ol class="pn-ranking">${lista.map(([u, v]) => `<li class="${u === e.uf ? "atual" : ""}" data-uf="${u}" ${dicaAttr(v.dica)}>
      <span class="uf">${u}</span>
      ${v.esp ? barraEsp(v.esp, { alt: 14, rotulos: false }) : modo === "vencedor" ? `<span class="pn-tag" style="background:${v.cor};color:${v.corTexto}">${esc(v.sig)}</span>`
        : `<span class="pn-rk-pista"><span style="width:${Math.max(2, (v.num / maxNum) * 100)}%;background:${v.cor}"></span></span>`}
      <b>${v.esp ? fmtD(v.num, 2) : modo === "vencedor" ? "" : fmtPct(v.num, modo === "abst" ? 2 : 1)}</b></li>`).join("")}</ol>`;
  const tit = modo === "voto" || modo === "eleitos" ? "do mais à esquerda ao mais à direita" : modo === "vencedor" ? "agrupados pelo espectro do vencedor" : "do maior ao menor";
  // Linha do tempo de mapas (mesmo tipo de eleição)
  const anosTipo = INDICE.anos.filter((a) => tipoAno(a) === tipoAno(e.ano));
  const minis = anosTipo.map((a) => {
    const v = {};
    let algum = false;
    for (const u of Object.keys(NOMES_UF)) {
      const s = INDICE.serie[`${u}|${e.cargo}`]?.[a];
      if (!s) continue;
      if (modo === "vencedor") {
        const porVoto = e.cargo === "PRESIDENTE" || (e.cargo === "TODOS" && tipoAno(a) === "geral");
        const sig = porVoto ? s.top_v : e.cargo === "TODOS" ? INDICE.serie[`${u}|PREFEITO`]?.[a]?.top_el : s.top_el;
        if (sig) { v[u] = { cor: COR_ESP[grupoEspectro(sig, a)], dica: `<b>${esc(NOMES_UF[u])} · ${a}</b><br>${esc(sig)}` }; algum = true; }
        continue;
      }
      const n = modo === "voto" ? s.vnota : modo === "eleitos" ? s.nota : modo === "abst" ? s.abst
        : modo === "mulheres" ? (s.fem && s.n?.[1] ? pct(s.fem[1], s.n[1]) : null) : null;
      if (n == null) continue;
      algum = true;
      v[u] = { num: n, cor: modo === "voto" || modo === "eleitos" ? corNota(n) : null,
        dica: `<b>${esc(NOMES_UF[u])} · ${a}</b><br>${modo === "voto" || modo === "eleitos" ? `índice ${fmtD(n, 2)}` : fmtPct(n)}` };
    }
    if (!algum) return "";
    if (modo === "abst" || modo === "mulheres") coresSequenciais(v);
    return `<a href="#" class="pn-mini${a === e.ano ? " atual" : ""}" data-ano="${a}">${mapaSvg(v, { rotulos: false, clicavel: false, ufAtual: "" })}<span>${a}</span></a>`;
  }).filter(Boolean);
  const turnoSel = temT2 ? `<div class="pn-seg" role="group" aria-label="Turno">
      ${["1", "2"].map((t) => `<button type="button" data-turno="${t}" aria-pressed="${t === turno}">${t}º turno</button>`).join("")}</div>` : "";
  const notaCargo = b?.votos_cargo && b.votos_cargo !== e.cargo && (modo === "voto" || modo === "vencedor") ? ` Em “todos os cargos”, o voto considerado é o de ${NOMES_CARGO[b.votos_cargo].toLowerCase()}.` : "";
  return `<div class="pn-mapa-topo">
      <div class="pn-seg pn-modos" role="group" aria-label="O que o mapa mostra">${modos.map((m) => `<button type="button" data-modo="${m}" aria-pressed="${m === modo}">${MODOS[m].rot}</button>`).join("")}</div>
      ${turnoSel}
    </div>
    <div class="pn-mapa-grade">
      <div class="pn-mapa-principal">${mapaSvg(vals, { ufAtual: e.uf })}${escala}</div>
      <div class="pn-mapa-lado"><h4>Estados ${tit}</h4>${ranking}</div>
    </div>
    <p class="nota">${esc(MODOS[modo].dica)}${notaCargo} Passe o mouse (ou toque) para ver os números; clique num estado para filtrar o painel.
      Nota de cada partido: Bolognesi, Ribeiro e Codato (2023), medida em 2018; partidos sem classificação (União, PRD…) ficam fora do índice.</p>
    ${minis.length > 1 ? `<h4>O mapa ao longo do tempo <small class="muted">— eleições ${tipoAno(e.ano) === "geral" ? "gerais" : "municipais"}; clique para abrir o ano</small></h4>
      <div class="pn-minis">${minis.join("")}</div>` : ""}`;
}

function secComposicao(d, e, b, ant) {
  if (b.so_votos) {
    const v = b.votos[turnoFinal(b.votos)];
    return `<h4>Votos válidos por partido no estado${turnoFinal(b.votos) === "2" ? " (2º turno)" : ""}</h4>` +
      barrasH(v.top.map(([s, n]) => ({ rot: s, ponto: grupoEspectro(s, e.ano), v: n, cor: COR_ESP[grupoEspectro(s, e.ano)], txt: `${fmtPct(pct(n, v.total))} · ${fmtN(n)} votos` })));
  }
  const el = b.n[1];
  const partidos = b.partidos.filter((x) => x[2]).map(([sigla, , n]) => ({ sigla, n, g: grupoEspectro(sigla, e.ano), nota: notaPartido(sigla, e.ano) }));
  let graf;
  if (LEGISLATIVOS.has(e.cargo) && el <= 1200 && el > 1) {
    graf = `<div class="pn-hemi-wrap">${hemiciclo(partidos)}</div>
      <div class="pn-hemi-leg">${[...partidos].sort((a, c) => (a.nota ?? 5) - (c.nota ?? 5)).map((p) =>
        `<span ${dicaAttr(`${GRUPOS[p.g]}${p.nota != null ? ` · nota ${fmtD(p.nota, 2)}` : ""}`)}><i style="background:${COR_ESP[p.g]}"></i>${esc(p.sigla)} <b>${p.n}</b></span>`).join("")}</div>`;
  } else if (e.cargo === "TODOS") {
    graf = `<div class="pn-por-cargo">${d.cargos.map((c) => {
      const bc = d.g[`${e.uf}|${c}`];
      if (!bc || bc.so_votos || !bc.n[1]) return "";
      return `<div class="linha"><span class="rot">${NOMES_CARGO[c]} <small>${fmtN(bc.n[1])} eleitos</small></span>${barraEsp(bc.esp.map((x) => x[1]), { dicaPre: `${NOMES_CARGO[c]}<br>` })}</div>`;
    }).join("")}</div>${legendaEsp()}`;
  } else {
    graf = `${barraEsp(b.esp.map((x) => x[1]), { alt: 34 })}${legendaEsp()}
      ${partidos.length ? `<div class="pn-hemi-leg">${partidos.sort((a, c) => c.n - a.n).map((p) => `<span><i style="background:${COR_ESP[p.g]}"></i>${esc(p.sigla)} <b>${fmtN(p.n)}</b></span>`).join("")}</div>` : ""}`;
  }
  const ganhos = ant ? b.partidos.filter((x) => x[2] - x[3] !== 0).sort((x, y) => (y[2] - y[3]) - (x[2] - x[3]))
    .map(([s, , n, a, orig]) => ({ rot: s, v: n - a, ponto: grupoEspectro(s, e.ano),
      dica: `<b>${esc(s)}</b><br>${ant.ano}: ${fmtN(a)}${orig ? ` (como ${esc(orig)})` : ""}<br>${e.ano}: ${fmtN(n)}` })) : [];
  const ganhosVis = ganhos.length > 16 ? [...ganhos.slice(0, 8), ...ganhos.slice(-8)] : ganhos;
  const tabela = `<div class="tabela-wrap"><table class="pn-tabela">
      <thead><tr><th>Partido</th><th class="num">Eleitos</th>${ant ? `<th class="num">vs ${ant.ano}</th>` : ""}<th class="num">Candidaturas</th><th class="num">Sucesso</th><th>Espectro</th></tr></thead>
      <tbody>${b.partidos.filter((x) => x[1]).slice(0, 30).map(([s, c, n, a, orig]) => {
        const g = grupoEspectro(s, e.ano), nt = notaPartido(s, e.ano);
        return `<tr><td><i class="pn-ponto" style="background:${COR_ESP[g]}"></i><strong>${esc(s)}</strong>${orig ? ` <small class="muted">antes ${esc(orig)}</small>` : ""}</td>
          <td class="num"><b>${fmtN(n)}</b></td>${ant ? `<td class="num ${n - a > 0 ? "sobe" : n - a < 0 ? "desce" : ""}">${n - a ? sinal(n - a, 0) : "="}</td>` : ""}
          <td class="num">${fmtN(c)}</td><td class="num">${fmtPct(pct(n, c))}</td>
          <td>${GRUPOS[g]}${nt != null ? ` <small class="muted">${fmtD(nt, 2)}</small>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  return `<div class="pn-duas larga">
      <div><h4>${e.cargo === "TODOS" ? "Espectro dos eleitos, por cargo" : `Composição: ${fmtN(el)} ${PLURAL_CARGO[e.cargo]} eleitos`}</h4>${graf}</div>
      ${ant ? `<div><h4>Ganhos e perdas em relação a ${ant.ano}</h4>${barrasDiv(ganhosVis)}
        <p class="nota">Legendas renomeadas ou fundidas são comparadas com a sucessora (ex.: PR → PL; DEM + PSL → União).</p></div>` : ""}
    </div>
    <h4>Partidos</h4>${tabela}`;
}

function secEvolucao(d, e) {
  const serie = INDICE.serie[`${e.uf}|${e.cargo}`] || {};
  const anos = Object.keys(serie).map(Number).filter((a) => tipoAno(a) === tipoAno(e.ano)).sort((a, c) => a - c);
  const comEsp = anos.filter((a) => serie[a].esp);
  const area = areaEmpilhada(comEsp.map((a) => ({ ano: a, vals: serie[a].esp })));
  const comVoto = anos.filter((a) => serie[a].vesp);
  const areaVoto = comVoto.length > 1 ? areaEmpilhada(comVoto.map((a) => ({ ano: a, vals: serie[a].vesp }))) : "";
  const idx = graficoLinhas([
    { nome: "Índice dos eleitos", cor: "#2a2a2d", pontos: anos.map((a) => [a, serie[a].nota]) },
    { nome: "Índice do voto", cor: "#c4161c", tracejado: true, pontos: anos.map((a) => [a, serie[a].vnota]) },
  ], { min: 3, max: 8, suf: "", fundoNota: true, dec: 0 });
  return `<div class="pn-duas">
      ${comEsp.length > 1 ? `<div><h4>Eleitos por espectro</h4>${area}</div>` : ""}
      <div><h4>Índice ideológico ao longo do tempo <small class="muted">(0 esquerda · 10 direita)</small></h4>${idx}</div>
    </div>
    ${areaVoto ? `<div class="pn-duas"><div><h4>Votos válidos por espectro${e.cargo === "TODOS" ? " (cargo principal)" : ""}</h4>${areaVoto}</div>
      <div class="pn-explica"><h4>Como ler</h4><p>As áreas mostram a fatia de cada campo político entre os <b>eleitos</b> e entre os <b>votos válidos</b> (2014 em diante).
      O índice é a média das notas dos partidos (0 a 10): quanto maior, mais à direita. A diferença entre o índice dos eleitos e o do voto
      revela efeitos do sistema eleitoral, como quociente partidário, coligações e sobras.</p></div></div>` : ""}
    ${legendaEsp()}`;
}

function secPerfil(d, e, b) {
  if (b.so_votos) return `<p class="muted">Escolha “Brasil” para ver o perfil dos candidatos a presidente.</p>`;
  const [cand, el] = b.n;
  const taxa = (cont, ordem) => {
    const it = Object.entries(cont).filter(([k, [c]]) => c >= 3 && !/Não Divulg|Não Informado|Não informado/i.test(k));
    if (ordem) it.sort((a, c) => ordem.indexOf(a[0]) - ordem.indexOf(c[0]));
    else it.sort((a, c) => pct(c[1][1], c[1][0]) - pct(a[1][1], a[1][0]));
    return barrasH(it.map(([k, [c, x]]) => ({ rot: k, sub: `${fmtN(x)} de ${fmtN(c)}`, v: pct(x, c), txt: fmtPct(pct(x, c)),
      dica: `<b>${esc(k)}</b><br>${fmtN(x)} eleitos de ${fmtN(c)} candidaturas<br>${fmtPct(pct(c, cand))} das candidaturas · ${fmtPct(pct(x, el))} dos eleitos` })));
  };
  const serie = INDICE.serie[`${e.uf}|${e.cargo}`] || {};
  const anos = Object.keys(serie).map(Number).filter((a) => tipoAno(a) === tipoAno(e.ano) && serie[a].n).sort((a, c) => a - c);
  const evolFem = graficoLinhas([
    { nome: "Candidaturas de mulheres", cor: "#9a98a0", pontos: anos.map((a) => [a, pct(serie[a].fem?.[0], serie[a].n?.[0])]) },
    { nome: "Mulheres eleitas", cor: "#c4161c", pontos: anos.map((a) => [a, pct(serie[a].fem?.[1], serie[a].n?.[1])]) },
  ]);
  const ocup = Object.entries(b.perfil.ocupacao).filter(([k]) => k && k !== "Outros").sort((x, y) => y[1][1] - x[1][1]).slice(0, 10);
  const pir = b.perfil.piramide;
  const totC = [...pir.Feminino, ...pir.Masculino].reduce((a, x) => a + x[0], 0), totE = [...pir.Feminino, ...pir.Masculino].reduce((a, x) => a + x[1], 0);
  const escala = Math.max(...[...pir.Feminino, ...pir.Masculino].flatMap((x) => [pct(x[0], totC) || 0, pct(x[1], totE) || 0]));
  return `<div class="pn-duas">
      <div>${piramide(pir, 0, "Candidaturas", escala)}</div>
      <div>${piramide(pir, 1, "Eleitos", escala)}</div>
    </div>
    <h4>Chance de se eleger <small class="muted">— % de eleitos entre as candidaturas de cada grupo (média: ${fmtPct(pct(el, cand))})</small></h4>
    <div class="pn-tres">
      <div><h5>Gênero</h5>${taxa(b.perfil.genero)}</div>
      <div><h5>Cor/raça${e.ano < 2014 ? " <small class='muted'>(desde 2014)</small>" : ""}</h5>${taxa(b.perfil.cor)}</div>
      <div><h5>Escolaridade</h5>${taxa(b.perfil.instrucao)}</div>
    </div>
    <div class="pn-duas">
      <div><h4>Mulheres ao longo do tempo</h4>${evolFem}</div>
      <div><h4>Ocupações mais comuns entre os eleitos</h4>${barrasH(ocup.map(([k, [c, x]]) => ({ rot: k, v: x, txt: fmtN(x), dica: `${fmtN(x)} eleitos de ${fmtN(c)} candidaturas` })))}
        <p class="nota">Ocupação declarada ao TSE (“Outros” omitido).</p></div>
    </div>`;
}

const FAIXAS_REC = ["Até R$ 10 mil", "R$ 10 a 50 mil", "R$ 50 a 200 mil", "R$ 200 mil a 1 mi", "Mais de R$ 1 mi"];
const FAIXAS_BENS = ["Nenhum bem", "Até R$ 100 mil", "R$ 100 a 500 mil", "R$ 500 mil a 2 mi", "Mais de R$ 2 mi"];
function secDinheiro(d, e, b) {
  if (b.so_votos) return `<p class="muted">Escolha “Brasil” para ver os dados de presidente.</p>`;
  const din = b.din;
  if (!din) return `<p class="muted">O TSE publica bens declarados a partir de 2006 e receitas de campanha a partir de 2018.</p>`;
  const el = b.n[1];
  const k = [];
  if (din.pub_total != null) {
    k.push(kpi("Verba pública nas campanhas", brlCurto(din.pub_total), { destaque: true, sub: "Fundo Eleitoral (FEFC) + Fundo Partidário" }));
    k.push(kpi("…nas campanhas vitoriosas", brlCurto(din.pub_eleitos), { sub: `${fmtPct(pct(din.pub_eleitos, din.pub_total))} do total · ${brlCurto(din.pub_eleitos / Math.max(1, el))} por eleito` }));
    k.push(kpi("Receita mediana", brlCurto(din.rec_mediana[0]), { sub: `dos eleitos · ${brlCurto(din.rec_mediana[1])} dos não eleitos` }));
    k.push(kpi("Custo mediano do voto", din.custo_voto == null ? "—" : brl2.format(din.custo_voto), { sub: "receita ÷ votos, entre os eleitos" }));
  }
  if (din.bens_mediana) {
    k.push(kpi("Patrimônio mediano", brlCurto(din.bens_mediana[0]), { sub: `dos eleitos · ${brlCurto(din.bens_mediana[1])} de todas as candidaturas` }));
    k.push(kpi("Milionários eleitos", fmtN(din.bens_milionarios[1]), { sub: `bens ≥ R$ 1 mi · ${fmtPct(pct(din.bens_milionarios[1], el))} dos eleitos` }));
  }
  const col = (f, rot) => colunas(f.map(([c, x], i) => ({ rot: rot[i], v: pct(x, c) || 0, dica: `<b>${esc(rot[i])}</b><br>${fmtN(x)} eleitos de ${fmtN(c)} candidaturas` })));
  const pp = (din.pub_partidos || []).slice(0, 15);
  const elPorPartido = Object.fromEntries(b.partidos.map((x) => [x[0], x[2]]));
  return `<div class="pn-kpis">${k.join("")}</div>
    <div class="pn-duas">
      ${din.frec ? `<div><h4>Dinheiro elege? <small class="muted">% de eleitos por faixa de receita de campanha</small></h4>${col(din.frec, FAIXAS_REC)}</div>` : ""}
      ${din.fbens ? `<div><h4>Patrimônio e vitória <small class="muted">% de eleitos por faixa de bens declarados</small></h4>${col(din.fbens, FAIXAS_BENS)}</div>` : ""}
    </div>
    ${pp.length ? `<h4>Verba pública por partido</h4>${barrasH(pp.map(([s, v]) => ({ rot: s, ponto: grupoEspectro(s, e.ano), v, cor: COR_ESP[grupoEspectro(s, e.ano)],
      txt: `${brlCurto(v)}${elPorPartido[s] ? ` · ${brlCurto(v / elPorPartido[s])} por eleito` : " · nenhum eleito"}` })))}` : ""}
    <p class="nota">Valores declarados ao TSE, em reais da época. Mediana = valor do meio (metade acima, metade abaixo). Receitas: prestação de contas (2018+);
      patrimônio: bens declarados no registro (2006+).</p>`;
}

const EXPLICA_SIT = {
  Indeferida: "registro negado (inclui pedidos não conhecidos e candidaturas inaptas)",
  Cassada: "registro ou diploma retirado por decisão judicial",
  "Renúncia": "a própria pessoa desistiu",
  Cancelada: "cancelada, em geral a pedido do partido",
  Falecimento: "candidatura encerrada por falecimento",
};
function secRestricoes(d, e, b) {
  if (b.so_votos) return `<p class="muted">Escolha “Brasil” para ver as restrições a candidaturas de presidente.</p>`;
  const cand = b.n[0];
  const sit = b.restr.sit, mot = b.restr.motivos || [];
  return `<div class="pn-kpis">${Object.keys(EXPLICA_SIT).filter((k) => sit[k]).map((k) =>
      kpi(k === "Renúncia" ? "Renúncias" : `${k}s`, fmtN(sit[k]), { sub: `${fmtPct(pct(sit[k], cand))} das candidaturas · ${EXPLICA_SIT[k]}` })).join("")}
      ${b.restr.coletivo ? kpi("Atingidas por decisão sobre a chapa", fmtN(b.restr.coletivo), { sub: "votos anulados porque o partido/chapa foi invalidado (ex.: fraude à cota de gênero)" }) : ""}
    </div>
    ${mot.length ? `<h4>Motivos informados pelo TSE</h4>${barrasH(mot.map(([m, n]) => ({ rot: m, v: n, txt: fmtN(n) })))}
      <p class="nota">Uma candidatura pode ter mais de um motivo (dados a partir de 2014). Use o mapa (modo “Candidaturas barradas”) para comparar estados.
        Na consulta por nome, cada candidatura com restrição tem um “entenda”.</p>`
      : e.ano < 2014 ? `<p class="nota">O TSE só publica o motivo específico das restrições a partir de 2014.</p>` : ""}`;
}

function secParticipacao(d, e) {
  const p = d.part[`${e.uf}|${e.cargo}`];
  if (!p) return `<p class="muted">Comparecimento indisponível para este recorte${e.ano < 2014 ? " (a base tem esses dados a partir de 2014)" : ""}.</p>`;
  const cards = Object.keys(p).sort().map((t) => {
    const [aptos, , abst, val, br, nul] = p[t];
    const tot = val + br + nul;
    return `<div class="pn-turno"><h4>${t}º turno</h4><div class="pn-kpis">
        ${kpi("Eleitorado", fmtN(aptos), { destaque: true })}
        ${kpi("Abstenção", fmtPct(pct(abst, aptos), 2), { sub: `${fmtN(abst)} eleitores` })}
        ${kpi("Brancos", fmtPct(pct(br, tot), 2), { sub: "dos votos dados" })}
        ${kpi("Nulos", fmtPct(pct(nul, tot), 2), { sub: "dos votos dados" })}
      </div>
      <div class="pn-pilha">
        <span style="width:${pct(val, aptos)}%;background:#3f78ad" ${dicaAttr(`Válidos: ${fmtN(val)} (${fmtPct(pct(val, aptos))} do eleitorado)`)}>Válidos ${fmtPct(pct(val, aptos), 0)}</span>
        <span style="width:${pct(br, aptos)}%;background:#cfccc6" ${dicaAttr(`Brancos: ${fmtN(br)}`)}></span>
        <span style="width:${pct(nul, aptos)}%;background:#8d8b90" ${dicaAttr(`Nulos: ${fmtN(nul)}`)}></span>
        <span style="width:${pct(abst, aptos)}%;background:#c4161c" ${dicaAttr(`Abstenção: ${fmtN(abst)}`)}>Abstenção ${fmtPct(pct(abst, aptos), 0)}</span>
      </div></div>`;
  }).join("");
  const serie = INDICE.serie[`${e.uf}|${e.cargo}`] || {};
  const anos = Object.keys(serie).map(Number).filter((a) => tipoAno(a) === tipoAno(e.ano) && serie[a].abst != null).sort((a, c) => a - c);
  return `${cards}<div class="pn-leg"><span><i style="background:#3f78ad"></i>Válidos</span><span><i style="background:#cfccc6"></i>Brancos</span><span><i style="background:#8d8b90"></i>Nulos</span><span><i style="background:#c4161c"></i>Abstenção</span></div>
    <h4>Abstenção no 1º turno ao longo do tempo</h4>
    ${graficoLinhas([{ nome: "Abstenção", cor: "#c4161c", pontos: anos.map((a) => [a, serie[a].abst]) }], { min: 0, max: 40 })}
    <p class="nota">Somado das zonas eleitorais${e.cargo === "TODOS" ? " (cargo principal da eleição)" : ""}. Brancos e nulos em % dos votos dados; abstenção em % do eleitorado.
      Use o mapa (modo “Abstenção”) para comparar os estados.</p>`;
}

// ---------- Página ----------
async function desenhar() {
  const e = lerEstado();
  const alvo = $("#painel");
  let d;
  try { d = await getJson(`data/painel/${e.ano}.json`); } catch (err) {
    alvo.innerHTML = `<div class="status erro">Não foi possível carregar os dados de ${e.ano}.</div>`; return;
  }
  if (e.uf !== "BR" && !d.ufs.includes(e.uf)) e.uf = "BR";
  if (e.cargo !== "TODOS" && !d.cargos.includes(e.cargo)) e.cargo = "TODOS";
  const anoAnt = INDICE.anos.includes(e.ano - 4) ? e.ano - 4 : null;
  const ant = anoAnt ? await getJson(`data/painel/${anoAnt}.json`).catch(() => null) : null;
  preencherFiltros(d, e);
  const b = d.g[`${e.uf}|${e.cargo}`];
  const bAnt = ant?.g?.[`${e.uf}|${e.cargo}`];
  if (!b) { alvo.innerHTML = `<div class="status">Sem dados para este recorte.</div>`; return; }
  const preliminar = e.ano === Math.max(...INDICE.anos) && e.ano >= new Date().getFullYear();
  const sec = (id, tit, corpo, sub = "") => `<section class="pn-sec" id="${id}"><div class="pn-sec-cab"><h3>${tit}</h3>${sub ? `<p>${sub}</p>` : ""}</div>${corpo}</section>`;
  const y = window.scrollY;
  alvo.innerHTML = `
    <div class="pn-titulo"><h2>${esc(NOMES_CARGO[e.cargo])} <span>·</span> ${esc(NOMES_UF[e.uf])} <span>·</span> ${e.ano}</h2>
      ${preliminar ? `<span class="pn-selo">dados preliminares · eleição em andamento</span>` : ""}
      ${e.uf !== "BR" ? `<a href="#" class="pn-limpa" data-uf="BR">× voltar ao Brasil</a>` : ""}</div>
    ${sec("s-panorama", "Panorama", `${secResumo(d, e, b, ant, bAnt)}${destaques(d, e, b, ant, bAnt)}`)}
    ${sec("s-mapa", "Mapa político", secMapa(d, e, b), "Como cada estado votou e quem elegeu, na escala esquerda–direita")}
    ${sec("s-partidos", "Partidos e composição", secComposicao(d, e, b, ant))}
    ${sec("s-evolucao", "Evolução", secEvolucao(d, e))}
    ${sec("s-perfil", "Perfil: quem concorre × quem se elege", secPerfil(d, e, b))}
    ${sec("s-dinheiro", "Dinheiro", secDinheiro(d, e, b))}
    ${sec("s-restricoes", "Candidaturas barradas", secRestricoes(d, e, b))}
    ${sec("s-participacao", "Participação do eleitor", secParticipacao(d, e))}`;
  window.scrollTo({ top: y });
  ligar(d, e);
}

function preencherFiltros(d, e) {
  const anos = [...INDICE.anos].reverse();
  $("#f-ano").innerHTML = anos.map((a) => `<option value="${a}"${a === e.ano ? " selected" : ""}>${a} · ${tipoAno(a) === "geral" ? "gerais" : "municipais"}</option>`).join("");
  $("#f-uf").innerHTML = ["BR", ...d.ufs.filter((u) => u !== "ZZ")].map((u) => `<option value="${u}"${u === e.uf ? " selected" : ""}>${esc(NOMES_UF[u] || u)}</option>`).join("");
  $("#f-cargo").innerHTML = ["TODOS", ...d.cargos].map((c) => `<option value="${c}"${c === e.cargo ? " selected" : ""}>${esc(NOMES_CARGO[c] || c)}</option>`).join("");
}

function ligar(d, e) {
  const ir = (mud) => irPara({ ...e, ...mud });
  const escolheUf = (uf) => { if (uf === "BR" || d.ufs.includes(uf)) ir({ uf: uf === e.uf ? "BR" : uf }); };
  document.querySelectorAll("#s-mapa .pn-mapa-principal use[data-uf], .pn-ranking li[data-uf], .pn-limpa").forEach((el) =>
    el.addEventListener("click", (ev) => { ev.preventDefault(); escolheUf(el.dataset.uf); }));
  document.querySelectorAll(".pn-modos button").forEach((bt) => bt.addEventListener("click", () => ir({ modo: bt.dataset.modo })));
  document.querySelectorAll("[data-turno]").forEach((bt) => bt.addEventListener("click", () => ir({ turno: bt.dataset.turno === "1" ? "" : bt.dataset.turno })));
  document.querySelectorAll(".pn-mini").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); ir({ ano: +a.dataset.ano }); }));
}

async function iniciar() {
  try {
    META = await getJson("data/meta.json");
    [INDICE, MAPA] = await Promise.all([getJson("data/painel/indice.json"), getJson("assets/mapa-brasil.json")]);
  } catch (err) {
    $("#painel").innerHTML = `<div class="status erro">O painel ainda não foi gerado.</div>`;
    return;
  }
  // Geometria do mapa (uma vez) + centro de cada estado para os rótulos
  document.body.insertAdjacentHTML("beforeend", defsMapa());
  document.body.insertAdjacentHTML("beforeend", `<svg class="pn-defs-medir" viewBox="${MAPA.viewBox}" width="613" height="639"
    style="position:absolute;left:-9999px;top:0" aria-hidden="true">${MAPA.locations.map((l) => `<path data-uf="${l.id.toUpperCase()}" d="${l.path}"/>`).join("")}</svg>`);
  calcularCentros();
  ligarDicas();
  $("#meta-info").textContent = `Base atualizada em ${META.gerado_em.split("-").reverse().join("/")}.`;
  const muda = () => irPara({ ...lerEstado(), ano: +$("#f-ano").value, uf: $("#f-uf").value, cargo: $("#f-cargo").value });
  ["#f-ano", "#f-uf", "#f-cargo"].forEach((s) => $(s).addEventListener("change", muda));
  document.querySelectorAll(".painel-nav a").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault(); // o hash guarda o estado do painel; a navegação entre seções só rola a página
    document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  window.addEventListener("hashchange", desenhar);
  desenhar();
}

iniciar();
