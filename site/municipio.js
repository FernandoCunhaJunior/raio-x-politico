"use strict";

// Eleições no município (municipio.html). Dados: data/municipio/UF.json, UF/CODIGO.json e UF/gAAAA.json (scripts/municipio.py).
// Estado na URL: municipio.html#uf=BA&m=38490&ano=2024

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (x) => (x ?? 0).toLocaleString("pt-BR");
const fmtD = (x, d = 1) => x == null || !isFinite(x) ? "—" : x.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (x, d = 1) => x == null || !isFinite(x) ? "—" : `${fmtD(x, d)}%`;
const pct = (a, b) => (b ? (100 * a) / b : null);
const normaliza = (s) => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const MINUSCULAS = new Set(["da", "de", "do", "das", "dos", "e", "d"]);
const cap = (s) => (s || "").toLowerCase().split(" ").map((w, i) => (i && MINUSCULAS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

let META = null, MAPA = null, INDICE = null;
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
  RR: "Roraima", RS: "Rio Grande do Sul", SC: "Santa Catarina", SE: "Sergipe", SP: "São Paulo", TO: "Tocantins" };
const UFS = Object.keys(NOMES_UF);
const GRUPOS = ["Esquerda", "Centro-esquerda", "Centro", "Centro-direita", "Direita", "Sem classificação"];
const COR_ESP = ["#6b5cc2", "#a79fdb", "#9a9a9f", "#86aed0", "#3f78ad", "#cfccc6"];
const NOMES_CARGO = { PRESIDENTE: "Presidente", GOVERNADOR: "Governador", SENADOR: "Senador", "DEPUTADO FEDERAL": "Deputados federais",
  "DEPUTADO ESTADUAL": "Deputados estaduais", "DEPUTADO DISTRITAL": "Deputados distritais" };
const ORDEM_GERAIS = ["PRESIDENTE", "GOVERNADOR", "SENADOR", "DEPUTADO FEDERAL", "DEPUTADO ESTADUAL", "DEPUTADO DISTRITAL"];
const RES = { E: "Eleito", S: "Suplente", N: "Não eleito", 2: "2º turno", B: "Barrada" };

// Espectro da legenda (mesma regra do site)
const siglaNorm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
function regra(sigla, ano) { const s = siglaNorm(sigla); return (META.espectro?.regras || []).find((x) => x[0] === s && ano >= x[1]) || null; }
function grupoEspectro(sigla, ano) {
  const r = regra(sigla, ano);
  if (!r) return 5;
  const f = (META.espectro.faixas || []).find(([lim]) => r[3] <= lim)?.[1] || "";
  const g = f === "Extrema-esquerda" ? "Esquerda" : f === "Extrema-direita" ? "Direita" : f;
  return Math.max(0, GRUPOS.indexOf(g));
}
const faixaNota = (n) => (META.espectro?.faixas || []).find(([lim]) => n <= lim)?.[1] || "";
const PARADAS = [[1.5, [74, 58, 168]], [3, [123, 111, 201]], [4.5, [190, 184, 228]], [5, [222, 221, 227]], [5.5, [190, 211, 230]], [7, [111, 156, 204]], [8.5, [36, 86, 145]]];
function corNota(n) {
  if (n == null || !isFinite(n)) return null;
  if (n <= PARADAS[0][0]) return `rgb(${PARADAS[0][1]})`;
  for (let i = 1; i < PARADAS.length; i++) {
    const [b, cb] = PARADAS[i], [a, ca] = PARADAS[i - 1];
    if (n <= b) { const t = (n - a) / (b - a); return `rgb(${ca.map((x, k) => Math.round(x + (cb[k] - x) * t)).join(",")})`; }
  }
  return `rgb(${PARADAS[PARADAS.length - 1][1]})`;
}
const linkPessoa = (pid, nome) => `./#${new URLSearchParams({ q: nome, p: pid })}`;
const chipPartido = (sigla, ano) => {
  const g = grupoEspectro(sigla, ano);
  return `<span class="mn-sigla" style="--c:${COR_ESP[g]}" title="${esc(GRUPOS[g])}">${esc(sigla)}</span>`;
};
const dicaAttr = (html) => `data-dica="${esc(html)}"`;

// ---------- Estado na URL ----------
function lerEstado() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { uf: (h.get("uf") || "").toUpperCase(), m: h.get("m") || "", ano: +h.get("ano") || 0 };
}
const hashDe = (e) => { const h = new URLSearchParams(); if (e.uf) h.set("uf", e.uf); if (e.m) h.set("m", e.m); if (e.ano) h.set("ano", e.ano); return "#" + h; };

