"use strict";

// Painel das eleições (painel.html). Dados: data/painel/AAAA.json e data/painel/indice.json (scripts/painel.py).
// Estado na URL: painel.html#ano=2022&uf=BA&cargo=GOVERNADOR

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = (x) => (x ?? 0).toLocaleString("pt-BR");
const fmtPct = (x, d = 1) => x == null || !isFinite(x) ? "—" : `${x.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
const pct = (a, b) => (b ? (100 * a) / b : null);
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brlCurto = (v) => v == null ? "—" : v >= 1e9 ? `R$ ${(v / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} bi`
  : v >= 1e6 ? `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi` : brl.format(v);

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
const GRUPOS = ["Esquerda", "Centro-esquerda", "Centro", "Centro-direita", "Direita", "Sem classificação"];

// Espectro da legenda (mesma regra de app.js): faixas do estudo agrupadas em 5 + "sem classificação"
const siglaNorm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
function grupoEspectro(sigla, ano) {
  const s = siglaNorm(sigla);
  const r = (META.espectro?.regras || []).find((x) => x[0] === s && ano >= x[1]);
  if (!r) return 5;
  const f = (META.espectro.faixas || []).find(([lim]) => r[3] <= lim)?.[1] || "";
  const g = f === "Extrema-esquerda" ? "Esquerda" : f === "Extrema-direita" ? "Direita" : f;
  return Math.max(0, GRUPOS.indexOf(g));
}

// ---------- Estado ----------
function lerEstado() {
  const h = new URLSearchParams(location.hash.slice(1));
  const anos = INDICE.anos;
  let ano = +h.get("ano");
  if (!anos.includes(ano)) ano = anos[anos.length - 1];
  return { ano, uf: (h.get("uf") || "BR").toUpperCase(), cargo: h.get("cargo") || "TODOS" };
}
function irPara(e) {
  const h = new URLSearchParams();
  h.set("ano", e.ano);
  if (e.uf && e.uf !== "BR") h.set("uf", e.uf);
  if (e.cargo && e.cargo !== "TODOS") h.set("cargo", e.cargo);
  location.hash = h.toString();
}
const tipoAno = (a) => (a % 4 === 0 ? "municipal" : "geral");

// ---------- Componentes ----------
const kpi = (rot, val, sub = "", destaque = false) =>
  `<div class="kpi${destaque ? " destaque" : ""}"><div class="rot">${rot}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

// Barras horizontais. itens: [{rot, v, txt?, cls?, v2?, txt2?}] — v2 desenha uma segunda barra (comparação)
function barras(itens, { max = null, leg = null } = {}) {
  if (!itens.length) return `<p class="muted">Sem dados.</p>`;
  const m = max ?? Math.max(...itens.flatMap((i) => [i.v, i.v2 ?? 0]), 1e-9);
  return `${leg ? `<div class="pn-leg">${leg}</div>` : ""}<div class="pn-barras">${itens.map((i) => `
    <div class="pn-linha${i.cls ? " " + i.cls : ""}"><span class="pn-rot" title="${esc(i.rot)}">${i.ponto != null ? `<i class="pn-ponto esp-${i.ponto}"></i>` : ""}${esc(i.rot)}</span>
      <span class="pn-trilhos">
        <span class="pn-trilho"><span class="pn-pista"><span class="pn-barra a" style="width:${Math.max(0, (100 * i.v) / m)}%"></span></span><b>${i.txt ?? fmtN(i.v)}</b></span>
        ${i.v2 != null ? `<span class="pn-trilho"><span class="pn-pista"><span class="pn-barra b" style="width:${Math.max(0, (100 * i.v2) / m)}%"></span></span><b>${i.txt2 ?? fmtN(i.v2)}</b></span>` : ""}
      </span></div>`).join("")}</div>`;
}

// Barra 100% por espectro: valores[6]
function barraEspectro(valores, titulo) {
  const total = valores.reduce((a, b) => a + b, 0);
  if (!total) return "";
  return `<div class="pn-esp"><div class="pn-esp-tit">${titulo} <small>(${fmtN(total)})</small></div>
    <div class="pn-esp-barra" role="img" aria-label="${esc(titulo)}">${valores.map((v, i) => v ? `<span class="esp-${i}" style="width:${(100 * v) / total}%"
      title="${GRUPOS[i]}: ${fmtN(v)} (${fmtPct(pct(v, total))})">${(100 * v) / total >= 8 ? Math.round((100 * v) / total) + "%" : ""}</span>` : "").join("")}</div></div>`;
}
const legendaEspectro = () => `<div class="legenda-esp">${GRUPOS.map((g, i) => `<span class="esp-${i}"><i></i>${g}</span>`).join("")}</div>`;

// Gráfico de linhas (SVG, escala uniforme). series: [{nome, cls, pontos: [[ano, valor]]}]
function linhas(series, { sufixo = "%", maxY = null } = {}) {
  const anos = [...new Set(series.flatMap((s) => s.pontos.map((p) => p[0])))].sort((a, b) => a - b);
  if (anos.length < 2) return `<p class="muted">Série histórica indisponível para este recorte.</p>`;
  const W = 460, H = 250, M = { l: 46, r: 16, t: 12, b: 28 };
  const vals = series.flatMap((s) => s.pontos.map((p) => p[1])).filter((v) => v != null);
  const top = maxY ?? Math.max(5, Math.ceil(Math.max(...vals) / 10) * 10);
  const x = (a) => M.l + ((anos.indexOf(a)) / (anos.length - 1)) * (W - M.l - M.r);
  const y = (v) => H - M.b - (v / top) * (H - M.t - M.b);
  const grade = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = top * f;
    return `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" class="grade"/><text x="${M.l - 6}" y="${y(v) + 4}" class="eixo" text-anchor="end">${Math.round(v)}${sufixo}</text>`;
  }).join("");
  const ex = anos.map((a) => `<text x="${x(a)}" y="${H - 6}" class="eixo" text-anchor="middle">${a}</text>`).join("");
  const ls = series.map((s) => {
    const pts = s.pontos.filter((p) => p[1] != null);
    if (!pts.length) return "";
    return `<g class="serie ${s.cls || ""}"><polyline points="${pts.map((p) => `${x(p[0])},${y(p[1])}`).join(" ")}"/>
      ${pts.map((p) => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="4.5"><title>${esc(s.nome)} — ${p[0]}: ${fmtPct(p[1])}</title></circle>`).join("")}</g>`;
  }).join("");
  return `<svg class="pn-linhas" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução ao longo dos anos">${grade}${ex}${ls}</svg>
    <div class="legenda-esp">${series.map((s) => `<span class="${s.cls || ""}"><i></i>${esc(s.nome)}</span>`).join("")}</div>`;
}

// Mapa coroplético. valores: {UF: número}; fmt: formatação
function mapa(valores, fmt, ufAtual) {
  if (!MAPA) return "";
  const vs = Object.values(valores).filter((v) => v != null && isFinite(v));
  const min = Math.min(...vs), max = Math.max(...vs);
  const tom = (v) => (v == null || !isFinite(v) ? null : max === min ? 60 : 12 + (88 * (v - min)) / (max - min));
  return `<div class="pn-mapa-wrap"><svg class="mapa pn-mapa" viewBox="${MAPA.viewBox}" role="img" aria-label="Mapa do Brasil por estado">
    ${MAPA.locations.map((l) => {
      const uf = l.id.toUpperCase(), v = valores[uf], t = tom(v);
      return `<a href="#" data-uf="${uf}" aria-label="${esc(NOMES_UF[uf])}: ${v == null ? "sem dado" : fmt(v)}">
        <path d="${l.path}" class="${uf === ufAtual ? "atual" : ""}" style="${t == null ? "" : `fill:color-mix(in srgb, var(--vermelho) ${t}%, var(--surface-2))`}">
        <title>${esc(NOMES_UF[uf])}: ${v == null ? "sem dado" : fmt(v)}</title></path></a>`;
    }).join("")}</svg>
    ${vs.length ? `<div class="pn-escala"><span>${fmt(min)}</span><i></i><span>${fmt(max)}</span></div>` : ""}</div>`;
}

// ---------- Seções ----------
function secPanorama(d, e, b) {
  const [cand, el] = b.n;
  const fem = b.perfil.genero.Feminino || [0, 0];
  const [reel, jaEl, estreantesEl] = b.ren;
  const anoMin = INDICE.anos[0];
  return `<div class="pn-kpis">
      ${kpi("Candidaturas", fmtN(cand), "", true)}
      ${kpi("Eleitos", fmtN(el), el ? `${(cand / el).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} candidaturas por eleito` : "")}
      ${kpi("Mulheres entre os eleitos", fmtPct(pct(fem[1], el)), `${fmtN(fem[1])} eleitas · ${fmtPct(pct(fem[0], cand))} das candidaturas`)}
      ${kpi("Reeleitos", e.ano - (e.cargo === "SENADOR" ? 8 : 4) >= anoMin ? fmtPct(pct(reel, el)) : "—",
        e.ano - 4 >= anoMin ? `${fmtN(reel)} eleitos para o mesmo cargo na eleição anterior` : "sem eleição anterior na base")}
      ${kpi("Já tinham sido eleitos", fmtPct(pct(jaEl, el)), "para qualquer cargo, em eleições anteriores (desde 1994)")}
      ${kpi("Estreantes eleitos", fmtPct(pct(estreantesEl, el)), `${fmtN(estreantesEl)} venceram na primeira candidatura`)}
    </div>`;
}

const METRICAS_MAPA = {
  cand: { rot: "Candidaturas", val: (b) => b?.n[0], fmt: fmtN },
  el: { rot: "Eleitos", val: (b) => b?.n[1], fmt: fmtN },
  fem: { rot: "% de mulheres eleitas", val: (b) => b && pct(b.perfil.genero.Feminino?.[1] || 0, b.n[1]), fmt: (v) => fmtPct(v) },
  barradas: { rot: "% de candidaturas barradas", val: (b) => b && pct((b.restr.sit.Indeferida || 0) + (b.restr.sit.Cassada || 0), b.n[0]), fmt: (v) => fmtPct(v) },
  abst: { rot: "Abstenção (1º turno)", part: true, fmt: (v) => fmtPct(v) },
};
let metricaMapa = "fem";

function valoresMapa(d, e) {
  const m = METRICAS_MAPA[metricaMapa];
  const out = {};
  for (const uf of d.ufs) {
    if (m.part) {
      const p = d.part[`${uf}|${e.cargo}`]?.["1"];
      out[uf] = p && p[0] ? pct(p[2], p[0]) : null;
    } else out[uf] = m.val(d.g[`${uf}|${e.cargo}`]) ?? null;
  }
  return out;
}

function blocoMapa(d, e) {
  const m = METRICAS_MAPA[metricaMapa];
  return `<div class="pn-mapa-bloco"><div class="pn-mapa-opcoes" role="group" aria-label="Indicador do mapa">
      ${Object.entries(METRICAS_MAPA).map(([k, x]) => `<button type="button" data-metrica="${k}" aria-pressed="${k === metricaMapa}">${x.rot}</button>`).join("")}
    </div>
    ${mapa(valoresMapa(d, e), m.fmt, e.uf)}
    <p class="nota">${esc(m.rot)} por estado — ${esc(NOMES_CARGO[e.cargo])}, ${e.ano}. Clique em um estado para filtrar o painel${e.uf !== "BR" ? ` ou <a href="#" id="pn-brasil">volte ao Brasil</a>` : ""}.
      ${e.cargo === "PRESIDENTE" && !m.part ? "Para presidente os candidatos são nacionais: o mapa mostra só a abstenção." : ""}</p></div>`;
}

function secPartidos(d, e, b) {
  const serie = INDICE.serie[`${e.uf}|${e.cargo}`] || {};
  const anosTipo = Object.keys(serie).map(Number).filter((a) => tipoAno(a) === tipoAno(e.ano)).sort((a, b) => a - b);
  const evol = GRUPOS.map((g, i) => ({ nome: g, cls: `esp-${i}`, pontos: anosTipo.map((a) => {
    const s = serie[a], t = s.esp.reduce((x, y) => x + y, 0);
    return [a, t ? (100 * s.esp[i]) / t : null];
  }) }));
  const top = b.partidos.slice(0, 20);
  return `<div class="pn-duas">
      <div>${barraEspectro(b.esp.map((x) => x[0]), "Candidaturas")}${barraEspectro(b.esp.map((x) => x[1]), "Eleitos")}${legendaEspectro()}
        <p class="nota">Espectro do <strong>partido</strong> pelo qual a pessoa concorreu, segundo Bolognesi, Ribeiro e Codato (2023).
          “Esquerda” inclui a extrema-esquerda e “Direita” a extrema-direita. <a href="./#partidos=1">Ver a tabela de partidos e a metodologia</a>.</p></div>
      <div><h4>Eleitos por espectro ao longo dos anos</h4>${linhas(evol, { maxY: 100 })}
        <p class="nota">Eleições ${tipoAno(e.ano) === "geral" ? "gerais" : "municipais"} — ${esc(NOMES_UF[e.uf])}, ${esc(NOMES_CARGO[e.cargo].toLowerCase())}.
          A nota de cada partido foi medida em 2018 e é aplicada a todas as eleições.</p></div>
    </div>
    <h4>Partidos: eleitos e candidaturas</h4>
    ${barras(top.map(([sig, c, el]) => ({ rot: sig, ponto: grupoEspectro(sig, e.ano), v: el, txt: `${fmtN(el)} eleito${el === 1 ? "" : "s"}`,
      v2: c, txt2: `${fmtN(c)} candidatura${c === 1 ? "" : "s"} · ${fmtPct(pct(el, c))} de sucesso` })),
      { leg: `<span class="a"><i></i>Eleitos</span><span class="b"><i></i>Candidaturas</span><span class="muted">(escalas na mesma régua)</span>` })}
    ${b.partidos.length > 20 ? `<p class="nota">Mostrando os 20 partidos com mais eleitos de ${b.partidos.length}.</p>` : ""}`;
}

function comparativo(cont, cand, el, ordem = null) {
  let itens = Object.entries(cont);
  if (ordem) itens.sort((a, b) => (ordem.indexOf(a[0]) + 1 || 99) - (ordem.indexOf(b[0]) + 1 || 99));
  return barras(itens.filter(([k]) => k !== "Não Divulgável" || cont[k][0] > 0).map(([k, [c, e]]) => ({
    rot: k, v: pct(c, cand) || 0, txt: fmtPct(pct(c, cand)), v2: pct(e, el) || 0, txt2: fmtPct(pct(e, el)) })), { max: null });
}

function secPerfil(d, e, b) {
  const [cand, el] = b.n;
  const leg = `<div class="pn-leg"><span class="a"><i></i>% das candidaturas</span><span class="b"><i></i>% dos eleitos</span></div>`;
  const serie = INDICE.serie[`${e.uf}|${e.cargo}`] || {};
  const anosTipo = Object.keys(serie).map(Number).filter((a) => tipoAno(a) === tipoAno(e.ano)).sort((a, b) => a - b);
  const evolFem = [
    { nome: "Mulheres entre as candidaturas", cls: "s-a", pontos: anosTipo.map((a) => [a, pct(serie[a].fem[0], serie[a].n[0])]) },
    { nome: "Mulheres entre os eleitos", cls: "s-b", pontos: anosTipo.map((a) => [a, pct(serie[a].fem[1], serie[a].n[1])]) },
  ];
  const ocup = Object.entries(b.perfil.ocupacao).filter(([k]) => k && k !== "Outros").sort((x, y) => y[1][1] - x[1][1]).slice(0, 10);
  const ORDEM_IDADE = ["Até 29", "30 a 39", "40 a 49", "50 a 59", "60 ou mais", "Não informado"];
  return `${leg}<div class="pn-duas">
      <div><h4>Gênero</h4>${comparativo(b.perfil.genero, cand, el)}</div>
      <div><h4>Cor/raça ${e.ano < 2014 ? `<small class="muted">(o TSE só coleta a partir de 2014)</small>` : ""}</h4>${comparativo(b.perfil.cor, cand, el)}</div>
      <div><h4>Faixa de idade (na eleição)</h4>${comparativo(b.perfil.idade, cand, el, ORDEM_IDADE)}</div>
      <div><h4>Escolaridade</h4>${comparativo(b.perfil.instrucao, cand, el)}</div>
    </div>
    <div class="pn-duas">
      <div><h4>Mulheres ao longo dos anos</h4>${linhas(evolFem)}</div>
      <div><h4>Ocupações mais comuns entre os eleitos</h4>${barras(ocup.map(([k, [c, x]]) => ({ rot: k, v: x, txt: `${fmtN(x)} eleito${x === 1 ? "" : "s"} · ${fmtN(c)} candidaturas` })))}
        <p class="nota">Ocupação declarada pela própria pessoa ao TSE; “Outros” não aparece.</p></div>
    </div>`;
}

function secDinheiro(d, e, b) {
  const din = b.din;
  if (!din) return `<p class="muted">O TSE publica bens declarados a partir de 2006 e receitas de campanha a partir de 2018 nesta base.</p>`;
  const k = [];
  if (din.pub_total != null) {
    k.push(kpi("Verba pública nas campanhas", brlCurto(din.pub_total), "Fundo Eleitoral (FEFC) + Fundo Partidário recebidos pelos candidatos", true));
    k.push(kpi("Receita mediana", `${brlCurto(din.rec_mediana[0])}`, `dos eleitos · ${brlCurto(din.rec_mediana[1])} dos não eleitos`));
    k.push(kpi("Custo mediano do voto", din.custo_voto == null ? "—" : brl2.format(din.custo_voto), "receita de campanha ÷ votos, entre os eleitos"));
  }
  if (din.bens_mediana) {
    k.push(kpi("Patrimônio mediano dos eleitos", brlCurto(din.bens_mediana[0]), `${brlCurto(din.bens_mediana[1])} entre todas as candidaturas`));
    k.push(kpi("Candidaturas milionárias", fmtN(din.bens_milionarios[0]), `bens declarados ≥ R$ 1 milhão · ${fmtN(din.bens_milionarios[1])} foram eleitas`));
  }
  const pp = (din.pub_partidos || []).slice(0, 15);
  return `<div class="pn-kpis">${k.join("")}</div>
    ${pp.length ? `<h4>Verba pública recebida pelos candidatos, por partido</h4>
      ${barras(pp.map(([s, v]) => ({ rot: s, ponto: grupoEspectro(s, e.ano), v, txt: brlCurto(v) })))}` : ""}
    <p class="nota">Valores declarados ao TSE, em reais da época (sem correção pela inflação). Mediana = valor do meio (metade acima, metade abaixo),
      menos sensível a casos extremos que a média. Receitas: prestação de contas dos candidatos (2018 em diante).</p>`;
}

const EXPLICA_SIT = {
  Indeferida: "registro negado pela Justiça Eleitoral (inclui pedidos não conhecidos e candidaturas inaptas)",
  Cassada: "registro ou diploma retirado por decisão judicial depois de aprovado",
  "Renúncia": "a própria pessoa desistiu",
  Cancelada: "cancelada, em geral a pedido do partido",
  Falecimento: "candidatura encerrada por falecimento",
};
function secRestricoes(d, e, b) {
  const [cand] = b.n;
  const sit = b.restr.sit;
  const mot = b.restr.motivos || [];
  return `<div class="pn-kpis">${Object.keys(EXPLICA_SIT).filter((k) => sit[k]).map((k) =>
      kpi(k === "Renúncia" ? "Renúncias" : `${k}s`, fmtN(sit[k]), `${fmtPct(pct(sit[k], cand))} das candidaturas · ${EXPLICA_SIT[k]}`)).join("") || `<p class="muted">Nenhuma restrição registrada neste recorte.</p>`}
      ${b.restr.coletivo ? kpi("Atingidas por decisão sobre a chapa", fmtN(b.restr.coletivo), "votos anulados porque o partido/chapa foi invalidado (ex.: fraude à cota de gênero), não por problema individual") : ""}
    </div>
    ${mot.length ? `<h4>Motivos informados pelo TSE</h4>${barras(mot.map(([m, n]) => ({ rot: m, v: n, txt: fmtN(n) })))}
      <p class="nota">Uma candidatura pode ter mais de um motivo. O TSE publica os motivos a partir de 2014.</p>`
      : e.ano < 2014 ? `<p class="nota">O TSE só publica o motivo específico das restrições a partir de 2014.</p>` : ""}
    <p class="nota">Na consulta por nome, cada candidatura com restrição tem um “entenda” com a explicação e o motivo.</p>`;
}

function secParticipacao(d, e) {
  const p = d.part[`${e.uf}|${e.cargo}`];
  if (!p) return `<p class="muted">Dados de comparecimento indisponíveis para este recorte${e.ano < 2014 ? " (a base tem comparecimento a partir de 2014)" : ""}.</p>`;
  const turnos = Object.keys(p).sort();
  const cards = turnos.map((t) => {
    const [aptos, comp, abst, val, br, nul] = p[t];
    const tot = val + br + nul;
    return `<div class="pn-turno"><h4>${t}º turno</h4>
      <div class="pn-kpis">
        ${kpi("Eleitorado", fmtN(aptos), "", true)}
        ${kpi("Comparecimento", fmtPct(pct(comp, aptos), 2), fmtN(comp) + " eleitores")}
        ${kpi("Abstenção", fmtPct(pct(abst, aptos), 2), fmtN(abst) + " eleitores")}
        ${kpi("Brancos", fmtPct(pct(br, tot), 2), "dos votos dados")}
        ${kpi("Nulos", fmtPct(pct(nul, tot), 2), "dos votos dados")}
        ${kpi("Válidos", fmtPct(pct(val, tot), 2), "dos votos dados")}
      </div>
      <div class="pn-pilha" role="img" aria-label="Composição do eleitorado">
        <span class="v" style="width:${pct(val, aptos)}%" title="Válidos">Válidos</span><span class="br" style="width:${pct(br, aptos)}%" title="Brancos"></span>
        <span class="nu" style="width:${pct(nul, aptos)}%" title="Nulos"></span><span class="ab" style="width:${pct(abst, aptos)}%" title="Abstenção">Abstenção</span>
      </div>
      <div class="pn-leg"><span class="v"><i></i>Válidos</span><span class="br"><i></i>Brancos</span><span class="nu"><i></i>Nulos</span><span class="ab"><i></i>Abstenção</span></div></div>`;
  }).join("");
  const serie = INDICE.serie[`${e.uf}|${e.cargo}`] || {};
  const anosTipo = Object.keys(serie).map(Number).filter((a) => tipoAno(a) === tipoAno(e.ano) && serie[a].abst != null).sort((a, b) => a - b);
  const cargoUsado = e.cargo === "TODOS" ? " (comparecimento do cargo principal da eleição)" : "";
  return `${cards}<h4>Abstenção no 1º turno ao longo dos anos</h4>
    ${linhas([{ nome: "Abstenção", cls: "s-b", pontos: anosTipo.map((a) => [a, serie[a].abst]) }], { maxY: 40 })}
    <p class="nota">Eleitorado apto, comparecimento e votos por tipo, somados das zonas eleitorais${cargoUsado}. Brancos, nulos e válidos
      em % dos votos dados. Abstenção em % do eleitorado. ${e.uf === "BR" ? "Brasil inclui o voto no exterior quando há (presidente)." : ""}</p>`;
}

// ---------- Página ----------
async function desenhar() {
  const e = lerEstado();
  const alvo = $("#painel");
  let d;
  try { d = await getJson(`data/painel/${e.ano}.json`); } catch (err) {
    alvo.innerHTML = `<div class="status erro">Não foi possível carregar os dados de ${e.ano}.</div>`; return;
  }
  // Ajusta UF/cargo inexistentes no ano escolhido
  if (e.uf !== "BR" && !d.ufs.includes(e.uf)) e.uf = "BR";
  if (e.cargo !== "TODOS" && !d.cargos.includes(e.cargo)) e.cargo = "TODOS";
  preencherFiltros(d, e);

  const b = d.g[`${e.uf}|${e.cargo}`];
  const titulo = `${NOMES_CARGO[e.cargo]} · ${NOMES_UF[e.uf]} · ${e.ano}`;
  const preliminar = e.ano === Math.max(...INDICE.anos) && e.ano >= new Date().getFullYear();
  const sec = (id, tit, corpo) => `<section class="bloco pn-sec" id="${id}"><h3>${tit}</h3>${corpo}</section>`;
  const semCand = `<p class="muted">Para presidente os candidatos são nacionais: escolha <a href="#" id="pn-brasil2">Brasil</a> para ver candidaturas,
    partidos e perfil. A participação do eleitor neste estado está abaixo.</p>`;
  alvo.innerHTML = `
    <div class="pn-titulo"><h2>${esc(titulo)}</h2>
      ${preliminar ? `<span class="selo turno">dados preliminares — eleição em andamento</span>` : ""}</div>
    ${sec("s-panorama", "Panorama", b ? secPanorama(d, e, b) + blocoMapa(d, e) : semCand + blocoMapa(d, e))}
    ${b ? sec("s-partidos", "Partidos e espectro político", secPartidos(d, e, b)) : ""}
    ${b ? sec("s-perfil", "Perfil: candidaturas × eleitos", secPerfil(d, e, b)) : ""}
    ${b ? sec("s-dinheiro", "Dinheiro: financiamento e patrimônio", secDinheiro(d, e, b)) : ""}
    ${b ? sec("s-restricoes", "Restrições: candidaturas barradas", secRestricoes(d, e, b)) : ""}
    ${sec("s-participacao", "Participação do eleitor", secParticipacao(d, e))}`;
  ligar(d, e);
}

function preencherFiltros(d, e) {
  const anos = [...INDICE.anos].reverse();
  $("#f-ano").innerHTML = anos.map((a) => `<option value="${a}"${a === e.ano ? " selected" : ""}>${a} · ${tipoAno(a) === "geral" ? "gerais" : "municipais"}</option>`).join("");
  $("#f-uf").innerHTML = ["BR", ...d.ufs].map((u) => `<option value="${u}"${u === e.uf ? " selected" : ""}>${esc(NOMES_UF[u] || u)}</option>`).join("");
  $("#f-cargo").innerHTML = ["TODOS", ...d.cargos].map((c) => `<option value="${c}"${c === e.cargo ? " selected" : ""}>${esc(NOMES_CARGO[c] || c)}</option>`).join("");
}

function ligar(d, e) {
  document.querySelectorAll(".pn-mapa a[data-uf]").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault();
    const uf = a.dataset.uf;
    if (d.ufs.includes(uf)) irPara({ ...e, uf: uf === e.uf ? "BR" : uf });
  }));
  document.querySelectorAll("#pn-brasil, #pn-brasil2").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); irPara({ ...e, uf: "BR" }); }));
  document.querySelectorAll(".pn-mapa-opcoes button").forEach((bt) => bt.addEventListener("click", () => {
    metricaMapa = bt.dataset.metrica;
    const bl = $(".pn-mapa-bloco");
    bl.outerHTML = blocoMapa(d, e);
    ligar(d, e);
  }));
}

async function iniciar() {
  try {
    META = await getJson("data/meta.json");
    INDICE = await getJson("data/painel/indice.json");
    MAPA = await getJson("assets/mapa-brasil.json");
  } catch (err) {
    $("#painel").innerHTML = `<div class="status erro">O painel ainda não foi gerado.</div>`;
    return;
  }
  $("#meta-info").textContent = `Base atualizada em ${META.gerado_em.split("-").reverse().join("/")}.`;
  const muda = () => irPara({ ano: +$("#f-ano").value, uf: $("#f-uf").value, cargo: $("#f-cargo").value });
  ["#f-ano", "#f-uf", "#f-cargo"].forEach((s) => $(s).addEventListener("change", muda));
  document.querySelectorAll(".painel-nav a").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault();  // o hash guarda o estado do painel; a navegação entre seções só rola a página
    document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  window.addEventListener("hashchange", desenhar);
  desenhar();
}

iniciar();
