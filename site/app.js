"use strict";

// Precisa bater com scripts/build.py
const STOP = new Set(["DA", "DE", "DO", "DAS", "DOS", "E", "D", "DI", "DU"]);
const MAX_RESULTADOS = 60;
const TITULARES = new Set(["PRESIDENTE", "GOVERNADOR", "PREFEITO", "SENADOR"]);

const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const brlCurto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const semAnimacao = matchMedia("(prefers-reduced-motion: reduce)").matches;

let META = null;
const cacheJson = new Map();

// meta.json é sempre revalidado; os demais arquivos levam a versão do build na URL,
// para que o cache do navegador nunca misture arquivos de builds diferentes.
function getJson(url) {
  if (!cacheJson.has(url)) {
    const fonte = META ? `${url}?v=${META.versao}` : url;
    cacheJson.set(url, fetch(fonte, META ? {} : { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ao carregar ${url}`);
      return r.json();
    }));
  }
  return cacheJson.get(url);
}

function normaliza(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[^A-Z]+/g, " ").trim().replace(/\s+/g, " ");
}
const tokens = (n) => n.split(" ").filter((t) => t && !STOP.has(t));

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function bucketUrl(chave) {
  const b = fnv1a(chave) % META.n_buckets;
  return `data/idx/${b.toString(16).padStart(3, "0")}.json`;
}

async function buscarChave(chave) {
  const balde = await getJson(bucketUrl(chave));
  return balde[chave]; // lista de ids, número (muitas pessoas) ou undefined
}

// As listas do índice já vêm ordenadas por relevância; a interseção preserva essa ordem.
function intersecta(listas) {
  const outras = listas.slice(1).map((l) => new Set(l));
  return listas[0].filter((x) => outras.every((s) => s.has(x)));
}

// Retorna { ids } ou { muitos: true }
async function localizar(tk) {
  if (tk.length === 1) {
    const v = await buscarChave(tk[0]);
    if (v === undefined) return { ids: [] };
    return typeof v === "number" ? { muitos: true } : { ids: v };
  }
  // Tenta cada palavra como primeiro nome (cobre "Bolsonaro Jair" e similares).
  for (const primeiro of tk) {
    const outros = tk.filter((t) => t !== primeiro);
    const valores = await Promise.all(outros.map((t) => buscarChave(`${primeiro} ${t}`)));
    if (valores.some((v) => v === undefined)) continue;
    const listas = valores.filter(Array.isArray);
    if (!listas.length) return { muitos: true };
    const ids = intersecta(listas);
    if (ids.length) return { ids };
  }
  return { ids: [] };
}

async function pessoa(pid) {
  const lote = await getJson(`data/p/${Math.floor(pid / META.por_arquivo)}.json`);
  const [nome, urnas, anoNasc, ocupacao, cands, cpf, perfil, sancoes, fotos] = lote[pid % META.por_arquivo];
  const T = META.tabelas;
  const [genero, instrucao, cor, ufNasc] = perfil || [0, 0, 0, ""];
  return {
    pid, nome, urnas, anoNasc, cpf, ocupacao: T.ocupacao[ocupacao], cands: cands.map(candidatura),
    perfil: { genero: T.genero?.[genero], instrucao: T.instrucao?.[instrucao], cor: T.cor?.[cor], ufNasc },
    sancoes: (sancoes || []).map(sancao),
    fotos: (fotos || []).map(([k, sq, ue]) => `${FOTO_BASE}/${META.fotos_eleicoes[k]}/${sq}/${ue}`),
  };
}

// ---------- Fotos (servidas pelo DivulgaCandContas/TSE, direto no navegador do visitante) ----------

const FOTO_BASE = "https://divulgacandcontas.tse.jus.br/divulga/rest/arquivo/img";
const fotoCache = new Map(); // url -> Promise<boolean> (true = foto real)

// O TSE devolve uma silhueta genérica de 171x235 quando não há foto.
function fotoReal(url) {
  if (!fotoCache.has(url)) {
    fotoCache.set(url, new Promise((res) => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => res(!(img.naturalWidth === 171 && img.naturalHeight === 235));
      img.onerror = () => res(false);
      img.src = url;
    }));
  }
  return fotoCache.get(url);
}

function avatar(p, classes = "") {
  const eleito = p.cands.some((c) => c.eleito);
  return `<span class="avatar ${classes}${eleito ? " eleito" : ""}" aria-hidden="true" data-fotos="${esc(JSON.stringify(p.fotos))}">${esc(iniciais(p.nome))}</span>`;
}

// Troca as iniciais pela primeira foto real disponível (tenta até 3 candidaturas recentes).
async function ativarFotos(raiz = document) {
  for (const el of raiz.querySelectorAll(".avatar[data-fotos]")) {
    const urls = JSON.parse(el.dataset.fotos || "[]");
    el.removeAttribute("data-fotos");
    (async () => {
      for (const u of urls) {
        if (await fotoReal(u)) {
          el.classList.add("com-foto");
          el.innerHTML = `<img src="${esc(u)}" alt="" referrerpolicy="no-referrer">`;
          return;
        }
      }
    })();
  }
}

// Posições definidas em scripts/build.py (carregar_sancoes)
function sancao([cadastro, categoria, inicio, fim, orgao, ufOrgao, processo, fundamentacao, codigo, transito]) {
  const data = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ""); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
  const dFim = data(fim);
  return { cadastro, categoria, inicio, fim, orgao, ufOrgao, processo, fundamentacao, codigo, transito,
    vigente: !dFim || dFim >= new Date() };
}

const NOMES_CADASTRO = {
  CEIS: "Cadastro de Empresas e Pessoas Inidôneas e Suspensas",
  CNEP: "Cadastro Nacional de Empresas Punidas",
  CEAF: "Cadastro de Expulsões da Administração Federal",
};

// Posições definidas em scripts/build.py (gerar)
function candidatura([ano, cargo, ue, partido, situacao, resultado, bens, eleicao, chapa, porTipo, ocupacao, coligacao, receita]) {
  const T = META.tabelas;
  const [uf, local] = T.ue[ue].split("|");
  const [sigla, nomePartido] = T.partido[partido].split("|");
  const res = T.resultado[resultado];
  return {
    ano, cargoCod: cargo, ueCod: ue, cargo: T.cargo[cargo], uf, local, sigla, nomePartido,
    situacao: T.situacao[situacao], resultado: res,
    eleito: /^ELEITO|^M[EÉ]DIA$/.test(res), bens, eleicao: T.eleicao[eleicao],
    // Companheiros de chapa: [pid, código do cargo, nome]
    chapa: (chapa || []).map(([pid, c, nome]) => ({ pid, cargo: T.cargo[c], nome })),
    porTipo: porTipo || null,
    ocupacao: T.ocupacao[ocupacao || 0],
    coligacao: coligacao || "",
    // Receitas de campanha (2018+): total, fundo eleitoral (FEFC), fundo partidário
    receita: receita ? { total: receita[0], fefc: receita[1], fp: receita[2], publico: receita[1] + receita[2] } : null,
  };
}

// ---------- Inflação e indicadores ----------

// Fator para trazer um valor declarado em outubro de `ano` para o mês mais recente do IPCA.
function fatorIpca(ano) {
  const ip = META.ipca;
  const base = ip && ip.outubro[String(ano)];
  return base ? ip.ref_indice / base : null;
}
const real = (v, ano) => (v == null ? null : v * (fatorIpca(ano) ?? 1));
const mesRef = () => {
  const m = META.ipca?.ref_mes;
  return m ? `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][+m.slice(4) - 1]}/${m.slice(0, 4)}` : "hoje";
};

// Situações que merecem destaque (indeferimento, cassação, renúncia...).
const PROBLEMA = /INDEFER|CASSA|RENUN|CANCEL|INAPTO|FALEC|IMPUGN|NAO CONHEC|INELEG/;
const temProblema = (c) => PROBLEMA.test(normaliza(c.situacao || "")) || PROBLEMA.test(normaliza(c.resultado || ""));

// Variação do patrimônio entre a eleição em que foi eleito(a) e a declaração seguinte
// feita durante aquele mandato (4 anos; 8 para senador), em valores corrigidos.
function variacoesNoMandato(p) {
  const out = [];
  p.cands.forEach((c, i) => {
    if (!c.eleito || !(c.bens > 0)) return;
    const dur = normaliza(c.cargo) === "SENADOR" ? 8 : 4;
    const prox = p.cands.slice(i + 1).find((d) => d.ano > c.ano && d.ano <= c.ano + dur && d.bens !== null);
    if (!prox) return;
    const v0 = real(c.bens, c.ano), v1 = real(prox.bens, prox.ano);
    out.push({ c, prox, v0, v1, pct: (v1 / v0 - 1) * 100 });
  });
  return out;
}

// Posição do patrimônio entre os eleitos do mesmo cargo no mesmo ano (percentil).
function comparacaoPares(p) {
  const c = [...p.cands].reverse().find((x) => x.eleito && x.bens !== null && META.percentis?.[`${x.ano}|${x.cargoCod}`]);
  if (!c) return null;
  const pct = META.percentis[`${c.ano}|${c.cargoCod}`];
  let n = 0;
  while (n < 100 && pct[n + 1] < c.bens) n++;
  return { c, pct: n };
}

function companheiros(p) {
  const m = new Map();
  for (const c of p.cands) for (const x of c.chapa) {
    const papel = TITULARES.has(normaliza(x.cargo)) ? "Titular" : cap(x.cargo);
    const e = m.get(x.pid) || { pid: x.pid, nome: x.nome, vezes: [] };
    e.vezes.push(`${c.ano} (${papel.toLowerCase()})`);
    m.set(x.pid, e);
  }
  return [...m.values()].sort((a, b) => b.vezes.length - a.vezes.length);
}

function resumo(p) {
  const anos = p.cands.map((c) => c.ano);
  const eleicoes = p.cands.filter((c) => c.eleito);
  const partidos = [];
  for (const c of p.cands) {
    const ult = partidos[partidos.length - 1];
    if (c.sigla && (!ult || ult.sigla !== c.sigla)) partidos.push({ sigla: c.sigla, nome: c.nomePartido, de: c.ano, ate: c.ano });
    else if (ult && ult.sigla === c.sigla) ult.ate = c.ano;
  }
  const ufs = [...new Set(p.cands.map((c) => c.uf).filter((u) => u && u !== "BR"))];
  return { de: Math.min(...anos), ate: Math.max(...anos), eleicoes, partidos, ufs };
}

// ---------- Espectro ideológico das legendas (Bolognesi, Ribeiro e Codato, 2023) ----------

const siglaNorm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
function regraPartido(sigla, ano) {
  const s = siglaNorm(sigla);
  return (META.espectro?.regras || []).find((r) => r[0] === s && ano >= r[1]) || null;
}
const faixaDe = (nota) => (META.espectro?.faixas || []).find(([lim]) => nota <= lim)?.[1] || "";
const fmtNota = (n) => n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

// Régua 0–10 com marcadores; `pontos` = [{nota, rotulo, principal?}]
function reguaEspectro(pontos) {
  const marcas = pontos.map((p) => `<span class="marca${p.principal ? " principal" : ""}" style="left:${(p.nota / 10) * 100}%"
      title="${esc(p.rotulo)}: ${fmtNota(p.nota)}">${p.principal ? `<b>${fmtNota(p.nota)}</b>` : `<i>${esc(p.rotulo)}</i>`}</span>`).join("");
  return `<div class="regua" role="img" aria-label="Escala de 0 (esquerda) a 10 (direita)">
    <div class="regua-faixas">${(META.espectro?.faixas || []).map(([lim, nome], i, arr) => {
      const ini = i ? arr[i - 1][0] : 0;
      return `<span style="width:${((lim - ini) / 10) * 100}%" title="${esc(nome)}">${esc(nome)}</span>`;
    }).join("")}</div>
    <div class="regua-trilho">${marcas}</div>
    <div class="regua-rotulos"><span>0 · esquerda</span><span>5</span><span>direita · 10</span></div>
  </div>`;
}

function citacaoEspectro() {
  const e = META.espectro || {};
  return `Classificação de <a href="${esc(e.doi)}" target="_blank" rel="noopener">Bolognesi, Ribeiro e Codato (2023)</a>, revista
    <em>Dados</em> — média das notas de 519 cientistas políticos em 2018, numa escala de 0 (esquerda) a 10 (direita), com as faixas
    definidas pelos autores. Legendas renomeadas herdam a nota do partido de origem; fusões recentes (ex.: União Brasil, PRD) e
    legendas antigas não avaliadas ficam sem classificação. A nota reflete a percepção de especialistas em 2018 e é aplicada a
    todas as eleições da legenda.`;
}

// Média das notas das legendas pelas quais a pessoa concorreu (null se nenhuma legenda classificada)
function espectroPessoa(p) {
  const cls = p.cands.map((c) => ({ c, r: regraPartido(c.sigla, c.ano) }));
  const com = cls.filter((x) => x.r);
  if (!com.length) return null;
  const media = com.reduce((s, x) => s + x.r[3], 0) / com.length;
  return { cls, com, media, faixa: faixaDe(media) };
}

function seloEspectro(p) {
  const e = espectroPessoa(p);
  if (!e) return "";
  return `<button type="button" class="selo espectro-selo" id="ir-espectro" title="Média das legendas pelas quais concorreu, segundo classificação acadêmica">
    <i style="left:${10 + e.media * 4}px"></i><span>Espectro das legendas: <b>${esc(e.faixa)}</b> (${fmtNota(e.media)})</span><u>ver análise</u></button>`;
}

function blocoEspectro(p) {
  const e = espectroPessoa(p);
  if (!e) return "";
  const { cls, com, media } = e;
  const porLegenda = new Map();
  for (const { c, r } of com) {
    const e = porLegenda.get(c.sigla) || { sigla: c.sigla, nota: r[3], n: 0 };
    e.n++; porLegenda.set(c.sigla, e);
  }
  const semClass = cls.length - com.length;
  return `<div class="bloco" id="espectro">
    <h3>Espectro das legendas</h3>
    <p class="espectro-resumo">Média das legendas pelas quais concorreu: <strong>${fmtNota(media)}</strong>
      — faixa <strong>${esc(faixaDe(media))}</strong> na classificação acadêmica de referência.</p>
    ${reguaEspectro([...[...porLegenda.values()].map((e) => ({ nota: e.nota, rotulo: e.sigla })), { nota: media, rotulo: "Média", principal: true }])}
    <div class="partidos espectro-legendas">${[...porLegenda.values()].sort((a, b) => a.nota - b.nota).map((e) =>
      `<span class="partido"><strong>${esc(e.sigla)}</strong> <small>${fmtNota(e.nota)} · ${esc(faixaDe(e.nota))} · ${e.n} candidatura${e.n > 1 ? "s" : ""}</small></span>`).join("")}</div>
    <p class="nota">Considera ${com.length} de ${cls.length} candidaturas${semClass ? ` (${semClass} por legendas sem classificação no estudo)` : ""}.
      Descreve apenas as legendas pelas quais a pessoa concorreu — não é uma avaliação das posições da pessoa. ${citacaoEspectro()}
      <a href="#partidos=1">Ver tabela de partidos</a>.</p>
  </div>`;
}

// ---------- Página de partidos ----------

async function mostrarPartidos() {
  mostrarInicio(false);
  $("#ficha").innerHTML = "";
  $("#resultados").innerHTML = "";
  setStatus("Carregando partidos…", { carregando: true });
  let dados;
  try { dados = await getJson("data/partidos.json"); } catch (e) { return setStatus("Não foi possível carregar a tabela de partidos.", { erro: true }); }
  setStatus("");
  const hist = new Map(dados.historico.map((h) => [siglaNorm(h.sigla), h]));
  const anoAtual = Math.max(...META.anos);
  const registrados = dados.tse.partidos.map((t) => ({ ...t, r: regraPartido(t.sigla, anoAtual), h: hist.get(siglaNorm(t.sigla)) }));
  const siglasTse = new Set(registrados.map((t) => siglaNorm(t.sigla)));
  const antigas = dados.historico.filter((h) => !siglasTse.has(siglaNorm(h.sigla)))
    .map((h) => ({ ...h, r: regraPartido(h.sigla, h.ultimo) }))
    .sort((a, b) => b.ultimo - a.ultimo || a.sigla.localeCompare(b.sigla));
  const ordem = (a, b) => (a.r ? a.r[3] : 99) - (b.r ? b.r[3] : 99) || a.sigla.localeCompare(b.sigla);
  const mini = (r) => r ? `<div class="mini-regua" title="${fmtNota(r[3])}"><i style="left:${r[3] * 10}%"></i></div>` : "";
  const classe = (r) => r ? `<strong>${fmtNota(r[3])}</strong> · ${esc(faixaDe(r[3]))}${r[4] ? `<div class="muted">${esc(r[4])}</div>` : ""}`
    : `<span class="muted">Sem classificação no estudo</span>`;
  const n = (x) => (x || 0).toLocaleString("pt-BR");

  $("#partidos").innerHTML = `
    <button class="voltar" id="voltar-p">← voltar</button>
    <div class="bloco">
      <h3>Partidos registrados no TSE (${registrados.length})</h3>
      ${reguaEspectro(registrados.filter((t) => t.r).map((t) => ({ nota: t.r[3], rotulo: t.sigla })))}
      <div class="tabela-wrap"><table class="tabela-partidos">
        <thead><tr><th>Nº</th><th>Sigla</th><th>Nome</th><th>Registro</th><th>Site oficial</th><th>Espectro</th><th></th>
          <th class="num">Candidaturas</th><th class="num">Eleitos</th></tr></thead>
        <tbody>${registrados.sort(ordem).map((t) => `<tr>
          <td>${esc(t.numero)}</td><td><strong>${esc(t.sigla)}</strong></td><td>${esc(t.nome)}</td><td>${esc(t.deferimento)}</td>
          <td>${t.site ? `<a href="${esc(t.site)}" target="_blank" rel="noopener">${esc(t.site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>` : `<span class="muted">—</span>`}</td>
          <td class="espectro-cel">${classe(t.r)}</td><td>${mini(t.r)}</td>
          <td class="num">${n(t.h?.candidaturas)}</td><td class="num">${n(t.h?.eleitos)}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="nota">Fonte: ${esc(dados.tse.fonte)}. ${esc(dados.tse.observacao || "")} Candidaturas e eleitos: dados do TSE de 1994 a 2026 nesta base,
        pela sigla atual.</p>
    </div>
    <div class="bloco">
      <h3>Legendas extintas, renomeadas ou incorporadas (${antigas.length})</h3>
      <div class="tabela-wrap"><table class="tabela-partidos">
        <thead><tr><th>Sigla</th><th>Nome</th><th>Período nos dados</th><th>Espectro</th><th></th><th class="num">Candidaturas</th><th class="num">Eleitos</th></tr></thead>
        <tbody>${antigas.map((h) => `<tr><td><strong>${esc(h.sigla)}</strong></td><td>${esc(cap(h.nome))}</td>
          <td>${h.primeiro === h.ultimo ? h.primeiro : `${h.primeiro}–${h.ultimo}`}</td><td class="espectro-cel">${classe(h.r)}</td><td>${mini(h.r)}</td>
          <td class="num">${n(h.candidaturas)}</td><td class="num">${n(h.eleitos)}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="bloco"><h3>Metodologia da classificação ideológica</h3><p class="nota" style="font-size:.92rem">${citacaoEspectro()}
      Faixas: ${(META.espectro?.faixas || []).map(([lim, nome], i, arr) => `${nome} (${i ? fmtNota(arr[i - 1][0]) : "0"}–${fmtNota(lim)})`).join("; ")}.
      A classificação é de responsabilidade dos autores do estudo citado e é apresentada apenas como referência.</p></div>`;
  $("#voltar-p").onclick = () => history.back();
  window.scrollTo({ top: $(".conteudo").offsetTop - 8 });
}

// ---------- Utilidades de apresentação ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MINUSCULAS = new Set(["da", "de", "do", "das", "dos", "e", "em", "por", "a", "o"]);
const cap = (s) => (s || "").toLowerCase()
  .replace(/(^|[\s(/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/(?<=\s)(\p{L}+)/gu, (w) => (MINUSCULAS.has(w.toLowerCase()) ? w.toLowerCase() : w))
  .replace(/\bQp\b/g, "QP");

function iniciais(nome) {
  const t = tokens(normaliza(nome));
  return ((t[0] || "?")[0] + (t.length > 1 ? t[t.length - 1][0] : "")).toUpperCase();
}

function corPartido(sigla) {
  const h = fnv1a(normaliza(sigla || "?")) % 360;
  return `hsl(${h} 55% 45%)`;
}

function localTexto(c) {
  if (c.uf === "BR") return "Brasil";
  const l = cap(c.local);
  return c.local && c.uf && normaliza(c.local) !== normaliza(c.uf) ? `${l}/${c.uf}` : l;
}

const linkPessoa = (pid, nome) => `#${new URLSearchParams({ q: nome, p: pid })}`;

function setStatus(msg, { erro = false, carregando = false } = {}) {
  const el = $("#status");
  el.classList.toggle("erro", erro);
  el.innerHTML = (carregando ? `<span class="spinner" aria-hidden="true"></span>` : "") + esc(msg);
}

function contar(el, alvo) {
  if (semAnimacao) { el.textContent = alvo.toLocaleString("pt-BR"); return; }
  const t0 = performance.now(), dur = 1100;
  const passo = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(alvo * (1 - Math.pow(1 - k, 3))).toLocaleString("pt-BR");
    if (k < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

function mostrarInicio(visivel) {
  $("#inicio").hidden = !visivel;
}

// ---------- Filtros (estado, ano, cargo, município, eleitos) ----------

const UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR",
  "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"];
const POR_PAGINA = 50;
const LIMITE_FILTRO_NOME = 300; // sem ano+UF, o filtro por nome examina os N resultados mais relevantes

// Cargo exibido no filtro -> códigos da tabela (junta "1º SUPLENTE" e "1º SUPLENTE SENADOR").
let CARGOS = null; // Map chave -> { rotulo, codigos:Set }
function cargosFiltro() {
  if (CARGOS) return CARGOS;
  CARGOS = new Map();
  META.tabelas.cargo.forEach((nome, cod) => {
    if (!nome) return;
    const n = normaliza(nome);
    const chave = n.includes("SUPLENTE") ? (nome.trim().startsWith("2") ? "2 SUPLENTE" : "1 SUPLENTE") : n;
    const rotulo = chave === "1 SUPLENTE" ? "1º Suplente de senador" : chave === "2 SUPLENTE" ? "2º Suplente de senador" : cap(nome);
    if (!CARGOS.has(chave)) CARGOS.set(chave, { rotulo, codigos: new Set() });
    CARGOS.get(chave).codigos.add(cod);
  });
  return CARGOS;
}
const ORDEM_CARGOS = ["PRESIDENTE", "VICE PRESIDENTE", "GOVERNADOR", "VICE GOVERNADOR", "SENADOR", "1 SUPLENTE", "2 SUPLENTE",
  "DEPUTADO FEDERAL", "DEPUTADO ESTADUAL", "DEPUTADO DISTRITAL", "PREFEITO", "VICE PREFEITO", "VEREADOR"];

const eleitoRes = (codRes) => /^ELEITO|^M[EÉ]DIA$/.test(META.tabelas.resultado[codRes] || "");

const temFiltro = (f) => !!(f.uf || f.ano || f.cargo || f.mun || f.eleitos);
const chaveDoCargo = (cod) => [...cargosFiltro()].find(([, v]) => v.codigos.has(+cod))?.[0] || "";
const NOMES_UF = { AC: "Acre", AL: "Alagoas", AM: "Amazonas", AP: "Amapá", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MG: "Minas Gerais", MS: "Mato Grosso do Sul", MT: "Mato Grosso", PA: "Pará",
  PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", PR: "Paraná", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RO: "Rondônia",
  RR: "Roraima", RS: "Rio Grande do Sul", SC: "Santa Catarina", SE: "Sergipe", SP: "São Paulo", TO: "Tocantins", BR: "Brasil" };
const hashExplorar = (f, extra = {}) => "explorar=1" + (hashConsulta("", f, extra) ? "&" + hashConsulta("", f, extra) : "");

// ---------- Explorar pelo mapa: estado → ano → cargo → candidatos ----------

async function mostrarExplorar(f, pg) {
  mostrarInicio(false);
  $("#ficha").innerHTML = "";
  $("#partidos").innerHTML = "";
  $("#resultados").innerHTML = "";
  $("#resultados").hidden = false;
  setStatus("");
  const passos = [{ rot: "Brasil", f: {} }];
  if (f.uf) passos.push({ rot: NOMES_UF[f.uf] || f.uf, f: { uf: f.uf } });
  if (f.ano) passos.push({ rot: f.ano, f: { uf: f.uf, ano: f.ano } });
  if (f.cargo) passos.push({ rot: cargosFiltro().get(f.cargo)?.rotulo || f.cargo, f: { uf: f.uf, ano: f.ano, cargo: f.cargo } });
  const trilha = `<nav class="trilha" aria-label="Etapas">${passos.map((s, i) => i === passos.length - 1
    ? `<span aria-current="page">${esc(s.rot)}</span>` : `<a href="#${hashExplorar(s.f)}">${esc(s.rot)}</a>`).join('<span class="sep">›</span>')}</nav>`;
  const etapa = !f.uf ? 1 : !f.ano ? 2 : !f.cargo ? 3 : 4;
  const titulos = ["Escolha um estado", "Escolha o ano da eleição", "Escolha o cargo", "Candidatos"];
  const el = $("#explorar");
  el.innerHTML = `<div class="bloco explorar">
    <div class="explorar-topo">${trilha}<span class="etapa">Etapa ${etapa} de 4 · ${titulos[etapa - 1]}</span></div>
    <div id="explorar-corpo"><div class="status"><span class="spinner"></span> Carregando…</div></div></div>`;
  const corpo = $("#explorar-corpo");
  try {
    if (etapa === 1) corpo.innerHTML = await etapaMapa();
    else if (etapa === 2) corpo.innerHTML = etapaAnos(f.uf);
    else if (etapa === 3) corpo.innerHTML = await etapaCargos(f);
    else {
      corpo.innerHTML = await etapaFiltrosLista(f);
      ligarFiltrosLista(f);
      await listarPorFiltro(f, pg);
    }
    if (etapa === 1) rotularMapa();
  } catch (e) {
    console.error(e);
    corpo.innerHTML = `<p class="muted">Não foi possível carregar esta etapa. Tente novamente.</p>`;
  }
  if (etapa < 4) window.scrollTo({ top: $(".conteudo").offsetTop - 8, behavior: semAnimacao ? "auto" : "smooth" });
}

// Mapa clicável; `link(uf)` monta o destino de cada estado. `extra` = HTML adicional na lateral.
async function etapaMapa(link = (uf) => hashExplorar({ uf }), extra = null) {
  const mapa = await getJson("assets/mapa-brasil.json");
  const estados = mapa.locations.map((l) => ({ ...l, uf: l.id.toUpperCase() }));
  const lado = extra ?? `<a class="card-opcao destaque" href="#${hashExplorar({ uf: "BR" })}">
        <strong>Brasil</strong><span>Presidente e vice-presidente da República</span></a>`;
  return `<div class="mapa-wrap">
    <svg class="mapa" viewBox="${mapa.viewBox}" role="img" aria-label="Mapa do Brasil — clique em um estado">
      ${estados.map((e) => `<a href="#${link(e.uf)}" aria-label="${esc(e.name)}">
        <path d="${e.path}" data-uf="${e.uf}"><title>${esc(e.name)}</title></path></a>`).join("")}
      <g class="mapa-rotulos"></g>
    </svg>
    <div class="mapa-lado">
      <p class="muted">Clique em um estado no mapa ou escolha abaixo.</p>
      <div class="chips-uf">${UFS.map((u) => `<a class="chip" href="#${link(u)}" title="${esc(NOMES_UF[u])}">${u}</a>`).join("")}</div>
      ${lado}
    </div>
  </div>`;
}

// ---------- Colinha (volante) para o dia da eleição ----------

// Ordem de votação na urna (eleições gerais). Senador tem duas vagas em 2026.
const VAGAS_COLINHA = [
  { id: "DF", cargo: "DEPUTADO FEDERAL", rot: "Deputado(a) federal", dig: 4, legenda: true },
  { id: "DE", cargo: "DEPUTADO ESTADUAL", rot: "Deputado(a) estadual", dig: 5, legenda: true },
  { id: "DD", cargo: "DEPUTADO DISTRITAL", rot: "Deputado(a) distrital", dig: 5, legenda: true },
  { id: "S1", cargo: "SENADOR", rot: "Senador(a) — 1º voto", dig: 3 },
  { id: "S2", cargo: "SENADOR", rot: "Senador(a) — 2º voto", dig: 3 },
  { id: "GV", cargo: "GOVERNADOR", rot: "Governador(a)", dig: 2 },
  { id: "PR", cargo: "PRESIDENTE", rot: "Presidente da República", dig: 2 },
];
const DATA_ELEICAO = "4 de outubro de 2026 (1º turno)";

// Filtro da colinha por espectro da legenda: as 7 faixas do estudo agrupadas em 5 (+ "sem classificação").
const GRUPOS_ESPECTRO = ["Esquerda", "Centro-esquerda", "Centro", "Centro-direita", "Direita", "Sem classificação"];
function grupoEspectro(sigla, ano) {
  const r = regraPartido(sigla, ano);
  if (!r) return "Sem classificação";
  const f = faixaDe(r[3]);
  return f === "Extrema-esquerda" ? "Esquerda" : f === "Extrema-direita" ? "Direita" : f;
}
let filtroEspectro = new Set(GRUPOS_ESPECTRO); // todos marcados por padrão

function barraEspectro() {
  return `<div class="bloco filtro-espectro">
    <h3>Filtrar pelo espectro do partido</h3>
    <div class="chips-espectro" role="group" aria-label="Espectro do partido">
      ${GRUPOS_ESPECTRO.map((g, i) => `<button type="button" class="chip-esp esp-${i}" data-grupo="${esc(g)}" aria-pressed="${filtroEspectro.has(g)}">${esc(g)}</button>`).join("")}
      <button type="button" class="chip-esp-todos" data-grupo="*">Todos</button>
    </div>
    <p class="nota">Marque um ou mais grupos. A classificação é do <strong>partido</strong> (não da pessoa), segundo
      <a href="#partidos=1">Bolognesi, Ribeiro e Codato (2023)</a>; “Esquerda” inclui a extrema-esquerda e “Direita” inclui a
      extrema-direita. Partidos não avaliados no estudo (ex.: União Brasil, PRD, Missão) estão em “Sem classificação”.</p>
  </div>`;
}

// Aplica busca por texto (por vaga) + filtro de espectro (global) às listas da colinha
function aplicarFiltrosColinha() {
  document.querySelectorAll(".chip-esp").forEach((b) => b.setAttribute("aria-pressed", filtroEspectro.has(b.dataset.grupo)));
  document.querySelectorAll(".vaga").forEach((sec) => {
    const inp = sec.querySelector("[data-busca-vaga]");
    const txt = inp?.value.trim() || "";
    const q = normaliza(txt), dig = txt.replace(/\D/g, "");
    let visiveis = 0;
    sec.querySelectorAll(".cand").forEach((li) => {
      const t = li.dataset.busca;
      const okTxt = !txt || (q && t.includes(q)) || (dig && t.split(" ").some((x) => x.startsWith(dig)));
      const okEsp = filtroEspectro.has(li.dataset.grupo) || li.classList.contains("sel");
      li.hidden = !(okTxt && okEsp);
      if (!li.hidden) visiveis++;
    });
    sec.querySelectorAll("[data-legenda] option[data-grupo]").forEach((o) => { o.hidden = !filtroEspectro.has(o.dataset.grupo); });
    const vazio = sec.querySelector(".lista-vazia");
    if (vazio) vazio.hidden = visiveis > 0;
  });
}

const chaveColinha = (uf) => `colinha_${META.colinha?.ano}_${uf}`;
function lerEscolhas(uf) { try { return JSON.parse(localStorage.getItem(chaveColinha(uf)) || "{}"); } catch { return {}; } }
function salvarEscolhas(uf, e) { try { localStorage.setItem(chaveColinha(uf), JSON.stringify(e)); } catch { /* navegação privada */ } }

async function dadosColinha(uf) {
  const ano = META.colinha.ano;
  const [est, br] = await Promise.all([getJson(`data/colinha/${ano}_${uf}.json`),
    META.colinha.ufs.includes("BR") ? getJson(`data/colinha/${ano}_BR.json`) : Promise.resolve({ cargos: {} })]);
  return { ...est, cargos: { ...est.cargos, PRESIDENTE: br.cargos.PRESIDENTE || [] } };
}

async function mostrarColinha(uf, imprimir) {
  mostrarInicio(false);
  for (const s of ["#ficha", "#partidos", "#resultados", "#explorar"]) $(s).innerHTML = "";
  setStatus("");
  const el = $("#explorar");
  el.hidden = false;
  if (!META.colinha) { el.innerHTML = `<div class="bloco"><p class="muted">A colinha ainda não está disponível.</p></div>`; return; }
  const topo = (etapa) => `<div class="explorar-topo"><nav class="trilha"><a href="#colinha=1">Colinha</a>${uf ? `<span class="sep">›</span>${imprimir
    ? `<a href="#colinha=1&uf=${uf}">${esc(NOMES_UF[uf])}</a><span class="sep">›</span><span aria-current="page">Imprimir</span>`
    : `<span aria-current="page">${esc(NOMES_UF[uf])}</span>`}` : ""}</nav><span class="etapa">${etapa}</span></div>`;

  if (!uf) {
    el.innerHTML = `<div class="bloco explorar colinha-intro">${topo("Etapa 1 de 3 · Escolha o seu estado")}
      <p>Monte a sua <strong>colinha</strong> para o dia da eleição (${DATA_ELEICAO}): escolha seus candidatos e imprima uma
        folha com os números, na ordem em que você vai votar na urna. Suas escolhas ficam só neste navegador.</p>
      <div id="explorar-corpo"></div></div>`;
    $("#explorar-corpo").innerHTML = await etapaMapa((u) => `colinha=1&uf=${u}`, `<p class="nota">O voto para Presidente é o mesmo em todo o país e aparece junto com os cargos do seu estado.</p>`);
    rotularMapa();
    return;
  }
  el.innerHTML = `<div class="bloco"><div class="status"><span class="spinner"></span> Carregando candidatos…</div></div>`;
  let dados;
  try { dados = await dadosColinha(uf); } catch (e) {
    el.innerHTML = `<div class="bloco"><p class="muted">Não há dados de candidatos para ${esc(NOMES_UF[uf] || uf)}.</p></div>`; return;
  }
  const vagas = VAGAS_COLINHA.filter((v) => (dados.cargos[v.cargo] || []).length);
  const escolhas = lerEscolhas(uf);
  if (imprimir) return renderImpressao(el, topo, uf, vagas, escolhas, dados);

  el.innerHTML = `<div class="bloco explorar">${topo("Etapa 2 de 3 · Escolha seus candidatos")}
    <p class="muted">Candidatos que estão na urna, em ordem alfabética. Toque em um nome para escolher; toque de novo para desfazer.
      Dados do TSE de ${esc(dados.data_tse || "—")}.</p></div>
    ${barraEspectro()}
    ${vagas.map((v) => secaoVaga(v, dados, escolhas)).join("")}
    <div class="barra-colinha"><span id="colinha-contador"></span>
      <a class="botao-primario" href="#colinha=1&uf=${uf}&imprimir=1">Ver e imprimir minha colinha →</a></div>`;
  ligarColinha(uf, vagas, dados);
  window.scrollTo({ top: $(".conteudo").offsetTop - 8 });
}

function secaoVaga(v, dados, escolhas) {
  const lista = dados.cargos[v.cargo] || [];
  const esc0 = escolhas[v.id];
  const linhas = lista.map((c, k) => {
    const [nr, nome, sigla, , pid, sq, ue, alerta, comp] = c;
    const grave = alerta && !/^DEFERIDO/.test(normaliza(alerta));
    const sel = esc0?.tipo === "cand" && esc0.nr === nr;
    const grupo = grupoEspectro(sigla, dados.ano);
    return `<li class="cand${sel ? " sel" : ""}" data-vaga="${v.id}" data-k="${k}" data-grupo="${esc(grupo)}" data-busca="${esc(normaliza(nome) + " " + nr + " " + normaliza(sigla))}" tabindex="0" role="button" aria-pressed="${sel}">
      <img loading="lazy" referrerpolicy="no-referrer" alt="" src="${FOTO_BASE}/${META.fotos_eleicoes[META.fotos_eleicoes.length - 1]}/${esc(sq)}/${esc(ue)}">
      <span class="cand-info"><strong>${esc(nome)}</strong><small>${esc(sigla)} <span class="tag-esp esp-${GRUPOS_ESPECTRO.indexOf(grupo)}">${esc(grupo)}</span>${comp ? ` · ${esc(comp)}` : ""}</small>
        ${alerta ? `<em class="${grave ? "grave" : "leve"}">${esc(cap(alerta))}${grave ? " — voto pode ser anulado" : ""}</em>` : ""}</span>
      <span class="cand-num">${esc(nr)}</span>
      <a class="cand-ficha" href="#${new URLSearchParams({ q: nome, p: pid })}" title="Ver ficha">ficha</a>
    </li>`;
  }).join("");
  const legenda = v.legenda ? `<label class="legenda-sel">ou votar só no partido (legenda):
      <select data-legenda="${v.id}"><option value="">—</option>${(dados.partidos || []).map(([n, s]) =>
        `<option value="${esc(n)}|${esc(s)}" data-grupo="${esc(grupoEspectro(s, dados.ano))}" ${esc0?.tipo === "legenda" && esc0.nr === n ? "selected" : ""}>${esc(n)} · ${esc(s)}</option>`).join("")}</select></label>` : "";
  return `<section class="bloco vaga" id="vaga-${v.id}">
    <div class="vaga-topo"><h3>${esc(v.rot)} <small>${v.dig} dígitos · ${lista.length} candidatos</small></h3>
      <span class="vaga-escolha" id="escolha-${v.id}"></span></div>
    <div class="vaga-ctrl"><input type="search" placeholder="Buscar por nome, número ou partido" data-busca-vaga="${v.id}" aria-label="Buscar em ${esc(v.rot)}">
      ${legenda}<button type="button" class="branco" data-branco="${v.id}">Em branco</button></div>
    <ul class="lista-cand">${linhas}</ul>
    <p class="muted lista-vazia" hidden>Nenhum candidato com os filtros escolhidos.</p>
  </section>`;
}

function textoEscolha(e) {
  if (!e) return `<span class="muted">nenhuma escolha</span>`;
  if (e.tipo === "branco") return "<b>Em branco</b>";
  if (e.tipo === "legenda") return `<b>${esc(e.nr)}</b> · legenda ${esc(e.sigla)}`;
  return `<b>${esc(e.nr)}</b> · ${esc(e.nome)} (${esc(e.sigla)})`;
}

function ligarColinha(uf, vagas, dados) {
  const escolhas = lerEscolhas(uf);
  const atualizar = () => {
    salvarEscolhas(uf, escolhas);
    let n = 0;
    for (const v of vagas) {
      const e = escolhas[v.id];
      if (e) n++;
      $(`#escolha-${v.id}`).innerHTML = textoEscolha(e);
      // No 2º voto para senador não dá para repetir o candidato do 1º (e vice-versa)
      const outro = v.id === "S1" ? escolhas.S2 : v.id === "S2" ? escolhas.S1 : null;
      for (const li of document.querySelectorAll(`#vaga-${v.id} .cand`)) {
        const c = (dados.cargos[v.cargo] || [])[+li.dataset.k];
        const sel = e?.tipo === "cand" && e.nr === c[0];
        li.classList.toggle("sel", sel);
        li.setAttribute("aria-pressed", sel);
        li.classList.toggle("bloqueado", !!(outro?.tipo === "cand" && outro.nr === c[0]));
      }
      const sel = document.querySelector(`[data-legenda="${v.id}"]`);
      if (sel) sel.value = e?.tipo === "legenda" ? `${e.nr}|${e.sigla}` : "";
    }
    $("#colinha-contador").textContent = `${n} de ${vagas.length} escolhas feitas`;
    aplicarFiltrosColinha();
  };
  const escolher = (li) => {
    if (li.classList.contains("bloqueado")) return;
    const v = vagas.find((x) => x.id === li.dataset.vaga);
    const [nr, nome, sigla] = (dados.cargos[v.cargo] || [])[+li.dataset.k];
    const atual = escolhas[v.id];
    if (atual?.tipo === "cand" && atual.nr === nr) delete escolhas[v.id];
    else escolhas[v.id] = { tipo: "cand", nr, nome, sigla };
    atualizar();
  };
  const raiz = $("#explorar");
  raiz.onclick = (ev) => {
    if (ev.target.closest(".cand-ficha")) return; // o link da ficha segue normalmente
    const chip = ev.target.closest("[data-grupo]:is(.chip-esp, .chip-esp-todos)");
    if (chip) {
      const g = chip.dataset.grupo;
      if (g === "*") filtroEspectro = new Set(GRUPOS_ESPECTRO);
      else if (filtroEspectro.size === GRUPOS_ESPECTRO.length) filtroEspectro = new Set([g]); // 1º clique: mostra só este grupo
      else if (filtroEspectro.has(g)) { filtroEspectro.delete(g); if (!filtroEspectro.size) filtroEspectro = new Set(GRUPOS_ESPECTRO); }
      else filtroEspectro.add(g);
      return aplicarFiltrosColinha();
    }
    const li = ev.target.closest(".cand");
    if (li) return escolher(li);
    const b = ev.target.closest("[data-branco]");
    if (b) { escolhas[b.dataset.branco] = { tipo: "branco" }; atualizar(); }
  };
  raiz.onkeydown = (ev) => {
    const li = ev.target.closest?.(".cand");
    if (li && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); escolher(li); }
  };
  raiz.onchange = (ev) => {
    const s = ev.target.closest("[data-legenda]");
    if (!s) return;
    if (s.value) { const [nr, sigla] = s.value.split("|"); escolhas[s.dataset.legenda] = { tipo: "legenda", nr, sigla }; }
    else delete escolhas[s.dataset.legenda];
    atualizar();
  };
  raiz.oninput = (ev) => { if (ev.target.closest("[data-busca-vaga]")) aplicarFiltrosColinha(); };
  atualizar();
  aplicarFiltrosColinha();
}

function renderImpressao(el, topo, uf, vagas, escolhas, dados) {
  const digitos = (nr, n) => `<span class="digitos">${String(nr || "").padStart(n, " ").split("").map((d) => `<i>${d.trim() ? esc(d) : "&nbsp;"}</i>`).join("")}</span>`;
  const linhas = vagas.map((v) => {
    const e = escolhas[v.id];
    const nr = e?.tipo === "cand" || e?.tipo === "legenda" ? e.nr : "";
    const desc = !e ? `<span class="vazio">(não escolhido)</span>` : e.tipo === "branco" ? "<b>BRANCO</b> — aperte a tecla BRANCO"
      : e.tipo === "legenda" ? `Voto na legenda <b>${esc(e.sigla)}</b>` : `<b>${esc(e.nome)}</b> · ${esc(e.sigla)}`;
    return `<tr><td class="c-cargo">${esc(v.rot)}</td><td>${digitos(nr, e?.tipo === "legenda" ? 2 : v.dig)}</td><td class="c-desc">${desc}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="bloco nao-imprimir">${topo("Etapa 3 de 3 · Confira e imprima")}
      <p class="muted">Confira os números. Use “Imprimir” (ou salvar como PDF) e leve a folha no dia da eleição.</p>
      <div class="acoes"><button type="button" class="botao-primario" id="btn-imprimir">🖨️ Imprimir colinha</button>
        <a class="botao-sec" href="#colinha=1&uf=${uf}">← Alterar escolhas</a></div></div>
    <div id="colinha-imprimir" class="colinha-folha">
      <div class="colinha-cab"><strong>MINHA COLINHA</strong><span>Eleições ${META.colinha.ano} · ${esc(NOMES_UF[uf] || uf)} · ${DATA_ELEICAO}</span></div>
      <p class="colinha-ordem">Vote nesta ordem, digitando o número e apertando <b>CONFIRMA</b>:</p>
      <table class="colinha-tab"><tbody>${linhas}</tbody></table>
      <ul class="colinha-avisos">
        <li>Leve esta folha impressa: <b>celular e outros aparelhos não podem entrar na cabine de votação</b>.</li>
        <li>Leve um documento oficial com foto (ou o e-Título). Números conforme dados do TSE de ${esc(dados.data_tse || "—")} — confira antes de votar.</li>
      </ul>
      <div class="colinha-rodape">Gerado em lentepublica.com.br · Ferramenta informativa e neutra: todos os candidatos na urna são exibidos da mesma forma.</div>
    </div>`;
  $("#btn-imprimir").onclick = () => window.print();
  window.scrollTo({ top: $(".conteudo").offsetTop - 8 });
}

// Siglas no centro de cada estado (calculado depois que o SVG está na página)
function rotularMapa() {
  const g = document.querySelector(".mapa-rotulos");
  if (!g) return;
  const pequenos = new Set(["DF", "SE", "AL", "RN", "PB", "ES", "RJ"]);
  g.innerHTML = [...document.querySelectorAll(".mapa path")].map((p) => {
    const b = p.getBBox();
    const uf = p.dataset.uf;
    return `<text x="${b.x + b.width / 2}" y="${b.y + b.height / 2}" class="${pequenos.has(uf) ? "peq" : ""}">${uf}</text>`;
  }).join("");
}

function etapaAnos(uf) {
  const anos = [...META.anos].reverse().filter((a) => (META.listas[a] || []).includes(uf));
  if (!anos.length) return `<p class="muted">Não há eleições disponíveis para ${esc(NOMES_UF[uf] || uf)}.</p>`;
  return `<div class="grade-opcoes">${anos.map((a) => `<a class="card-opcao" href="#${hashExplorar({ uf, ano: String(a) })}">
      <strong>${a}</strong><span>${a % 4 === 0 ? "Eleições municipais" : "Eleições gerais"}${a === Math.max(...META.anos) ? " · dados preliminares" : ""}</span></a>`).join("")}</div>`;
}

async function etapaCargos(f) {
  const lista = await getJson(`data/lista/${f.ano}_${f.uf}.json`);
  const porChave = new Map();
  for (const [cod, itens] of Object.entries(lista)) {
    const k = chaveDoCargo(cod);
    if (!k) continue;
    const e = porChave.get(k) || { total: 0, eleitos: 0 };
    e.total += itens.length;
    e.eleitos += itens.filter((x) => eleitoRes(x[3])).length;
    porChave.set(k, e);
  }
  const chaves = [...porChave.keys()].sort((a, b) => (ORDEM_CARGOS.indexOf(a) + 1 || 99) - (ORDEM_CARGOS.indexOf(b) + 1 || 99));
  const n = (x) => x.toLocaleString("pt-BR");
  return `<div class="grade-opcoes">${chaves.map((k) => {
    const e = porChave.get(k);
    return `<a class="card-opcao" href="#${hashExplorar({ uf: f.uf, ano: f.ano, cargo: k })}">
      <strong>${esc(cargosFiltro().get(k).rotulo)}</strong><span>${n(e.total)} candidatura${e.total > 1 ? "s" : ""}${e.eleitos ? ` · ${n(e.eleitos)} eleito${e.eleitos > 1 ? "s" : ""}` : ""}</span></a>`;
  }).join("")}</div>`;
}

const CARGOS_MUNICIPAIS = new Set(["PREFEITO", "VICE PREFEITO", "VEREADOR"]);

// Controles da lista: município (cargos municipais) e "somente eleitos"
async function etapaFiltrosLista(f) {
  let mun = "";
  if (CARGOS_MUNICIPAIS.has(f.cargo)) {
    const lista = await getJson(`data/lista/${f.ano}_${f.uf}.json`);
    const cods = cargosFiltro().get(f.cargo)?.codigos || new Set();
    const ues = new Set();
    for (const [cod, itens] of Object.entries(lista)) if (cods.has(+cod)) for (const x of itens) ues.add(x[1]);
    const porNome = new Map(); // o TSE às vezes grava o mesmo município com grafias diferentes
    for (const u of ues) {
      const nome = (META.tabelas.ue[u] || "").split("|")[1] || "";
      const k = normaliza(nome);
      if (!porNome.has(k)) porNome.set(k, { nome, cods: [] });
      porNome.get(k).cods.push(u);
    }
    const ord = [...porNome.values()].sort((a, b) => normaliza(a.nome).localeCompare(normaliza(b.nome)));
    mun = `<label class="campo-lista">Município
      <select id="x-mun"><option value="">Todos os municípios (${ord.length})</option>
      ${ord.map((m) => `<option value="${m.cods.join(",")}" ${m.cods.join(",") === f.mun ? "selected" : ""}>${esc(cap(m.nome))}</option>`).join("")}</select></label>`;
  }
  return `<div class="filtros-lista">${mun}
    <label class="check"><input type="checkbox" id="x-eleitos" ${f.eleitos ? "checked" : ""}> Somente eleitos</label></div>`;
}

function ligarFiltrosLista(f) {
  const atualizar = () => {
    const nf = { ...f, mun: $("#x-mun")?.value || "", eleitos: $("#x-eleitos").checked ? "1" : "" };
    location.hash = hashExplorar(nf);
  };
  $("#x-mun")?.addEventListener("change", atualizar);
  $("#x-eleitos").addEventListener("change", atualizar);
}

// Candidaturas (de um ano/UF) que atendem aos filtros: [{pid, cargo, ue, partido, resultado}]
async function candidaturasFiltradas(f) {
  const ufs = f.uf ? [f.uf] : (META.listas[f.ano] || []);
  const cods = f.cargo ? cargosFiltro().get(f.cargo)?.codigos : null;
  const muns = f.mun ? new Set(f.mun.split(",").map(Number)) : null;
  const out = [];
  for (const uf of ufs) {
    if (!(META.listas[f.ano] || []).includes(uf)) continue;
    const lista = await getJson(`data/lista/${f.ano}_${uf}.json`);
    for (const [cargo, itens] of Object.entries(lista)) {
      if (cods && !cods.has(+cargo)) continue;
      for (const [pid, ue, partido, resultado] of itens) {
        if (muns && !muns.has(ue)) continue;
        if (f.eleitos && !eleitoRes(resultado)) continue;
        out.push({ pid, cargo: +cargo, ue, partido, resultado });
      }
    }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// A candidatura de uma pessoa atende aos filtros? (usado quando não há ano+UF para usar os índices)
function candidaturaAtende(c, f) {
  if (f.ano && String(c.ano) !== f.ano) return false;
  if (f.uf && (c.uf || "BR") !== f.uf) return false;
  if (f.cargo && !cargosFiltro().get(f.cargo)?.codigos.has(c.cargoCod)) return false;
  if (f.mun && !f.mun.split(",").map(Number).includes(c.ueCod)) return false;
  if (f.eleitos && !c.eleito) return false;
  return true;
}

function descreverFiltros(f) {
  const partes = [];
  if (f.cargo) partes.push(cargosFiltro().get(f.cargo)?.rotulo);
  if (f.eleitos) partes.push("eleitos");
  if (f.mun) partes.push(cap(META.tabelas.ue[+f.mun.split(",")[0]]?.split("|")[1] || ""));
  if (f.uf) partes.push(f.uf === "BR" ? "Brasil" : f.uf);
  if (f.ano) partes.push(f.ano);
  return partes.filter(Boolean).join(" · ");
}

// ---------- Consulta ----------

async function consultar(q, f, pg = 1) {
  mostrarInicio(false);
  $("#ficha").innerHTML = "";
  $("#partidos").innerHTML = "";
  $("#resultados").innerHTML = "";
  $("#resultados").hidden = false;
  $("#explorar").innerHTML = "";
  $("#q").value = q;
  const tk = tokens(normaliza(q));
  if (!tk.length && !temFiltro(f)) return setStatus("Digite um nome ou escolha filtros para consultar.");
  setStatus("Consultando…", { carregando: true });
  try {
    if (tk.length) return await consultarPorNome(q, tk, f);
    return await listarPorFiltro(f, pg);
  } catch (e) {
    console.error(e);
    setStatus("Não foi possível carregar os dados. Tente novamente.", { erro: true });
  }
}

async function consultarPorNome(q, tk, f) {
  const r = await localizar(tk);
  if (r.muitos) {
    return setStatus(temFiltro(f) && f.ano
      ? "Nome muito comum para combinar com filtros. Digite o nome mais completo ou consulte só pelos filtros (sem nome)."
      : "Muitas pessoas com esse nome. Digite o nome mais completo (ex.: nome + sobrenomes).", { erro: true });
  }
  let ids = r.ids;
  let aviso = "";
  if (temFiltro(f)) {
    if (f.ano && (f.uf || META.listas[f.ano]?.length)) {
      const permitidos = new Set((await candidaturasFiltradas(f)).map((c) => c.pid));
      ids = ids.filter((pid) => permitidos.has(pid));
    } else {
      if (ids.length > LIMITE_FILTRO_NOME) aviso = ` Filtro aplicado aos ${LIMITE_FILTRO_NOME} resultados mais relevantes; escolha o ano para filtrar todos.`;
      const ps = await Promise.all(ids.slice(0, LIMITE_FILTRO_NOME).map(pessoa));
      ids = ps.filter((p) => p.cands.some((c) => candidaturaAtende(c, f))).map((p) => p.pid);
    }
  }
  if (!ids.length) {
    return setStatus(temFiltro(f) ? `Nenhuma candidatura encontrada para esse nome com os filtros (${descreverFiltros(f)}).`
      : "Nenhuma candidatura encontrada para esse nome. Confira a grafia ou tente o nome completo.");
  }
  const pessoas = await Promise.all(ids.slice(0, MAX_RESULTADOS).map(pessoa));
  const qJunto = tk.join(" ");
  // Nome (ou nome de urna) idêntico ao buscado vem primeiro; o resto mantém a
  // ordem de relevância do índice (sort é estável).
  const exato = (p) => [p.nome, ...p.urnas].some((n) => tokens(normaliza(n)).join(" ") === qJunto) ? 1 : 0;
  pessoas.sort((a, b) => exato(b) - exato(a));
  if (pessoas.length === 1 && !temFiltro(f)) return mostrarFicha(pessoas[0].pid, true);
  const extra = ids.length > MAX_RESULTADOS ? ` Mostrando as ${MAX_RESULTADOS} mais relevantes — refine a busca para ver outras.` : "";
  const filtroTxt = temFiltro(f) ? ` (${descreverFiltros(f)})` : "";
  setStatus(`${ids.length.toLocaleString("pt-BR")} pessoa${ids.length > 1 ? "s" : ""} encontrada${ids.length > 1 ? "s" : ""}${filtroTxt}.${extra}${aviso}`);
  const ctx = temFiltro(f) ? (p) => p.cands.filter((c) => candidaturaAtende(c, f)).pop() : () => null;
  $("#resultados").innerHTML = `<div class="lista">${pessoas.map((p, i) => cartao(p, i, ctx(p))).join("")}</div>`;
  ativarFotos($("#resultados"));
}

async function listarPorFiltro(f, pg) {
  if (!f.ano) return setStatus("Para consultar sem nome, escolha pelo menos o ano da eleição (e, de preferência, o estado).", { erro: true });
  if (!f.uf && !f.cargo) return setStatus("Escolha também o estado ou o cargo para consultar sem nome.", { erro: true });
  const todas = await candidaturasFiltradas(f);
  if (!todas.length) return setStatus(`Nenhuma candidatura encontrada (${descreverFiltros(f)}).`);
  const paginas = Math.ceil(todas.length / POR_PAGINA);
  pg = Math.min(Math.max(1, pg), paginas);
  const pagina = todas.slice((pg - 1) * POR_PAGINA, pg * POR_PAGINA);
  const pessoas = await Promise.all(pagina.map((c) => pessoa(c.pid)));
  setStatus(`${todas.length.toLocaleString("pt-BR")} candidatura${todas.length > 1 ? "s" : ""} (${descreverFiltros(f)}) — página ${pg} de ${paginas}, em ordem alfabética.`);
  const ctx = (p, k) => p.cands.find((c) => String(c.ano) === f.ano && c.cargoCod === pagina[k].cargo && c.ueCod === pagina[k].ue) || null;
  const nav = paginas > 1 ? `<nav class="paginacao" aria-label="Páginas">
      <button type="button" data-pg="${pg - 1}" ${pg <= 1 ? "disabled" : ""}>← Anterior</button>
      <span>Página ${pg} de ${paginas}</span>
      <button type="button" data-pg="${pg + 1}" ${pg >= paginas ? "disabled" : ""}>Próxima →</button></nav>` : "";
  $("#resultados").innerHTML = `${nav}<div class="lista">${pessoas.map((p, k) => cartao(p, k, ctx(p, k))).join("")}</div>${nav}`;
  ativarFotos($("#resultados"));
}

// ctx (opcional): a candidatura que motivou o resultado — exibida em destaque no cartão.
function cartao(p, i, ctx = null) {
  const r = resumo(p);
  const urna = p.urnas[0] && normaliza(p.urnas[0]) !== normaliza(p.nome) ? ` · urna: “${esc(p.urnas[0])}”` : "";
  const selo = r.eleicoes.length
    ? `<span class="selo ok">eleito${r.eleicoes.length > 1 ? ` ${r.eleicoes.length}×` : ""}</span>`
    : `<span class="selo neutro">nunca eleito</span>`;
  const periodo = r.de === r.ate ? r.de : `${r.de}–${r.ate}`;
  const partidos = [...new Set(r.partidos.map((x) => x.sigla))].join(", ");
  const destaque = ctx ? `<div class="linha contexto"><strong>${ctx.ano} · ${esc(cap(ctx.cargo))}</strong> · ${esc(localTexto(ctx))} · ${esc(ctx.sigla)}
      ${ctx.resultado ? ` · ${ctx.eleito ? `<span class="ok-txt">${esc(cap(ctx.resultado))}</span>` : esc(cap(ctx.resultado))}` : ""}</div>` : "";
  return `<button class="cartao" data-pid="${p.pid}" style="animation-delay:${Math.min(i, 12) * 25}ms">
    ${avatar(p)}
    <span class="info">
      <h3>${esc(cap(p.nome))}${selo}${p.sancoes.length ? `<span class="selo alerta">⚠ sanção registrada</span>` : ""}</h3>
      ${destaque}
      <div class="linha">${p.cands.length} candidatura${p.cands.length > 1 ? "s" : ""} (${periodo})${urna}</div>
      <div class="linha">${esc(r.ufs.join(", ") || "Brasil")} · ${esc(partidos)}${p.anoNasc ? ` · nasc. ${p.anoNasc}` : ""}${p.cpf ? ` · CPF ${esc(p.cpf)}` : ""}</div>
    </span>
    <span class="seta" aria-hidden="true">›</span>
  </button>`;
}

// ---------- Ficha ----------

async function mostrarFicha(pid, unica = false) {
  mostrarInicio(false);
  setStatus("Carregando ficha…", { carregando: true });
  let p;
  try {
    p = await pessoa(pid);
  } catch (e) {
    console.error(e);
    return setStatus("Não foi possível carregar a ficha.", { erro: true });
  }
  const r = resumo(p);
  if (!unica) $("#resultados").hidden = true;
  setStatus("");
  const ultimaEleicao = r.eleicoes[r.eleicoes.length - 1];
  const bensAnos = p.cands.filter((c) => c.bens !== null);
  const ultimoBens = [...bensAnos].reverse().find((c) => c.bens > 0);
  const temResultados = !unica && $("#resultados").innerHTML;
  const problemas = p.cands.filter(temProblema);
  const trocas = Math.max(0, r.partidos.length - 1);
  const mandatos = variacoesNoMandato(p);
  const pares = comparacaoPares(p);
  const comp = companheiros(p);

  $("#ficha").innerHTML = `
    ${temResultados ? `<button class="voltar" id="voltar">← voltar aos resultados</button>` : ""}
    <div class="ficha-topo">
      ${avatar(p, "grande")}
      <div>
        <h2>${esc(cap(p.nome))}</h2>
        <div class="linha">${p.urnas.length ? `Nome de urna: ${p.urnas.map((u) => `“${esc(u)}”`).join(", ")}` : ""}
          ${p.cpf ? ` · CPF: ${esc(p.cpf)}` : ""}</div>
        <div class="selos-topo">
          ${r.eleicoes.length ? `<span class="selo ok">eleito(a) ${r.eleicoes.length}×</span>` : `<span class="selo neutro">nunca eleito(a)</span>`}
          ${trocas ? `<span class="selo neutro">${trocas} troca${trocas > 1 ? "s" : ""} de partido</span>` : ""}
          ${problemas.length ? `<span class="selo alerta">${problemas.length} candidatura${problemas.length > 1 ? "s" : ""} com restrição</span>` : ""}
          ${seloEspectro(p)}
          ${p.sancoes.length ? `<button type="button" class="selo alerta forte" id="ir-sancoes">⚠ ${p.sancoes.length} registro${p.sancoes.length > 1 ? "s" : ""} em cadastro de sanções</button>` : ""}
        </div>
      </div>
    </div>

    <div class="resumo">
      <div class="kpi"><div class="rot">Já foi candidato(a)?</div><div class="val">Sim, ${p.cands.length}×</div></div>
      <div class="kpi destaque"><div class="rot">Já foi eleito(a)?</div><div class="val">${r.eleicoes.length ? `Sim, ${r.eleicoes.length}×` : "Não"}</div></div>
      <div class="kpi"><div class="rot">Último cargo em que foi eleito(a)</div><div class="val pequeno">${ultimaEleicao ? `${esc(cap(ultimaEleicao.cargo))} (${ultimaEleicao.ano})<br><span class="muted">${esc(localTexto(ultimaEleicao))}</span>` : "—"}</div></div>
      <div class="kpi"><div class="rot">Patrimônio declarado mais recente</div><div class="val pequeno">${ultimoBens ? `${brl.format(ultimoBens.bens)} <span class="muted">(${ultimoBens.ano})</span><br><span class="muted">≈ ${brl.format(real(ultimoBens.bens, ultimoBens.ano))} em ${mesRef()}</span>` : "—"}</div></div>
    </div>

    ${blocoSancoes(p)}

    ${blocoPerfil(p)}

    ${blocoFinanciamento(p)}

    ${mandatos.length || pares ? `<div class="bloco">
      <h3>Patrimônio em perspectiva</h3>
      <ul class="fatos">
        ${mandatos.map((m) => `<li><span class="fato-ico ${m.pct > 0 ? "sobe" : "desce"}">${m.pct > 0 ? "▲" : "▼"}</span>
          <span>Eleito(a) <strong>${esc(cap(m.c.cargo))}</strong> em ${m.c.ano}: na declaração seguinte, em ${m.prox.ano}, o patrimônio
          ${m.pct >= 0 ? "cresceu" : "caiu"} <strong>${fmtPct(Math.abs(m.pct))}</strong> já descontada a inflação
          <span class="muted">(${brl.format(m.v0)} → ${brl.format(m.v1)}, em R$ de ${mesRef()})</span>.</span></li>`).join("")}
        ${pares ? `<li><span class="fato-ico">≡</span><span>Em ${pares.c.ano}, o patrimônio declarado (${brl.format(pares.c.bens)}) era
          maior que o de <strong>${pares.pct}%</strong> dos eleitos para ${esc(cap(pares.c.cargo))} naquele ano.</span></li>` : ""}
      </ul>
      <p class="nota">Comparações feitas apenas com números declarados ao TSE, corrigidos pelo IPCA (IBGE). Variações podem ter
        explicações legítimas (herança, venda, reavaliação de bens) e não indicam irregularidade por si só.</p>
    </div>` : ""}

    <div class="bloco">
      <h3>Composição e evolução do patrimônio</h3>
      <div class="alternar" role="group" aria-label="Tipo de valor">
        <button type="button" data-modo="real" aria-pressed="true">Corrigido pela inflação</button>
        <button type="button" data-modo="nominal" aria-pressed="false">Valor declarado</button>
      </div>
      <div id="grafico-bens">${graficoBens(bensAnos, "real")}</div>
    </div>

    <div class="bloco">
      <h3>Trajetória partidária</h3>
      <div class="partidos">${r.partidos.map((x, i) => `${i ? `<span class="seta-p">→</span>` : ""}<span class="partido" title="${esc(x.nome)}"><i style="background:${corPartido(x.sigla)}"></i><strong>${esc(x.sigla)}</strong> <small>${x.de === x.ate ? x.de : `${x.de}–${x.ate}`}</small></span>`).join("")}</div>
      <p class="nota">Partido pelo qual concorreu em cada eleição, em ordem cronológica${trocas ? ` — ${trocas} troca${trocas > 1 ? "s" : ""} de partido` : ""}. As coligações aparecem na tabela de candidaturas.</p>
    </div>

    ${blocoEspectro(p)}

    ${comp.length ? `<div class="bloco">
      <h3>Já compôs chapa com</h3>
      <div class="companheiros">${comp.map((x) => `<a class="companheiro" href="${linkPessoa(x.pid, x.nome)}">
        <span class="avatar pequeno" aria-hidden="true">${esc(iniciais(x.nome))}</span>
        <span><strong>${esc(cap(x.nome))}</strong><small>${esc(x.vezes.join(", "))}</small></span></a>`).join("")}</div>
    </div>` : ""}

    <div class="bloco">
      <h3>Candidaturas</h3>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Ano</th><th>Cargo</th><th>Local</th><th>Partido / coligação</th><th>Resultado</th><th>Chapa</th><th class="num">Bens declarados</th></tr></thead>
        <tbody>${[...p.cands].reverse().map(linhaCand).join("")}</tbody>
      </table></div>
      <p class="nota">Fonte: TSE. Em “Chapa”, clique no nome do vice, titular ou suplente para abrir a ficha dele(a).
        Candidaturas com restrição (indeferidas, cassadas, com renúncia etc.) aparecem com o selo vermelho.
        “2º turno” indica que a apuração final não consta no arquivo do TSE.</p>
    </div>`;
  const v = $("#voltar");
  if (v) v.onclick = () => history.back();
  const irS = $("#ir-sancoes");
  if (irS) irS.onclick = () => $("#sancoes").scrollIntoView({ behavior: semAnimacao ? "auto" : "smooth" });
  const irE = $("#ir-espectro");
  if (irE) irE.onclick = () => $("#espectro").scrollIntoView({ behavior: semAnimacao ? "auto" : "smooth", block: "start" });
  for (const b of document.querySelectorAll(".alternar button")) {
    b.onclick = () => {
      for (const o of document.querySelectorAll(".alternar button")) o.setAttribute("aria-pressed", String(o === b));
      $("#grafico-bens").innerHTML = graficoBens(bensAnos, b.dataset.modo);
    };
  }
  ativarFotos($("#ficha"));
  window.scrollTo({ top: $(".conteudo").offsetTop - 8 });
}

const fmtPct = (x) => `${x.toLocaleString("pt-BR", { maximumFractionDigits: x < 10 ? 1 : 0 })}%`;

// Posição da verba pública recebida entre os candidatos do mesmo cargo e ano (percentil).
function percentilPublico(c) {
  const pct = META.percentis_publico?.[`${c.ano}|${c.cargoCod}`];
  if (!pct || !c.receita) return null;
  let n = 0;
  while (n < 100 && pct[n + 1] < c.receita.publico) n++;
  return n;
}

function blocoFinanciamento(p) {
  const cs = p.cands.filter((c) => c.receita);
  if (!cs.length) return "";
  const totalPub = cs.reduce((s, c) => s + c.receita.publico, 0);
  const totalReal = cs.reduce((s, c) => s + real(c.receita.publico, c.ano), 0);
  const max = Math.max(...cs.map((c) => c.receita.total), 1);
  const linhas = [...cs].reverse().map((c) => {
    const r = c.receita, outros = Math.max(0, r.total - r.publico);
    const pctPub = r.total ? Math.round((r.publico / r.total) * 100) : 0;
    const w = (v) => `${(v / max) * 100}%`;
    const pctl = percentilPublico(c);
    return `<tr>
      <td>${c.ano}</td>
      <td>${esc(cap(c.cargo))}<div class="muted">${esc(localTexto(c))}</div></td>
      <td class="num"><strong>${brl.format(r.total)}</strong></td>
      <td class="num">${brl.format(r.fefc)}</td>
      <td class="num">${brl.format(r.fp)}</td>
      <td class="num">${brl.format(outros)}</td>
      <td class="barra-fin-cel">
        <div class="barra-fin" title="Fundo eleitoral ${brl.format(r.fefc)} · Fundo partidário ${brl.format(r.fp)} · Outros ${brl.format(outros)}">
          <i class="fin0" style="width:${w(r.fefc)}"></i><i class="fin1" style="width:${w(r.fp)}"></i><i class="fin2" style="width:${w(outros)}"></i>
        </div>
        <small class="muted">${pctPub}% público${pctl !== null && r.publico > 0 ? ` · mais que ${pctl}% dos candidatos a ${esc(cap(c.cargo))}` : ""}</small>
      </td></tr>`;
  }).join("");
  return `<div class="bloco">
    <h3>Financiamento de campanha</h3>
    <div class="resumo resumo-fin">
      <div class="kpi destaque"><div class="rot">Verba pública recebida (${cs[0].ano === cs[cs.length - 1].ano ? cs[0].ano : `${cs[0].ano}–${cs[cs.length - 1].ano}`})</div>
        <div class="val">${brl.format(totalPub)}</div>
        <div class="rot" style="margin-top:4px">≈ ${brl.format(totalReal)} em R$ de ${mesRef()}</div></div>
    </div>
    <div class="legenda"><span><i class="fin0"></i>Fundo eleitoral (FEFC)</span><span><i class="fin1"></i>Fundo partidário</span><span><i class="fin2"></i>Outras fontes</span></div>
    <div class="tabela-wrap"><table>
      <thead><tr><th>Ano</th><th>Cargo</th><th class="num">Total arrecadado</th><th class="num">Fundo eleitoral</th><th class="num">Fundo partidário</th><th class="num">Outras fontes</th><th>Composição</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table></div>
    <p class="nota">Receitas declaradas na prestação de contas de campanha (TSE), disponíveis a partir de 2018 — ano em que o Fundo Especial
      de Financiamento de Campanha passou a existir. Inclui recursos financeiros e estimáveis (bens e serviços) e repasses de partidos e de
      outros candidatos. Dados de 2026 são parciais.</p>
  </div>`;
}

function blocoSancoes(p) {
  if (!p.sancoes.length) return "";
  const fontes = META.sancoes_fontes || {};
  const datas = [...new Set(Object.values(fontes))].map((d) => `${d.slice(6)}/${d.slice(4, 6)}/${d.slice(0, 4)}`);
  const ord = [...p.sancoes].sort((a, b) => (b.vigente - a.vigente) || (a.inicio < b.inicio ? 1 : -1));
  return `<div class="bloco sancoes" id="sancoes">
    <h3>Registros em cadastros de sanções (CGU)</h3>
    <ul class="lista-sancoes">${ord.map((s) => `<li>
      <div class="sancao-topo">
        <span class="cad" title="${esc(NOMES_CADASTRO[s.cadastro] || s.cadastro)}">${esc(s.cadastro)}</span>
        <strong>${esc(s.categoria || "Sanção")}</strong>
        <span class="selo ${s.vigente ? "alerta" : "neutro"}">${s.vigente ? "vigente" : "encerrada"}</span>
      </div>
      <div class="sancao-info">
        <span><span class="muted">Órgão sancionador:</span> ${esc(s.orgao || "—")}${s.ufOrgao ? ` (${esc(s.ufOrgao)})` : ""}</span>
        <span><span class="muted">Período:</span> ${esc(s.inicio || "—")} ${s.fim ? `a ${esc(s.fim)}` : "(sem data final)"}</span>
        ${s.transito ? `<span><span class="muted">Trânsito em julgado:</span> ${esc(s.transito)}</span>` : ""}
        ${s.processo ? `<span><span class="muted">Processo:</span> ${esc(s.processo)}</span>` : ""}
        ${s.fundamentacao ? `<span><span class="muted">Fundamentação:</span> ${esc(s.fundamentacao)}</span>` : ""}
      </div>
      ${s.codigo ? `<a class="fonte" href="https://portaldatransparencia.gov.br/sancoes/consulta/${encodeURIComponent(s.codigo)}" target="_blank" rel="noopener">Ver no Portal da Transparência ↗</a>` : ""}
    </li>`).join("")}</ul>
    <p class="nota">Registros do ${Object.keys(fontes).join(", ") || "cadastro"} (Portal da Transparência/CGU${datas.length ? `, dados de ${datas.join(", ")}` : ""}),
      localizados pelo CPF informado ao TSE — CPF completo idêntico ou, quando a fonte traz o CPF mascarado, dígitos visíveis e nome completo idênticos.
      Confira sempre os detalhes na fonte oficial; o registro reflete a informação do órgão sancionador na data da consulta.</p>
  </div>`;
}

function blocoPerfil(p) {
  const f = p.perfil;
  const itens = [];
  const hoje = new Date().getFullYear();
  if (p.anoNasc) itens.push(["Nascimento", `${p.anoNasc} <span class="muted">(${hoje - p.anoNasc} anos em ${hoje})</span>`]);
  if (f.ufNasc) itens.push(["Natural de", esc(f.ufNasc)]);
  if (f.genero) itens.push(["Gênero", esc(cap(f.genero))]);
  if (f.cor) itens.push(["Cor/raça", esc(cap(f.cor))]);
  if (f.instrucao) itens.push(["Instrução", esc(cap(f.instrucao))]);
  // Ocupação declarada em cada eleição, agrupando anos consecutivos iguais.
  const ocup = [];
  for (const c of p.cands) {
    if (!c.ocupacao) continue;
    const u = ocup[ocup.length - 1];
    if (u && u.nome === c.ocupacao) u.ate = c.ano;
    else ocup.push({ nome: c.ocupacao, de: c.ano, ate: c.ano });
  }
  if (!itens.length && !ocup.length) return "";
  return `<div class="bloco">
    <h3>Perfil</h3>
    <dl class="perfil">${itens.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    ${ocup.length ? `<div class="ocupacoes"><span class="muted">Ocupação declarada:</span>
      ${ocup.map((o) => `<span class="ocup">${esc(cap(o.nome))} <small>${o.de === o.ate ? o.de : `${o.de}–${o.ate}`}</small></span>`).join('<span class="seta-p">→</span>')}</div>` : ""}
  </div>`;
}

function chapaHtml(c) {
  if (!c.chapa.length) return `<span class="muted">—</span>`;
  // A mesma pessoa pode ter dois papéis na chapa (ex.: vice que substituiu o titular).
  const porPessoa = new Map();
  for (const m of c.chapa) {
    const papel = TITULARES.has(normaliza(m.cargo)) ? "Titular" : cap(m.cargo);
    const atual = porPessoa.get(m.pid);
    if (atual) { if (!atual.papeis.includes(papel)) atual.papeis.push(papel); }
    else porPessoa.set(m.pid, { ...m, papeis: [papel] });
  }
  return `<div class="chapa">${[...porPessoa.values()].map((m) =>
    `<div><span>${esc(m.papeis.join(" / "))}:</span> <a href="${linkPessoa(m.pid, m.nome)}">${esc(cap(m.nome))}</a></div>`
  ).join("")}</div>`;
}

function linhaCand(c) {
  const problema = temProblema(c);
  const sit = c.situacao && !/^(APTO|DEFERIDO)/.test(c.situacao)
    ? `<div>${problema ? `<span class="selo alerta" style="margin:4px 0 0">${esc(cap(c.situacao))}</span>` : `<span class="muted">${esc(cap(c.situacao))}</span>`}</div>` : "";
  const res = c.resultado ? (c.eleito ? `<span class="selo ok" style="margin:0">${esc(cap(c.resultado))}</span>` : esc(cap(c.resultado))) : `<span class="muted">—</span>`;
  const bens = c.bens === null ? `<span class="muted">n/d</span>` : brl.format(c.bens);
  const colig = c.coligacao ? `<div class="colig" title="Coligação/federação">${esc(c.coligacao)}</div>` : "";
  return `<tr class="${c.eleito ? "eleito" : ""}${problema ? " problema" : ""}">
    <td>${c.ano}${c.eleicao ? `<div class="muted">${esc(cap(c.eleicao))}</div>` : ""}</td>
    <td>${esc(cap(c.cargo))}</td><td>${esc(localTexto(c))}</td>
    <td class="partido-cel" title="${esc(c.nomePartido)}"><strong>${esc(c.sigla)}</strong>${colig}</td>
    <td>${res}${sit}</td><td class="chapa-cel">${chapaHtml(c)}</td><td class="num">${bens}</td></tr>`;
}

// Gráfico de barras empilhadas por categoria de bem. modo: "real" (corrigido pelo IPCA) ou "nominal".
function graficoBens(cands, modo) {
  const CATS = META.categorias_bens || ["Total"];
  // Um ponto por ano (se concorreu a mais de um cargo no mesmo ano, fica a declaração de maior valor).
  const porAno = new Map();
  for (const c of cands) if (!porAno.has(c.ano) || c.bens > porAno.get(c.ano).bens) porAno.set(c.ano, c);
  const pts = [...porAno.values()].sort((a, b) => a.ano - b.ano).map((c) => {
    const f = modo === "real" ? (fatorIpca(c.ano) ?? 1) : 1;
    const partes = (c.porTipo || (c.bens ? [0, 0, 0, 0, 0, c.bens] : [0, 0, 0, 0, 0, 0])).map((v) => v * f);
    return { ano: c.ano, total: c.bens * f, partes };
  });
  if (!pts.length) return `<p class="muted">Sem declarações de bens disponíveis (o TSE publica bens a partir de 2006).</p>`;

  const W = 720, H = 260, M = { t: 26, r: 12, b: 28, l: 12 };
  const max = Math.max(...pts.map((p) => p.total), 1);
  const passo = (W - M.l - M.r) / pts.length;
  const bw = Math.min(70, passo * 0.6);
  const escala = (H - M.t - M.b) / max;
  const barras = pts.map((p, i) => {
    const x = M.l + passo * i + (passo - bw) / 2;
    let y = H - M.b;
    const segs = p.partes.map((v, k) => {
      if (v <= 0) return "";
      const h = Math.max(v * escala, 1);
      y -= h;
      return `<rect class="cat${k}" x="${x}" y="${y}" width="${bw}" height="${h}"><title>${p.ano} · ${CATS[k]}: ${brl.format(v)}</title></rect>`;
    }).join("");
    const topo = H - M.b - p.total * escala;
    return `${segs}<text class="valor" x="${x + bw / 2}" y="${topo - 7}" text-anchor="middle">${p.total ? "R$ " + brlCurto.format(p.total) : "R$ 0"}</text>
      <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${p.ano}</text>`;
  }).join("");

  const presentes = CATS.map((_, k) => k).filter((k) => pts.some((p) => p.partes[k] > 0));
  const legenda = presentes.length ? `<div class="legenda">${presentes.map((k) => `<span><i class="cat${k}"></i>${CATS[k]}</span>`).join("")}</div>` : "";

  let variacao = "";
  const validos = pts.filter((p) => p.total > 0);
  if (validos.length >= 2) {
    const a = validos[0], b = validos[validos.length - 1];
    const pct = (b.total / a.total - 1) * 100;
    variacao = `<p class="nota">De ${a.ano} para ${b.ano}: ${brl.format(a.total)} → <strong>${brl.format(b.total)}</strong>
      (${pct >= 0 ? "+" : "−"}${fmtPct(Math.abs(pct))}${modo === "real" ? `, em R$ de ${mesRef()}, corrigido pelo IPCA` : ", valores nominais sem correção"}).</p>`;
  }
  return `${legenda}<div class="grafico"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Patrimônio declarado por ano e tipo de bem">
    <line class="eixo" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>${barras}</svg></div>${variacao}
    <p class="nota">Soma dos bens declarados ao TSE em cada candidatura, agrupados por tipo. R$ 0 significa que nenhum bem foi declarado.</p>`;
}

// ---------- Navegação (estado na URL) ----------

const CAMPOS_FILTRO = ["uf", "ano", "cargo", "mun", "eleitos"];

function lerHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const f = Object.fromEntries(CAMPOS_FILTRO.map((k) => [k, h.get(k) || ""]));
  return { q: h.get("q") || "", p: h.get("p"), pg: +(h.get("pg") || 1), partidos: h.has("partidos"), explorar: h.has("explorar"),
    colinha: h.has("colinha"), imprimir: h.has("imprimir"), f };
}

// Monta o hash de uma consulta (omitindo campos vazios)
function hashConsulta(q, f, extra = {}) {
  const h = new URLSearchParams();
  if (q) h.set("q", q);
  for (const k of CAMPOS_FILTRO) if (f[k]) h.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") h.set(k, v);
  return h.toString();
}

async function rotear() {
  const { q, p, pg, partidos, explorar, colinha, imprimir, f } = lerHash();
  $("#partidos").innerHTML = "";
  document.body.classList.toggle("modo-colinha", colinha && p === null);
  if (partidos) { $("#explorar").innerHTML = ""; return mostrarPartidos(); }
  if (colinha && p === null) { $("#q").dataset.ultima = ""; return mostrarColinha(f.uf, imprimir); }
  if (p !== null) {
    if (q) $("#q").value = q;
    $("#resultados").hidden = true;
    $("#explorar").hidden = true;
    return mostrarFicha(Number(p));
  }
  $("#explorar").hidden = false;
  $("#ficha").innerHTML = "";
  if (explorar) {
    const chave = hashExplorar(f, { pg: pg > 1 ? pg : "" });
    if ($("#q").dataset.ultima === chave && $("#explorar").innerHTML) {
      $("#resultados").hidden = false;
      return setStatus($("#status").dataset.anterior || "");
    }
    $("#q").dataset.ultima = chave;
    $("#q").value = "";
    return mostrarExplorar(f, pg);
  }
  $("#explorar").innerHTML = "";
  if (q || temFiltro(f)) {
    const chave = hashConsulta(q, f, { pg: pg > 1 ? pg : "" });
    if ($("#q").dataset.ultima !== chave || !$("#resultados").innerHTML) {
      $("#q").dataset.ultima = chave;
      await consultar(q, f, pg);
    } else {
      mostrarInicio(false);
      $("#resultados").hidden = false;
      setStatus($("#status").dataset.anterior || "");
    }
  } else {
    $("#resultados").innerHTML = "";
    $("#q").value = "";
    setStatus("");
    mostrarInicio(true);
  }
}

async function iniciar() {
  try {
    META = await getJson("data/meta.json");
    contar($("#n-pessoas"), META.pessoas);
    contar($("#n-cands"), META.candidaturas);
    $("#n-anos").textContent = `${META.anos.length} (${META.anos[0]}–${META.anos[META.anos.length - 1]})`;
    $("#meta-info").textContent = `Base atualizada em ${META.gerado_em.split("-").reverse().join("/")}.`;
  } catch (e) {
    return setStatus("Os dados ainda não foram gerados. Rode o workflow de build no GitHub Actions.", { erro: true });
  }
  $("#busca").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = $("#q").value.trim();
    if (q) location.hash = hashConsulta(q, {});
    else setStatus("Digite um nome para consultar, ou use “Explorar pelo mapa”.");
  });
  $("#resultados").addEventListener("click", (ev) => {
    const { q, f, pg, explorar } = lerHash();
    const monta = (extra) => (explorar ? hashExplorar(f, extra) : hashConsulta(q, f, extra));
    const pgBtn = ev.target.closest(".paginacao button[data-pg]");
    if (pgBtn) {
      location.hash = monta({ pg: pgBtn.dataset.pg > 1 ? pgBtn.dataset.pg : "" });
      window.scrollTo({ top: $(".conteudo").offsetTop - 8 });
      return;
    }
    const b = ev.target.closest(".cartao");
    if (!b) return;
    $("#status").dataset.anterior = $("#status").textContent;
    location.hash = monta({ pg: pg > 1 ? pg : "", p: b.dataset.pid });
  });
  $("#home").addEventListener("click", (ev) => { ev.preventDefault(); location.hash = ""; $("#q").focus(); });
  window.addEventListener("hashchange", rotear);
  rotear();
}

iniciar();
