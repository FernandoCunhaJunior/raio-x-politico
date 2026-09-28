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
  const [nome, urnas, anoNasc, ocupacao, cands, cpf] = lote[pid % META.por_arquivo];
  return { pid, nome, urnas, anoNasc, cpf, ocupacao: META.tabelas.ocupacao[ocupacao], cands: cands.map(candidatura) };
}

function candidatura([ano, cargo, ue, partido, situacao, resultado, bens, eleicao, chapa]) {
  const T = META.tabelas;
  const [uf, local] = T.ue[ue].split("|");
  const [sigla, nomePartido] = T.partido[partido].split("|");
  const res = T.resultado[resultado];
  return {
    ano, cargo: T.cargo[cargo], uf, local, sigla, nomePartido,
    situacao: T.situacao[situacao], resultado: res,
    eleito: /^ELEITO|^M[EÉ]DIA$/.test(res), bens, eleicao: T.eleicao[eleicao],
    // Companheiros de chapa: [pid, código do cargo, nome]
    chapa: (chapa || []).map(([pid, c, nome]) => ({ pid, cargo: T.cargo[c], nome })),
  };
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
    <span class="avatar${r.eleicoes.length ? " eleito" : ""}" aria-hidden="true">${esc(iniciais(p.nome))}</span>
    <span class="info">
      <h3>${esc(cap(p.nome))}${selo}</h3>
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

  $("#ficha").innerHTML = `
    ${temResultados ? `<button class="voltar" id="voltar">← voltar aos resultados</button>` : ""}
    <div class="ficha-topo">
      <span class="avatar grande${r.eleicoes.length ? " eleito" : ""}" aria-hidden="true">${esc(iniciais(p.nome))}</span>
      <div>
        <h2>${esc(cap(p.nome))}</h2>
        <div class="linha">${p.urnas.length ? `Nome de urna: ${p.urnas.map((u) => `“${esc(u)}”`).join(", ")}` : ""}
          ${p.anoNasc ? ` · nascimento: ${p.anoNasc}` : ""}${p.cpf ? ` · CPF: ${esc(p.cpf)}` : ""}${p.ocupacao ? ` · ocupação declarada: ${esc(cap(p.ocupacao))}` : ""}</div>
      </div>
    </div>

    <div class="resumo">
      <div class="kpi"><div class="rot">Já foi candidato(a)?</div><div class="val">Sim, ${p.cands.length}×</div></div>
      <div class="kpi destaque"><div class="rot">Já foi eleito(a)?</div><div class="val">${r.eleicoes.length ? `Sim, ${r.eleicoes.length}×` : "Não"}</div></div>
      <div class="kpi"><div class="rot">Último cargo em que foi eleito(a)</div><div class="val pequeno">${ultimaEleicao ? `${esc(cap(ultimaEleicao.cargo))} (${ultimaEleicao.ano})<br><span class="muted">${esc(localTexto(ultimaEleicao))}</span>` : "—"}</div></div>
      <div class="kpi"><div class="rot">Patrimônio declarado mais recente</div><div class="val pequeno">${ultimoBens ? `${brl.format(ultimoBens.bens)} <span class="muted">(${ultimoBens.ano})</span>` : "—"}</div></div>
    </div>

    <div class="bloco">
      <h3>Trajetória partidária</h3>
      <div class="partidos">${r.partidos.map((x, i) => `${i ? `<span class="seta-p">→</span>` : ""}<span class="partido" title="${esc(x.nome)}"><i style="background:${corPartido(x.sigla)}"></i><strong>${esc(x.sigla)}</strong> <small>${x.de === x.ate ? x.de : `${x.de}–${x.ate}`}</small></span>`).join("")}</div>
      <p class="nota">Partido pelo qual concorreu em cada eleição, em ordem cronológica.</p>
    </div>

    <div class="bloco">
      <h3>Evolução do patrimônio declarado</h3>
      ${graficoBens(bensAnos)}
    </div>

    <div class="bloco">
      <h3>Candidaturas</h3>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Ano</th><th>Cargo</th><th>Local</th><th>Partido</th><th>Resultado</th><th>Chapa</th><th class="num">Bens declarados</th></tr></thead>
        <tbody>${[...p.cands].reverse().map(linhaCand).join("")}</tbody>
      </table></div>
      <p class="nota">Fonte: TSE. Em “Chapa”, clique no nome do vice, titular ou suplente para abrir a ficha dele(a).
        “2º turno” indica que a apuração final não consta no arquivo do TSE; situações como “indeferido” ou “renúncia” aparecem abaixo do resultado.</p>
    </div>`;
  const v = $("#voltar");
  if (v) v.onclick = () => history.back();
  window.scrollTo({ top: $(".conteudo").offsetTop - 8 });
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
  const sit = c.situacao && !/^(APTO|DEFERIDO)/.test(c.situacao) ? `<div class="muted">${esc(cap(c.situacao))}</div>` : "";
  const res = c.resultado ? (c.eleito ? `<span class="selo ok" style="margin:0">${esc(cap(c.resultado))}</span>` : esc(cap(c.resultado))) : `<span class="muted">—</span>`;
  const bens = c.bens === null ? `<span class="muted">n/d</span>` : brl.format(c.bens);
  return `<tr class="${c.eleito ? "eleito" : ""}">
    <td>${c.ano}${c.eleicao ? `<div class="muted">${esc(cap(c.eleicao))}</div>` : ""}</td>
    <td>${esc(cap(c.cargo))}</td><td>${esc(localTexto(c))}</td>
    <td title="${esc(c.nomePartido)}">${esc(c.sigla)}</td>
    <td>${res}${sit}</td><td class="chapa-cel">${chapaHtml(c)}</td><td class="num">${bens}</td></tr>`;
}