// ---------- Dica flutuante ----------
function ligarDicas() {
  const dica = document.createElement("div");
  dica.className = "pn-dica";
  dica.hidden = true;
  document.body.appendChild(dica);
  const mostra = (ev) => {
    const alvo = ev.target.closest?.("[data-dica]");
    if (!alvo || !alvo.dataset.dica) { dica.hidden = true; return; }
    dica.innerHTML = alvo.dataset.dica;
    dica.hidden = false;
    const r = dica.getBoundingClientRect();
    dica.style.left = `${Math.min(innerWidth - r.width - 8, Math.max(8, ev.clientX + 14))}px`;
    dica.style.top = `${ev.clientY + r.height + 24 > innerHeight ? ev.clientY - r.height - 12 : ev.clientY + 16}px`;
  };
  document.addEventListener("mousemove", mostra);
  document.addEventListener("pointerdown", (ev) => { if (ev.pointerType !== "mouse") mostra(ev); });
  document.addEventListener("scroll", () => { dica.hidden = true; }, { passive: true });
}

// ---------- Componentes ----------
const kpi = (rot, val, sub = "", destaque = false) => `<div class="pn-kpi${destaque ? " destaque" : ""}"><div class="rot">${rot}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

function hemiciclo(partidos) {
  const N = partidos.reduce((a, p) => a + p.n, 0);
  if (!N) return "";
  const R = Math.max(1, Math.min(10, Math.round(Math.sqrt(N) / 1.6)));
  const r0 = R === 1 ? 0.75 : 0.42, raios = Array.from({ length: R }, (_, i) => (R === 1 ? 0.75 : r0 + ((1 - r0) * i) / (R - 1)));
  const soma = raios.reduce((a, b) => a + b, 0);
  const porFila = raios.map((r) => Math.max(1, Math.round((N * r) / soma)));
  let dif = N - porFila.reduce((a, b) => a + b, 0);
  for (let i = R - 1, k = 0; dif !== 0 && k < 1000; i = (i - 1 + R) % R, k++) { if (dif > 0) { porFila[i]++; dif--; } else if (porFila[i] > 1) { porFila[i]--; dif++; } }
  const assentos = [];
  raios.forEach((r, i) => { const n = porFila[i]; for (let k = 0; k < n; k++) { const ang = n === 1 ? Math.PI / 2 : Math.PI - (Math.PI * k) / (n - 1); assentos.push({ ang, r, x: r * Math.cos(ang), y: r * Math.sin(ang) }); } });
  assentos.sort((a, b) => b.ang - a.ang || a.r - b.r);
  const passo = R === 1 ? 0.3 : (1 - r0) / (R - 1);
  const rCad = Math.min(passo * 0.44, 0.09, ...raios.map((r, i) => ((Math.PI * r) / Math.max(1, porFila[i] - 1)) * 0.44));
  let k = 0;
  const ordem = [...partidos].sort((a, b) => (a.nota ?? 5) - (b.nota ?? 5));
  const pts = ordem.flatMap((p) => Array.from({ length: p.n }, () => {
    const a = assentos[k++];
    return `<circle cx="${(a.x + 1.1).toFixed(4)}" cy="${(1.08 - a.y).toFixed(4)}" r="${rCad.toFixed(4)}" fill="${COR_ESP[p.g]}" ${dicaAttr(`<b>${esc(p.sigla)}</b>: ${p.n} cadeira${p.n > 1 ? "s" : ""}<br>${GRUPOS[p.g]}`)}/>`;
  }));
  return `<svg class="pn-hemiciclo" viewBox="0 0 2.2 1.16" role="img" aria-label="${N} cadeiras por partido">${pts.join("")}<text x="1.1" y="1.06" text-anchor="middle" class="tot">${N}</text></svg>`;
}

// ---------- Etapa 1: escolher o estado ----------
async function telaEstados() {
  $("#busca-wrap").hidden = true;
  trilha([]);
  const lado = `<div class="chips-uf">${UFS.map((u) => `<a class="chip" href="${hashDe({ uf: u })}" title="${esc(NOMES_UF[u])}">${u}</a>`).join("")}</div>`;
  $("#mun").innerHTML = `<section class="pn-sec"><div class="pn-sec-cab"><h3>Escolha o estado</h3><p>Clique no mapa ou na sigla</p></div>
    <div class="mn-estados">
      <svg class="pn-mapa mn-mapa" viewBox="${MAPA.viewBox}" role="img" aria-label="Mapa do Brasil">
        ${MAPA.locations.map((l) => `<a href="${hashDe({ uf: l.id.toUpperCase() })}" aria-label="${esc(l.name)}"><path d="${l.path}"><title>${esc(l.name)}</title></path></a>`).join("")}
        <g class="mn-rot"></g>
      </svg>
      <div>${lado}<p class="nota">Depois, escolha o município. Para o Distrito Federal (que não tem prefeito nem vereadores),
        a página mostra como Brasília votou nas eleições gerais.</p></div>
    </div></section>`;
  const g = $(".mn-rot");
  g.innerHTML = [...document.querySelectorAll(".mn-mapa path")].map((p, i) => {
    const b = p.getBBox(), uf = MAPA.locations[i].id.toUpperCase();
    return `<text x="${b.x + b.width / 2}" y="${b.y + b.height / 2}">${uf}</text>`;
  }).join("");
}

// ---------- Etapa 2: escolher o município ----------
async function telaMunicipios(uf) {
  let lista;
  try { lista = await getJson(`data/municipio/${uf}.json`); } catch { $("#mun").innerHTML = `<div class="status erro">Não foi possível carregar os municípios.</div>`; return; }
  trilha([[NOMES_UF[uf], hashDe({ uf })]]);
  const busca = $("#busca");
  $("#busca-wrap").hidden = false;
  busca.placeholder = `Buscar entre ${fmtN(lista.length)} municípios`;
  const desenha = () => {
    const q = normaliza(busca.value);
    const itens = lista.filter((x) => !q || normaliza(x[1]).includes(q));
    let letra = "";
    const html = itens.map(([cod, nome, eleit, pref]) => {
      const l = normaliza(nome).charAt(0);
      const cab = !q && l !== letra ? `<h4 class="mn-letra">${(letra = l)}</h4>` : "";
      const g = pref ? grupoEspectro(pref[1], pref[0]) : 5;
      return `${cab}<a class="mn-card" href="${hashDe({ uf, m: cod })}">
        <strong>${esc(nome)}</strong>
        <small>${eleit ? `${fmtN(eleit)} eleitores` : ""}</small>
        ${pref ? `<small class="mn-pref"><i style="background:${COR_ESP[g]}"></i>Prefeito(a) ${pref[0]}: ${esc(cap(pref[2]))} · ${esc(pref[1])}</small>` : ""}
      </a>`;
    }).join("");
    $("#mn-lista").innerHTML = html || `<p class="muted">Nenhum município encontrado.</p>`;
  };
  // Ranking de eleitorado: os 5 maiores ganham destaque
  const maiores = [...lista].filter((x) => x[2]).sort((a, b) => b[2] - a[2]).slice(0, 6);
  $("#mun").innerHTML = `<section class="pn-sec"><div class="pn-sec-cab"><h3>Municípios — ${esc(NOMES_UF[uf])}</h3>
      <p>${fmtN(lista.length)} municípios · escolha um ou use a busca acima</p></div>
    ${maiores.length > 1 ? `<div class="mn-maiores">${maiores.map(([cod, nome, eleit]) => `<a href="${hashDe({ uf, m: cod })}"><strong>${esc(nome)}</strong><small>${fmtN(eleit)} eleitores</small></a>`).join("")}</div>` : ""}
    <div id="mn-lista" class="mn-lista"></div></section>`;
  busca.oninput = desenha;
  desenha();
  if (lista.length === 1) location.replace(hashDe({ uf, m: lista[0][0] }));
}

// ---------- Etapa 3: o município ----------
function barrasVotos(linhas, ano, { total = null, destaqueEleito = true, max = null } = {}) {
  if (!linhas.length) return `<p class="muted">Sem votação registrada.</p>`;
  const tot = total || linhas.reduce((a, l) => a + l.votos, 0);
  const m = max ?? Math.max(...linhas.map((l) => l.votos), 1);
  return `<div class="mn-votos">${linhas.map((l) => {
    const g = grupoEspectro(l.sigla, ano);
    const el = destaqueEleito && l.res === "E";
    return `<div class="mn-voto${el ? " eleito" : ""}">
      <span class="nome"><a href="${linkPessoa(l.pid, l.nome)}">${esc(cap(l.nome))}</a> ${chipPartido(l.sigla, ano)}${l.nr ? ` <small class="muted">${esc(l.nr)}</small>` : ""}
        ${el ? `<span class="mn-eleito">✓ ${l.eleitoTexto || "Eleito"}</span>` : l.res === "2" ? `<span class="mn-tag">2º turno</span>` : l.res === "B" ? `<span class="mn-tag barrada">barrada</span>` : ""}</span>
      <span class="pista"><span style="width:${Math.max(0.6, (100 * l.votos) / m)}%;background:${COR_ESP[g]}"></span></span>
      <b>${fmtPct(pct(l.votos, tot))}<small>${fmtN(l.votos)}</small></b></div>`;
  }).join("")}</div>`;
}

function blocoParticipacao(p) {
  if (!p) return "";
  return Object.keys(p).sort().map((t) => {
    const [aptos, comp, abst, val, br, nul] = p[t];
    const tot = val + br + nul;
    return `<div class="mn-part"><span class="t">${Object.keys(p).length > 1 ? `${t}º turno` : "Comparecimento"}</span>
      <span>Eleitorado <b>${fmtN(aptos)}</b></span><span>Abstenção <b>${fmtPct(pct(abst, aptos), 2)}</b></span>
      <span>Brancos <b>${fmtPct(pct(br, tot), 2)}</b></span><span>Nulos <b>${fmtPct(pct(nul, tot), 2)}</b></span></div>`;
  }).join("");
}

function secaoMunicipal(m, ano) {
  const b = m.m[String(ano)];
  if (!b) return "";
  const pref = b.pref || [];
  const temT2 = pref.some((l) => l.length > 7);
  const linhasPref = (t) => pref.filter((l) => (t === 1 ? true : l.length > 7)).map((l) => ({
    pid: l[0], nome: l[1], sigla: l[2], nr: l[3], res: t === 1 && temT2 ? (l.length > 7 ? "2" : l[4]) : l[4], votos: (t === 1 ? l[5] : l[7]) || 0,
  })).sort((a, c) => c.votos - a.votos);
  const comVotos = pref.some((l) => l[5]);
  let prefHtml;
  if (comVotos) {
    prefHtml = `<div class="${temT2 ? "pn-duas" : ""}">
      <div>${temT2 ? "<h5>1º turno</h5>" : ""}${barrasVotos(linhasPref(1), ano, { destaqueEleito: !temT2 })}</div>
      ${temT2 ? `<div><h5>2º turno</h5>${barrasVotos(linhasPref(2), ano)}</div>` : ""}</div>`;
  } else {
    prefHtml = `<div class="mn-lista-simples">${pref.map((l) => `<div class="${l[4] === "E" ? "eleito" : ""}"><a href="${linkPessoa(l[0], l[1])}">${esc(cap(l[1]))}</a> ${chipPartido(l[2], ano)}
      ${l[4] === "E" ? `<span class="mn-eleito">✓ Eleito</span>` : ""}</div>`).join("")}</div>
      <p class="nota">A votação por candidato está disponível a partir de 2014.</p>`;
  }
  const v = b.ver;
  let verHtml = "";
  if (v) {
    const partidos = v.part.filter((p) => p[2]).map(([sigla, , n]) => ({ sigla, n, g: grupoEspectro(sigla, ano), nota: regra(sigla, ano)?.[3] ?? null }));
    const totVotos = v.part.reduce((a, p) => a + p[3], 0);
    const eleitos = v.el.map((l) => ({ pid: l[0], nome: l[1], sigla: l[2], nr: l[3], res: "E", votos: l[5] || 0, pct: l[6] }));
    const outros = v.outros.map((l) => ({ pid: l[0], nome: l[1], sigla: l[2], nr: l[3], res: l[4], votos: l[5] || 0, pct: l[6] }));
    const tabela = (ls) => `<div class="tabela-wrap"><table class="pn-tabela mn-tabela"><thead><tr><th>Candidato(a)</th><th>Partido</th><th class="num">Nº</th><th class="num">Votos</th><th class="num">%</th><th>Resultado</th></tr></thead>
      <tbody>${ls.map((l) => `<tr class="${l.res === "E" ? "eleito" : ""}"><td><a href="${linkPessoa(l.pid, l.nome)}">${esc(cap(l.nome))}</a></td><td>${chipPartido(l.sigla, ano)}</td>
        <td class="num">${esc(l.nr)}</td><td class="num">${l.votos ? fmtN(l.votos) : "—"}</td><td class="num">${l.pct != null ? fmtPct(l.pct) : "—"}</td>
        <td>${l.res === "E" ? `<span class="mn-eleito">✓ Eleito</span>` : esc(RES[l.res] || "")}</td></tr>`).join("")}</tbody></table></div>`;
    verHtml = `<div class="pn-kpis mn-kpis">
        ${kpi("Cadeiras", fmtN(v.el.length), "", true)}
        ${kpi("Candidaturas", fmtN(v.n), `${fmtD(v.n / Math.max(1, v.el.length), 1)} por vaga`)}
        ${totVotos ? kpi("Votos nominais", fmtN(totVotos), "dados a candidatos (sem legenda)") : ""}
        ${kpi("Partidos com eleitos", fmtN(partidos.length), `de ${fmtN(v.part.length)} que lançaram candidatos`)}
      </div>
      <div class="pn-duas larga">
        <div><h5>Composição da Câmara</h5><div class="pn-hemi-wrap mn-hemi">${hemiciclo(partidos)}</div>
          <div class="pn-hemi-leg">${[...partidos].sort((a, c) => c.n - a.n).map((p) => `<span><i style="background:${COR_ESP[p.g]}"></i>${esc(p.sigla)} <b>${p.n}</b></span>`).join("")}</div></div>
        <div><h5>Partidos</h5><div class="tabela-wrap"><table class="pn-tabela"><thead><tr><th>Partido</th><th class="num">Eleitos</th><th class="num">Candidatos</th>${totVotos ? `<th class="num">Votos</th>` : ""}</tr></thead>
          <tbody>${v.part.slice(0, 20).map(([s, c, n, vt]) => `<tr><td>${chipPartido(s, ano)}</td><td class="num"><b>${n}</b></td><td class="num">${c}</td>${totVotos ? `<td class="num">${fmtN(vt)}</td>` : ""}</tr>`).join("")}</tbody></table></div></div>
      </div>
      <h5>Vereadores eleitos</h5>${tabela(eleitos)}
      ${outros.length ? `<details class="mn-todos"><summary>Ver os outros ${fmtN(outros.length)} candidatos a vereador</summary>${tabela(outros)}</details>`
        : ano < 2020 ? `<p class="nota">Para eleições anteriores a 2020, a página mostra só os vereadores eleitos.</p>` : ""}`;
  }
  return `<section class="pn-sec"><div class="pn-sec-cab"><h3>Prefeito(a) — ${ano}</h3>${temT2 ? "<p>eleição em dois turnos</p>" : ""}</div>${prefHtml}
      ${blocoParticipacao(m.p[String(ano)])}</section>
    ${v ? `<section class="pn-sec"><div class="pn-sec-cab"><h3>Câmara de Vereadores — ${ano}</h3></div>${verHtml}</section>` : ""}`;
}

async function secaoGeral(m, ano, uf) {
  const g = m.g[String(ano)];
  if (!g) return m.p[String(ano)] ? `<section class="pn-sec"><div class="pn-sec-cab"><h3>Eleições gerais — ${ano}</h3></div>${blocoParticipacao(m.p[String(ano)])}
    <p class="nota">A votação por candidato no município está disponível a partir de 2014.</p></section>` : "";
  let dic;
  try { dic = await getJson(`data/municipio/${uf}/g${ano}.json`); } catch { dic = []; }
  const gv = m.gv?.[String(ano)] || {};
  const blocos = ORDEM_GERAIS.filter((c) => g[c]).map((c) => {
    const turnos = Object.keys(g[c]).sort();
    const corpo = turnos.map((t) => {
      const linhas = g[c][t].map(([i, votos]) => { const x = dic[i] || []; return { pid: x[0], nome: x[1], sigla: x[2], res: x[4], nr: x[5], votos }; });
      const total = gv[c]?.[t] || null;
      const lista = c.startsWith("DEPUTADO") ? linhas.slice(0, 15) : linhas;
      return `<div>${turnos.length > 1 ? `<h5>${t}º turno</h5>` : ""}${barrasVotos(lista, ano, {
        total, destaqueEleito: !(turnos.length > 1 && t === "1"),
      })}</div>`;
    }).join("");
    const extra = c.startsWith("DEPUTADO") ? `<p class="nota">Os 15 mais votados no município; “eleito” = eleito pelo estado. % sobre os votos válidos no município (inclui legenda).</p>`
      : c === "PRESIDENTE" ? `<p class="nota">“Eleito” refere-se ao resultado nacional.</p>` : "";
    return `<div class="mn-cargo"><h4>${NOMES_CARGO[c]}</h4><div class="${turnos.length > 1 ? "pn-duas" : ""}">${corpo}</div>${extra}</div>`;
  }).join("");
  return `<section class="pn-sec"><div class="pn-sec-cab"><h3>Como ${esc(cap(m.n))} votou — ${ano}</h3><p>eleições gerais · os eleitos aparecem em destaque</p></div>
    ${await viesDoVoto(m, ano, uf, dic)}${blocos}${blocoParticipacao(m.p[String(ano)])}</section>`;
}

// Índice ideológico do voto para presidente no município, comparado ao estado e ao Brasil
async function viesDoVoto(m, ano, uf, dic) {
  const t1 = m.g[String(ano)]?.PRESIDENTE?.["1"];
  if (!t1) return "";
  let soma = 0, peso = 0;
  const esp = [0, 0, 0, 0, 0, 0];
  for (const [i, v] of t1) {
    const s = dic[i]?.[2]; if (!s) continue;
    const r = regra(s, ano);
    esp[grupoEspectro(s, ano)] += v;
    if (r) { soma += r[3] * v; peso += v; }
  }
  if (!peso) return "";
  const nota = soma / peso;
  if (!INDICE) INDICE = await getJson("data/painel/indice.json").catch(() => null);
  const nUF = INDICE?.serie?.[`${uf}|PRESIDENTE`]?.[ano]?.vnota, nBR = INDICE?.serie?.["BR|PRESIDENTE"]?.[ano]?.vnota;
  const marca = (n, rot, cls) => n == null ? "" : `<span class="marca ${cls}" style="left:${n * 10}%" ${dicaAttr(`${rot}: ${fmtD(n, 2)}`)}><b>${fmtD(n, 1)}</b><i>${rot}</i></span>`;
  const pts = []; for (let n = 0; n <= 10; n += 0.25) pts.push(`${corNota(n)} ${n * 10}%`);
  const tot = esp.reduce((a, b) => a + b, 0);
  return `<div class="mn-vies">
    <div class="mn-vies-txt"><span class="rot">Viés do voto para presidente (1º turno)</span>
      <span class="val" style="color:${corNota(nota)}">${fmtD(nota, 2)}</span><span class="faixa">${esc(faixaNota(nota))}</span>
      <span class="sub">esquerda + centro-esq.: <b>${fmtPct(pct(esp[0] + esp[1], tot), 0)}</b> · direita + centro-dir.: <b>${fmtPct(pct(esp[3] + esp[4], tot), 0)}</b></span></div>
    <div class="mn-regua"><div class="trilho" style="background:linear-gradient(90deg, ${pts.join(",")})"></div>
      ${marca(nBR, "Brasil", "br")}${marca(nUF, uf, nBR != null && nUF != null && Math.abs(nUF - nBR) < 0.6 ? "uf baixo" : "uf")}${marca(nota, "este município", "aqui")}
      <div class="ext"><span>0 · esquerda</span><span>direita · 10</span></div></div>
  </div>`;
}

function resumoTopo(m, uf) {
  const anos = m.anos;
  const prefeitos = anos.filter((a) => m.m[String(a)]?.pref).map((a) => {
    const el = m.m[String(a)].pref.find((l) => l[4] === "E");
    return el ? [a, el] : null;
  }).filter(Boolean);
  const ult = anos.find((a) => m.p[String(a)]?.["1"]);
  const p = ult ? m.p[String(ult)]["1"] : null;
  const atual = prefeitos[0];
  return `<section class="pn-sec mn-topo">
    <div class="mn-titulo"><h2>${esc(cap(m.n))} <span>· ${esc(NOMES_UF[uf] || uf)}</span></h2>
      <a class="pn-limpa" href="${hashDe({ uf })}">← outros municípios</a></div>
    <div class="pn-kpis">
      ${p ? kpi(`Eleitorado (${ult})`, fmtN(p[0]), `abstenção de ${fmtPct(pct(p[2], p[0]), 1)} no 1º turno`, true) : ""}
      ${atual ? kpi(`Prefeito(a) eleito(a) em ${atual[0]}`, `<a href="${linkPessoa(atual[1][0], atual[1][1])}">${esc(cap(atual[1][1]))}</a>`,
        `${esc(atual[1][2])} · ${GRUPOS[grupoEspectro(atual[1][2], atual[0])]}${atual[1][6] != null ? ` · ${fmtPct(atual[1][6])} dos votos válidos` : ""}`) : ""}
    </div>
    ${prefeitos.length > 1 ? `<h4>Prefeitos eleitos ao longo do tempo</h4><div class="mn-linha-tempo">${prefeitos.map(([a, l]) => {
      const g = grupoEspectro(l[2], a);
      return `<a class="mn-lt" href="${hashDe({ uf, m: m.c, ano: a })}" style="--c:${COR_ESP[g]}" ${dicaAttr(`${a}: ${esc(cap(l[1]))} (${esc(l[2])})<br>${GRUPOS[g]}`)}>
        <span class="a">${a}</span><span class="s">${esc(l[2])}</span><span class="n">${esc(cap(l[1]))}</span></a>`;
    }).join("")}</div>` : ""}
  </section>`;
}

async function telaMunicipio(e) {
  let m;
  try { m = await getJson(`data/municipio/${e.uf}/${e.m}.json`); } catch { $("#mun").innerHTML = `<div class="status erro">Município não encontrado.</div>`; return; }
  $("#busca-wrap").hidden = true;
  trilha([[NOMES_UF[e.uf], hashDe({ uf: e.uf })], [cap(m.n), hashDe({ uf: e.uf, m: e.m })]]);
  document.title = `${cap(m.n)} (${e.uf}) · Eleições no Município · Lente Pública`;
  const anos = m.anos;
  const ano = anos.includes(e.ano) ? e.ano : anos[0];
  const abas = `<div class="pn-seg mn-anos" role="tablist" aria-label="Eleição">${anos.map((a) =>
    `<a role="tab" href="${hashDe({ uf: e.uf, m: e.m, ano: a })}" aria-selected="${a === ano}" class="${a === ano ? "ativo" : ""}">${a}<small>${a % 4 === 0 ? "municipal" : "geral"}</small></a>`).join("")}</div>`;
  const corpo = ano % 4 === 0 ? secaoMunicipal(m, ano) : await secaoGeral(m, ano, e.uf);
  $("#mun").innerHTML = `${resumoTopo(m, e.uf)}<div class="mn-abas-wrap"><h4>Escolha a eleição</h4>${abas}</div>${corpo || `<div class="status">Sem dados desta eleição para o município.</div>`}`;
}

function trilha(itens) {
  $("#trilha").innerHTML = [`<a href="#">Brasil</a>`, ...itens.map(([t, h], i) => i === itens.length - 1 ? `<b>${esc(t)}</b>` : `<a href="${h}">${esc(t)}</a>`)].join(`<span>›</span>`);
}

async function rotear() {
  const e = lerEstado();
  const y = scrollY;
  if (e.uf && e.m) await telaMunicipio(e);
  else if (e.uf && NOMES_UF[e.uf]) await telaMunicipios(e.uf);
  else await telaEstados();
  if (e.m && y > 300) window.scrollTo({ top: Math.min(y, document.querySelector(".mn-abas-wrap")?.offsetTop - 80 || 0) });
  else window.scrollTo({ top: 0 });
}

async function iniciar() {
  try {
    META = await getJson("data/meta.json");
    MAPA = await getJson("assets/mapa-brasil.json");
  } catch {
    $("#mun").innerHTML = `<div class="status erro">Os dados ainda não foram gerados.</div>`;
    return;
  }
  $("#meta-info").textContent = `Base atualizada em ${META.gerado_em.split("-").reverse().join("/")}.`;
  ligarDicas();
  window.addEventListener("hashchange", rotear);
  rotear();
}

iniciar();
