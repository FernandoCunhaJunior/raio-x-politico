"use strict";

// Precisa bater com scripts/build.py
const STOP = new Set(["DA", "DE", "DO", "DAS", "DOS", "E", "D", "DI", "DU"]);
const MAX_RESULTADOS = 60;

const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const brlCurto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

let META = null;
const cacheJson = new Map();

function getJson(url) {
  if (!cacheJson.has(url)) {
    cacheJson.set(url, fetch(url).then((r) => {
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

function intersecta(listas) {
  listas.sort((a, b) => a.length - b.length);
  let atual = new Set(listas[0]);
  for (const l of listas.slice(1)) {
    const s = new Set(l);
    atual = new Set([...atual].filter((x) => s.has(x)));
  }
  return [...atual].sort((a, b) => a - b);
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
  const [nome, urnas, anoNasc, ocupacao, cands] = lote[pid % META.por_arquivo];
  return { pid, nome, urnas, anoNasc, ocupacao: META.tabelas.ocupacao[ocupacao], cands: cands.map(candidatura) };
}

function candidatura([ano, cargo, ue, partido, situacao, resultado, bens, eleicao]) {
  const T = META.tabelas;
  const [uf, local] = T.ue[ue].split("|");
  const [sigla, nomePartido] = T.partido[partido].split("|");
  const res = T.resultado[resultado];
  return {
    ano, cargo: T.cargo[cargo], uf, local, sigla, nomePartido,
    situacao: T.situacao[situacao], resultado: res,
    eleito: /^ELEITO|^M[EÉ]DIA$/.test(res), bens, eleicao: T.eleicao[eleicao],
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

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = (s) => (s || "").toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

function setStatus(msg, erro = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("erro", erro);
}

// ---------- Busca ----------

async function executarBusca(q) {
  $("#ficha").innerHTML = "";
  $("#resultados").innerHTML = "";
  $("#q").value = q;
  const qn = normaliza(q);
  const tk = tokens(qn);
  if (!tk.length) return setStatus("Digite um nome para buscar.");
  setStatus("Buscando…");
  try {
    const r = await localizar(tk);
    if (r.muitos) {
      return setStatus("Muitas pessoas com esse nome. Digite o nome mais completo (ex.: nome + sobrenomes).", true);
    }
    if (!r.ids.length) {
      return setStatus("Nenhuma candidatura encontrada para esse nome. Confira a grafia ou tente o nome completo.");
    }
    const ids = r.ids.slice(0, MAX_RESULTADOS);
    const pessoas = await Promise.all(ids.map(pessoa));
    const qJunto = tk.join(" ");
    const pontua = (p) => {
      const nome = tokens(normaliza(p.nome)).join(" ");
      const urnas = p.urnas.map((u) => tokens(normaliza(u)).join(" "));
      const exato = nome === qJunto || urnas.includes(qJunto) ? 1 : 0;
      return [exato, p.cands.filter((c) => c.eleito).length, p.cands.length];
    };
    pessoas.sort((a, b) => {
      const pa = pontua(a), pb = pontua(b);
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
    });
    if (pessoas.length === 1) return mostrarFicha(pessoas[0].pid, true);
    const extra = r.ids.length > MAX_RESULTADOS ? ` (mostrando ${MAX_RESULTADOS}; refine a busca para ver outros)` : "";
    setStatus(`${r.ids.length} pessoa${r.ids.length > 1 ? "s" : ""} encontrada${r.ids.length > 1 ? "s" : ""}${extra}.`);
    $("#resultados").innerHTML = `<div class="lista">${pessoas.map(cartao).join("")}</div>`;
  } catch (e) {
    console.error(e);
    setStatus("Não foi possível carregar os dados. Tente novamente.", true);
  }
}

function cartao(p) {
  const r = resumo(p);
  const urna = p.urnas[0] && normaliza(p.urnas[0]) !== normaliza(p.nome) ? ` · urna: “${esc(p.urnas[0])}”` : "";
  const selo = r.eleicoes.length
    ? `<span class="selo ok">eleito${r.eleicoes.length > 1 ? ` ${r.eleicoes.length}×` : ""}</span>`
    : `<span class="selo neutro">nunca eleito</span>`;
  const periodo = r.de === r.ate ? r.de : `${r.de}–${r.ate}`;
  const partidos = r.partidos.map((x) => x.sigla).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  return `<button class="cartao" data-pid="${p.pid}">
    <h3>${esc(cap(p.nome))}${selo}</h3>
    <div class="linha">${p.cands.length} candidatura${p.cands.length > 1 ? "s" : ""} (${periodo})${urna}</div>
    <div class="linha">${esc(r.ufs.join(", ") || "Brasil")} · ${esc(partidos)}${p.anoNasc ? ` · nasc. ${p.anoNasc}` : ""}</div>
  </button>`;
}

// ---------- Ficha ----------

async function mostrarFicha(pid, unica = false) {
  const p = await pessoa(pid);
  const r = resumo(p);
  if (!unica) $("#resultados").hidden = true;
  setStatus("");
  const ultimaEleicao = r.eleicoes[r.eleicoes.length - 1];
  const bensAnos = p.cands.filter((c) => c.bens !== null);
  const ultimoBens = [...bensAnos].reverse().find((c) => c.bens > 0);

  $("#ficha").innerHTML = `
    ${unica ? "" : `<button class="voltar" id="voltar">← voltar aos resultados</button>`}
    <div class="ficha-topo">
      <h2>${esc(cap(p.nome))}</h2>
      <div class="linha">${p.urnas.length ? `Nome de urna: ${p.urnas.map((u) => `“${esc(u)}”`).join(", ")}` : ""}
        ${p.anoNasc ? ` · nascimento: ${p.anoNasc}` : ""}${p.ocupacao ? ` · ocupação declarada: ${esc(cap(p.ocupacao))}` : ""}</div>
    </div>

    <div class="resumo">
      <div class="kpi"><div class="rot">Já foi candidato(a)?</div><div class="val">Sim, ${p.cands.length}×</div></div>
      <div class="kpi"><div class="rot">Já foi eleito(a)?</div><div class="val">${r.eleicoes.length ? `Sim, ${r.eleicoes.length}×` : "Não"}</div></div>
      <div class="kpi"><div class="rot">Último cargo para o qual foi eleito(a)</div><div class="val pequeno">${ultimaEleicao ? `${esc(cap(ultimaEleicao.cargo))} (${ultimaEleicao.ano})<br><span class="muted">${esc(cap(ultimaEleicao.local))}${ultimaEleicao.uf && ultimaEleicao.uf !== "BR" ? "/" + ultimaEleicao.uf : ""}</span>` : "—"}</div></div>
      <div class="kpi"><div class="rot">Patrimônio declarado mais recente</div><div class="val pequeno">${ultimoBens ? `${brl.format(ultimoBens.bens)} <span class="muted">(${ultimoBens.ano})</span>` : "—"}</div></div>
    </div>

    <div class="bloco">
      <h3>Partidos</h3>
      <div class="partidos">${r.partidos.map((x) => `<span class="partido" title="${esc(x.nome)}"><strong>${esc(x.sigla)}</strong> <small>${x.de === x.ate ? x.de : `${x.de}–${x.ate}`}</small></span>`).join("")}</div>
      <p class="nota">Partido pelo qual concorreu em cada eleição, em ordem cronológica.</p>
    </div>

    <div class="bloco">
      <h3>Evolução do patrimônio declarado</h3>
      ${graficoBens(bensAnos)}
    </div>

    <div class="bloco">
      <h3>Candidaturas</h3>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Ano</th><th>Cargo</th><th>Local</th><th>Partido</th><th>Resultado</th><th class="num">Bens declarados</th></tr></thead>
        <tbody>${[...p.cands].reverse().map(linhaCand).join("")}</tbody>
      </table></div>
      <p class="nota">Fonte: TSE. “2º turno” indica que a apuração final ainda não consta no arquivo daquele turno; situações como “indeferido” ou “renúncia” aparecem abaixo do resultado.</p>
    </div>`;
  const v = $("#voltar");
  if (v) v.onclick = () => history.back();
  window.scrollTo({ top: 0 });
}

function linhaCand(c) {
  const sit = c.situacao && !/^(APTO|DEFERIDO)/.test(c.situacao) ? `<div class="muted">${esc(cap(c.situacao))}</div>` : "";
  const res = c.resultado ? (c.eleito ? `<span class="selo ok" style="margin:0">${esc(cap(c.resultado))}</span>` : esc(cap(c.resultado))) : `<span class="muted">—</span>`;
  const bens = c.bens === null ? `<span class="muted">n/d</span>` : brl.format(c.bens);
  const local = c.uf === "BR" ? "Brasil" : `${cap(c.local)}${c.local && c.uf && normaliza(c.local) !== normaliza(c.uf) ? "/" + c.uf : ""}`;
  return `<tr class="${c.eleito ? "eleito" : ""}">
    <td>${c.ano}${c.eleicao ? `<div class="muted">${esc(cap(c.eleicao))}</div>` : ""}</td>
    <td>${esc(cap(c.cargo))}</td><td>${esc(local)}</td>
    <td title="${esc(c.nomePartido)}">${esc(c.sigla)}</td>
    <td>${res}${sit}</td><td class="num">${bens}</td></tr>`;
}

function graficoBens(cands) {
  // Um ponto por ano (se concorreu a mais de um cargo no mesmo ano, fica o maior valor).
  const porAno = new Map();
  for (const c of cands) porAno.set(c.ano, Math.max(porAno.get(c.ano) ?? 0, c.bens));
  const pts = [...porAno].sort((a, b) => a[0] - b[0]);
  if (!pts.length) return `<p class="muted">Sem declarações de bens disponíveis (o TSE publica bens a partir de 2006).</p>`;

  const W = 720, H = 240, M = { t: 24, r: 12, b: 28, l: 12 };
  const max = Math.max(...pts.map((p) => p[1]), 1);
  const bw = Math.min(64, (W - M.l - M.r) / pts.length * 0.6);
  const passo = (W - M.l - M.r) / pts.length;
  const barras = pts.map(([ano, v], i) => {
    const h = (v / max) * (H - M.t - M.b);
    const x = M.l + passo * i + (passo - bw) / 2;
    const y = H - M.b - h;
    return `<rect class="barra" x="${x}" y="${y}" width="${bw}" height="${Math.max(h, v > 0 ? 1 : 0)}" rx="3"><title>${ano}: ${brl.format(v)}</title></rect>
      <text class="valor" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${v ? "R$ " + brlCurto.format(v) : "R$ 0"}</text>
      <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${ano}</text>`;
  }).join("");

  let variacao = "";
  const validos = pts.filter((p) => p[1] > 0);
  if (validos.length >= 2) {
    const [a0, v0] = validos[0], [a1, v1] = validos[validos.length - 1];
    const pct = ((v1 / v0 - 1) * 100);
    variacao = `<p class="nota">De ${a0} para ${a1}: ${brl.format(v0)} → ${brl.format(v1)} (${pct >= 0 ? "+" : ""}${pct.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%, valores nominais sem correção pela inflação).</p>`;
  }
  return `<div class="grafico"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Patrimônio declarado por ano">
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
    if (!$("#resultados").innerHTML && q) await executarBusca(q);
    $("#resultados").hidden = true;
    return mostrarFicha(Number(p));
  }
  $("#resultados").hidden = false;
  $("#ficha").innerHTML = "";
  if (q) {
    if ($("#q").dataset.ultima !== q || !$("#resultados").innerHTML) {
      $("#q").dataset.ultima = q;
      await executarBusca(q);
    } else setStatus($("#status").dataset.anterior || "");
  } else {
    $("#resultados").innerHTML = "";
    setStatus("");
  }
}

async function iniciar() {
  try {
    META = await getJson("data/meta.json");
    $("#meta-info").textContent = `Base com ${META.pessoas.toLocaleString("pt-BR")} pessoas e ${META.candidaturas.toLocaleString("pt-BR")} candidaturas (${META.anos[0]}–${META.anos[META.anos.length - 1]}), atualizada em ${META.gerado_em.split("-").reverse().join("/")}.`;
  } catch (e) {
    return setStatus("Os dados ainda não foram gerados. Rode o workflow de build no GitHub Actions.", true);
  }
  $("#busca").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = $("#q").value.trim();
    location.hash = new URLSearchParams({ q }).toString();
  });
  $("#resultados").addEventListener("click", (ev) => {
    const b = ev.target.closest(".cartao");
    if (!b) return;
    $("#status").dataset.anterior = $("#status").textContent;
    const { q } = lerHash();
    location.hash = new URLSearchParams({ q, p: b.dataset.pid }).toString();
  });
  $("#home").addEventListener("click", (ev) => { ev.preventDefault(); location.hash = ""; $("#q").value = ""; $("#q").focus(); });
  window.addEventListener("hashchange", rotear);
  rotear();
}

iniciar();
