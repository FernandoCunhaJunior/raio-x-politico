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
function candidatura([ano, cargo, ue, partido, situacao, resultado, bens, eleicao, chapa, porTipo, ocupacao, coligacao]) {
  const T = META.tabelas;
  const [uf, local] = T.ue[ue].split("|");
  const [sigla, nomePartido] = T.partido[partido].split("|");
  const res = T.resultado[resultado];
  return {
    ano, cargoCod: cargo, cargo: T.cargo[cargo], uf, local, sigla, nomePartido,
    situacao: T.situacao[situacao], resultado: res,
    eleito: /^ELEITO|^M[EÉ]DIA$/.test(res), bens, eleicao: T.eleicao[eleicao],
    // Companheiros de chapa: [pid, código do cargo, nome]
    chapa: (chapa || []).map(([pid, c, nome]) => ({ pid, cargo: T.cargo[c], nome })),
    porTipo: porTipo || null,
    ocupacao: T.ocupacao[ocupacao || 0],
    coligacao: coligacao || "",
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

// ---------- Busca ----------

async function executarBusca(q) {
  mostrarInicio(false);
  $("#ficha").innerHTML = "";
  $("#resultados").innerHTML = "";
  $("#resultados").hidden = false;
  $("#q").value = q;
  const tk = tokens(normaliza(q));
  if (!tk.length) return setStatus("Digite um nome para buscar.");
  setStatus("Investigando…", { carregando: true });
  try {
    const r = await localizar(tk);
    if (r.muitos) {
      return setStatus("Muitas pessoas com esse nome. Digite o nome mais completo (ex.: nome + sobrenomes).", { erro: true });
    }
    if (!r.ids.length) {
      return setStatus("Nenhuma candidatura encontrada para esse nome. Confira a grafia ou tente o nome completo.");
    }
    const pessoas = await Promise.all(r.ids.slice(0, MAX_RESULTADOS).map(pessoa));
    const qJunto = tk.join(" ");
    // Nome (ou nome de urna) idêntico ao buscado vem primeiro; o resto mantém a
    // ordem de relevância do índice (sort é estável).
    const exato = (p) => [p.nome, ...p.urnas].some((n) => tokens(normaliza(n)).join(" ") === qJunto) ? 1 : 0;
    pessoas.sort((a, b) => exato(b) - exato(a));
    if (pessoas.length === 1) return mostrarFicha(pessoas[0].pid, true);
    const extra = r.ids.length > MAX_RESULTADOS ? ` Mostrando as ${MAX_RESULTADOS} mais relevantes — refine a busca para ver outras.` : "";
    setStatus(`${r.ids.length.toLocaleString("pt-BR")} pessoa${r.ids.length > 1 ? "s" : ""} encontrada${r.ids.length > 1 ? "s" : ""}.${extra}`);
    $("#resultados").innerHTML = `<div class="lista">${pessoas.map(cartao).join("")}</div>`;
    ativarFotos($("#resultados"));
  } catch (e) {
    console.error(e);
    setStatus("Não foi possível carregar os dados. Tente novamente.", { erro: true });
  }
}

function cartao(p, i) {
  const r = resumo(p);
  const urna = p.urnas[0] && normaliza(p.urnas[0]) !== normaliza(p.nome) ? ` · urna: “${esc(p.urnas[0])}”` : "";
  const selo = r.eleicoes.length
    ? `<span class="selo ok">eleito${r.eleicoes.length > 1 ? ` ${r.eleicoes.length}×` : ""}</span>`
    : `<span class="selo neutro">nunca eleito</span>`;
  const periodo = r.de === r.ate ? r.de : `${r.de}–${r.ate}`;
  const partidos = [...new Set(r.partidos.map((x) => x.sigla))].join(", ");
  return `<button class="cartao" data-pid="${p.pid}" style="animation-delay:${Math.min(i, 12) * 25}ms">
    ${avatar(p)}
    <span class="info">
      <h3>${esc(cap(p.nome))}${selo}${p.sancoes.length ? `<span class="selo alerta">⚠ sanção registrada</span>` : ""}</h3>
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

function lerHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { q: h.get("q") || "", p: h.get("p") };
}

async function rotear() {
  const { q, p } = lerHash();
  if (p !== null) {
    if (q) $("#q").value = q;
    $("#resultados").hidden = true;
    return mostrarFicha(Number(p));
  }
  $("#ficha").innerHTML = "";
  if (q) {
    if ($("#q").dataset.ultima !== q || !$("#resultados").innerHTML) {
      $("#q").dataset.ultima = q;
      await executarBusca(q);
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
    if (q) location.hash = new URLSearchParams({ q }).toString();
  });
  $("#resultados").addEventListener("click", (ev) => {
    const b = ev.target.closest(".cartao");
    if (!b) return;
    $("#status").dataset.anterior = $("#status").textContent;
    const { q } = lerHash();
    location.hash = new URLSearchParams({ q, p: b.dataset.pid }).toString();
  });
  $("#home").addEventListener("click", (ev) => { ev.preventDefault(); location.hash = ""; $("#q").focus(); });
  window.addEventListener("hashchange", rotear);
  rotear();
}

iniciar();