function graficoBens(cands) {
  // Um ponto por ano (se concorreu a mais de um cargo no mesmo ano, fica o maior valor).
  const porAno = new Map();
  for (const c of cands) porAno.set(c.ano, Math.max(porAno.get(c.ano) ?? 0, c.bens));
  const pts = [...porAno].sort((a, b) => a[0] - b[0]);
  if (!pts.length) return `<p class="muted">Sem declarações de bens disponíveis (o TSE publica bens a partir de 2006).</p>`;

  const W = 720, H = 250, M = { t: 26, r: 12, b: 28, l: 12 };
  const max = Math.max(...pts.map((p) => p[1]), 1);
  const passo = (W - M.l - M.r) / pts.length;
  const bw = Math.min(70, passo * 0.6);
  const barras = pts.map(([ano, v], i) => {
    const h = (v / max) * (H - M.t - M.b);
    const x = M.l + passo * i + (passo - bw) / 2;
    const y = H - M.b - h;
    return `<rect class="barra" x="${x}" y="${y}" width="${bw}" height="${Math.max(h, v > 0 ? 2 : 0)}" rx="4"><title>${ano}: ${brl.format(v)}</title></rect>
      <text class="valor" x="${x + bw / 2}" y="${y - 7}" text-anchor="middle">${v ? "R$ " + brlCurto.format(v) : "R$ 0"}</text>
      <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${ano}</text>`;
  }).join("");

  let variacao = "";
  const validos = pts.filter((p) => p[1] > 0);
  if (validos.length >= 2) {
    const [a0, v0] = validos[0], [a1, v1] = validos[validos.length - 1];
    const pct = (v1 / v0 - 1) * 100;
    variacao = `<p class="nota">De ${a0} para ${a1}: ${brl.format(v0)} → <strong>${brl.format(v1)}</strong> (${pct >= 0 ? "+" : ""}${pct.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%, valores nominais sem correção pela inflação).</p>`;
  }
  return `<div class="grafico"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Patrimônio declarado por ano">
    <defs><linearGradient id="gBarra" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e02229"/><stop offset="1" stop-color="#8e1116"/></linearGradient></defs>
    <line class="eixo" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>${barras}</svg></div>${variacao}
    <p class="nota">Soma dos bens declarados ao TSE em cada candidatura. R$ 0 significa que nenhum bem foi declarado.</p>`;
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
