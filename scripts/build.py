#!/usr/bin/env python3
"""Gera os dados estáticos do Raio-X Político a partir dos arquivos do TSE.

Entrada: pasta com os .zip originais do Portal de Dados Abertos do TSE
  - consulta_cand_AAAA.zip  (candidaturas)
  - bem_candidato_AAAA.zip  (bens declarados, 2006 em diante)

Saída (pasta --out):
  - meta.json          tabelas de códigos (cargos, partidos, locais...) e estatísticas
  - idx/XXX.json       índice de busca: chave de nome -> lista de ids de pessoa
  - p/N.json           fichas das pessoas (256 por arquivo)

O CPF e o título de eleitor são usados para juntar as candidaturas da mesma
pessoa. Na saída pública o CPF aparece só MASCARADO (***.456.789-**, padrão do
Portal da Transparência) e o título de eleitor não aparece.
"""
import argparse
import glob
import json
import os
import re
import shutil
import time
import unicodedata
import urllib.request
import zipfile

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

NULOS = {"", "#NULO#", "#NULO", "#NE", "#NE#", "-1", "-3", "-4"}
STOP = {"DA", "DE", "DO", "DAS", "DOS", "E", "D", "DI", "DU"}
N_BUCKETS = 4096          # precisa bater com site/app.js
PESSOAS_POR_ARQUIVO = 256  # precisa bater com site/app.js
LIMITE_LISTA = 5000        # chaves com mais pessoas que isso viram só um contador

PESO_CARGO = {  # chaves normalizadas (sem acento/hífen)
    "PRESIDENTE": 9, "VICE PRESIDENTE": 8, "GOVERNADOR": 7, "SENADOR": 7,
    "VICE GOVERNADOR": 6, "DEPUTADO FEDERAL": 5, "PREFEITO": 4,
    "DEPUTADO ESTADUAL": 4, "DEPUTADO DISTRITAL": 4, "VICE PREFEITO": 3, "VEREADOR": 2,
}

TITULAR_DA_CHAPA = {  # cargo normalizado do vice/suplente -> cargo do titular
    "VICE PRESIDENTE": "PRESIDENTE", "VICE GOVERNADOR": "GOVERNADOR", "VICE PREFEITO": "PREFEITO",
    "O SUPLENTE": "SENADOR", "O SUPLENTE SENADOR": "SENADOR",  # "1º SUPLENTE" normaliza para "O SUPLENTE"
}

TITULARES = {"PRESIDENTE", "GOVERNADOR", "PREFEITO", "SENADOR"}

COLS_CAND = [
    "ANO_ELEICAO", "NM_TIPO_ELEICAO", "NR_TURNO", "CD_ELEICAO", "DS_ELEICAO",
    "SG_UF", "SG_UE", "NM_UE", "DS_CARGO", "SQ_CANDIDATO", "NR_CANDIDATO", "NM_CANDIDATO",
    "NM_URNA_CANDIDATO", "NR_CPF_CANDIDATO", "DS_SITUACAO_CANDIDATURA",
    "SG_PARTIDO", "NM_PARTIDO", "DT_NASCIMENTO", "NR_TITULO_ELEITORAL_CANDIDATO",
    "DS_OCUPACAO", "DS_SIT_TOT_TURNO",
    "DS_GENERO", "DS_GRAU_INSTRUCAO", "DS_COR_RACA", "SG_UF_NASCIMENTO",
    "DS_COMPOSICAO_COLIGACAO", "DS_COMPOSICAO_FEDERACAO",
]
COLS_BENS = ["SG_UE", "SQ_CANDIDATO", "VR_BEM_CANDIDATO", "DS_TIPO_BEM_CANDIDATO"]

# Categorias de bens exibidas no site (a ordem precisa bater com site/app.js).
CATEGORIAS = ["Imóveis", "Veículos", "Empresas e ações", "Aplicações e contas", "Dinheiro em espécie", "Outros"]
REGRAS_CATEGORIA = [  # (índice da categoria, regex sobre o tipo normalizado) — a primeira que casar vence
    (4, r"ESPECIE"),
    (2, r"QUOTA|QUINH|\bACOES\b|\bACAO\b|PARTICIPAC.*SOCIET|EMPRESA|CAPITAL SOCIAL|FIRMA INDIVIDUAL"),
    (1, r"VEICULO|AERONAVE|EMBARCAC|BARCO|LANCHA|NAVIO|MOTOCICL|CAMINH|AUTOMOVEL|TRATOR|ONIBUS"),
    (0, r"IMOVEL|IMOVEIS|CASA|APARTAMENTO|TERRENO|\bSALA\b|\bLOJA\b|PREDIO|GALPAO|CONSTRUC|BENFEITORIA"
        r"|FAZENDA|SITIO|CHACARA|TERRA NUA|GLEBA|RURAL|EDIFIC|HANGAR|GARAGEM|\bBOX\b|\bLOTE\b|RESIDENCIA"),
    (3, r"DEPOSITO|CONTA|POUPANCA|APLICAC|RENDA FIXA|RENDA VARIAVEL|FUNDO|TITULO|CREDITO|PREVIDENCIA|VGBL"
        r"|PGBL|CRIPTO|OURO|MOEDA|DEBENTURE|\bLCI\b|\bLCA\b|\bCDB\b|\bRDB\b|TESOURO|INVESTIMENTO|CONSORCIO"
        r"|EMPRESTIMO|ATIVO"),
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def normaliza(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().upper()
    return " ".join(re.sub(r"[^A-Z]+", " ", s).split())


def tokens(nome_norm):
    return [t for t in nome_norm.split() if t not in STOP]


def fnv1a(s):
    h = 0x811C9DC5
    for b in s.encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def ano_do_arquivo(caminho):
    return int(re.search(r"(\d{4})\.zip$", caminho).group(1))


class Tabela:
    """Dicionário valor -> código inteiro. O código 0 é sempre o valor vazio."""

    def __init__(self):
        self.idx = {"": 0}
        self.itens = [""]

    def codifica(self, serie):
        for v in pd.unique(serie):
            if v not in self.idx:
                self.idx[v] = len(self.itens)
                self.itens.append(v)
        return serie.map(self.idx).to_numpy(np.int32)


def ler_csv(caminho, colunas):
    """Lê o CSV nacional (_BRASIL.csv) do zip; sem ele, junta os CSVs por UF."""
    with zipfile.ZipFile(caminho) as z:
        nomes = [n for n in z.namelist() if n.lower().endswith(".csv")]
        alvo = [n for n in nomes if n.upper().endswith("_BRASIL.CSV")] or nomes
        partes = []
        for n in alvo:
            with z.open(n) as f:
                partes.append(pd.read_csv(
                    f, sep=";", encoding="latin-1", dtype=str, keep_default_na=False,
                    usecols=lambda c: c in colunas, on_bad_lines="warn",
                ))
    df = pd.concat(partes, ignore_index=True)
    faltando = set(colunas) - set(df.columns)
    if faltando:
        raise SystemExit(f"{caminho}: colunas ausentes {sorted(faltando)}")
    for c in colunas:
        s = df[c].str.strip()
        df[c] = s.where(~s.isin(NULOS), "")
    return df


def para_reais(s):
    """'112000,00' -> 112000.0 (aceita também ponto como separador decimal)."""
    virgula = s.str.contains(",", regex=False)
    conv = s.where(~virgula, s.str.replace(".", "", regex=False).str.replace(",", ".", regex=False))
    return pd.to_numeric(conv, errors="coerce").fillna(0.0)


def categoria_bem(tipo):
    n = normaliza(tipo)
    for cat, rx in REGRAS_CATEGORIA:
        if re.search(rx, n):
            return cat
    return len(CATEGORIAS) - 1


def carregar_bens(raw, anos):
    """Por ano: DataFrame indexado por 'SG_UE|SQ_CANDIDATO' com colunas total, c0..c5 (categorias)."""
    bens = {}
    outros = pd.Series(dtype=float)
    for caminho in sorted(glob.glob(os.path.join(raw, "bem_candidato_*.zip"))):
        ano = ano_do_arquivo(caminho)
        if anos and ano not in anos:
            continue
        df = ler_csv(caminho, COLS_BENS)
        df["v"] = para_reais(df["VR_BEM_CANDIDATO"])
        cats = {t: categoria_bem(t) for t in pd.unique(df["DS_TIPO_BEM_CANDIDATO"])}
        df["cat"] = df["DS_TIPO_BEM_CANDIDATO"].map(cats)
        chave = df["SG_UE"] + "|" + df["SQ_CANDIDATO"]
        tabela = df.pivot_table(index=chave, columns="cat", values="v", aggfunc="sum", fill_value=0.0)
        tabela = tabela.reindex(columns=range(len(CATEGORIAS)), fill_value=0.0)
        tabela.columns = [f"c{i}" for i in tabela.columns]
        tabela["total"] = tabela.sum(axis=1)
        bens[ano] = tabela
        por_cat = df.groupby("cat")["v"].sum() / max(df["v"].sum(), 1)
        partes = ", ".join(f"{CATEGORIAS[i]} {por_cat.get(i, 0):.0%}" for i in range(len(CATEGORIAS)))
        log(f"bens {ano}: {len(df):,} itens, {len(tabela):,} candidaturas | {partes}")
        o = df[df["cat"] == len(CATEGORIAS) - 1].groupby("DS_TIPO_BEM_CANDIDATO")["v"].sum()
        outros = outros.add(o, fill_value=0)
    if len(outros):
        log("tipos classificados como 'Outros' (maiores valores):")
        for t, v in outros.sort_values(ascending=False).head(25).items():
            log(f"    R$ {v:>18,.0f}  {t}")
    return bens


def carregar_correcoes():
    caminho = os.path.join(os.path.dirname(os.path.abspath(__file__)), "correcoes.csv")
    return pd.read_csv(caminho, sep=";", dtype=str, comment="#", keep_default_na=False)


def completar_resultados(df, ano, correcoes):
    """Preenche resultados que o TSE deixou em branco.

    1. Correções manuais (scripts/correcoes.csv) para titulares sem resultado.
    2. Vices e suplentes herdam o resultado do titular da chapa (mesmo número, mesma UE).
    """
    res = df["DS_SIT_TOT_TURNO"].copy()
    for c in correcoes[correcoes["ano"] == str(ano)].itertuples():
        alvo = (df["DS_CARGO"] == c.cargo) & (df["SG_UE"] == c.sg_ue) & (res == "")
        if c.nr_candidato != "*":
            alvo &= df["NR_CANDIDATO"] == c.nr_candidato
        res[alvo] = c.resultado
    cargo_norm = df["DS_CARGO"].map(normaliza)
    titular = cargo_norm.map(TITULAR_DA_CHAPA)
    chave = df["SG_UE"] + "|" + df["NR_CANDIDATO"] + "|"
    titulares = res[titular.isna() & (res != "")]
    mapa = pd.Series(titulares.to_numpy(), index=(chave + cargo_norm)[titulares.index]).groupby(level=0).last()
    herdar = titular.notna() & (res == "")
    res[herdar] = (chave + titular)[herdar].map(mapa).fillna("")
    # Suplente de senador não assume o mandato só por a chapa vencer.
    suplente_eleito = herdar & (titular == "SENADOR") & res.str.startswith("ELEITO")
    res[suplente_eleito] = "SUPLENTE (CHAPA ELEITA)"
    df["DS_SIT_TOT_TURNO"] = res
    return int(herdar.sum() - (res[herdar] == "").sum())


def carregar_candidaturas(raw, anos, bens, tab):
    correcoes = carregar_correcoes()
    blocos = []
    for caminho in sorted(glob.glob(os.path.join(raw, "consulta_cand_*.zip"))):
        ano = ano_do_arquivo(caminho)
        if anos and ano not in anos:
            continue
        df = ler_csv(caminho, COLS_CAND)
        # Quem foi ao 2º turno aparece duas vezes (o CD_ELEICAO muda entre turnos);
        # fica a linha do último turno. Em anos antigos o SQ_CANDIDATO só é único
        # dentro da unidade eleitoral, por isso a chave inclui SG_UE e cargo.
        df["_turno"] = pd.to_numeric(df["NR_TURNO"], errors="coerce").fillna(1)
        df = (df.sort_values("_turno", kind="stable")
                .drop_duplicates(["SG_UE", "DS_CARGO", "SQ_CANDIDATO"], keep="last")
                .reset_index(drop=True))
        herdados = completar_resultados(df, ano, correcoes)
        suplementar = df["NM_TIPO_ELEICAO"].str.upper().str.contains("SUPLEMENTAR")
        eleicao = df["DS_ELEICAO"].where(suplementar, "")
        n_cat = len(CATEGORIAS)
        if ano in bens:
            b = bens[ano].reindex(df["SG_UE"] + "|" + df["SQ_CANDIDATO"]).fillna(0.0)
            valor = b["total"].to_numpy()
            por_cat = [b[f"c{i}"].to_numpy() for i in range(n_cat)]
            com_bens = (valor > 0).mean()
        else:
            valor = np.full(len(df), np.nan)
            por_cat = [np.zeros(len(df)) for _ in range(n_cat)]
            com_bens = None
        # Coligação/federação: só para cargos majoritários (titulares) e deputados, para
        # não multiplicar o tamanho com as milhares de coligações municipais de vereador.
        cargo_norm = df["DS_CARGO"].map(normaliza)
        com_colig = ~cargo_norm.isin(["VEREADOR", *TITULAR_DA_CHAPA])
        composicao = df["DS_COMPOSICAO_COLIGACAO"].where(df["DS_COMPOSICAO_COLIGACAO"] != "",
                                                         df["DS_COMPOSICAO_FEDERACAO"])
        composicao = composicao.where(com_colig & composicao.str.contains("/", regex=False), "")
        extras = {f"b{i}": por_cat[i] for i in range(n_cat)}
        blocos.append(pd.DataFrame({
            **extras,
            "genero": tab["genero"].codifica(df["DS_GENERO"]),
            "instrucao": tab["instrucao"].codifica(df["DS_GRAU_INSTRUCAO"]),
            "cor": tab["cor"].codifica(df["DS_COR_RACA"]),
            "uf_nasc": df["SG_UF_NASCIMENTO"].to_numpy(),
            "coligacao": composicao.str.replace(r"\s*/\s*", " / ", regex=True).to_numpy(),
            "ano": np.full(len(df), ano, np.int16),
            "eleicao": tab["eleicao"].codifica(eleicao),
            "cargo": tab["cargo"].codifica(df["DS_CARGO"]),
            "ue": tab["ue"].codifica(df["SG_UF"] + "|" + df["NM_UE"]),
            "partido": tab["partido"].codifica(df["SG_PARTIDO"] + "|" + df["NM_PARTIDO"]),
            "situacao": tab["situacao"].codifica(df["DS_SITUACAO_CANDIDATURA"]),
            "resultado": tab["resultado"].codifica(df["DS_SIT_TOT_TURNO"]),
            "ocupacao": tab["ocupacao"].codifica(df["DS_OCUPACAO"]),
            "bens": valor,
            "nome": df["NM_CANDIDATO"].to_numpy(),
            "urna": df["NM_URNA_CANDIDATO"].to_numpy(),
            "cpf": df["NR_CPF_CANDIDATO"].to_numpy(),
            "titulo": df["NR_TITULO_ELEITORAL_CANDIDATO"].to_numpy(),
            "nasc": df["DT_NASCIMENTO"].to_numpy(),
            "sg_ue": df["SG_UE"].to_numpy(),
            "nr": df["NR_CANDIDATO"].to_numpy(),
        }))
        extra = f", {com_bens:.0%} com bens declarados" if com_bens is not None else ""
        log(f"candidaturas {ano}: {len(df):,}{extra}, {herdados:,} resultados de vice/suplente herdados do titular")
    return pd.concat(blocos, ignore_index=True)


def cpf_valido(cpf):
    return cpf.str.fullmatch(r"\d{11}") & ~cpf.str.fullmatch(r"(\d)\1{10}")


def mascarar_cpf(cpf):
    """'12345678901' -> '***.456.789-**' (padrão do Portal da Transparência)."""
    mask = "***." + cpf.str[3:6] + "." + cpf.str[6:9] + "-**"
    return mask.where(cpf_valido(cpf), "")


def agrupar_pessoas(df):
    """Junta candidaturas da mesma pessoa por CPF, título de eleitor ou nome+nascimento."""
    n = len(df)
    cache = {v: normaliza(v) for v in pd.unique(df["nome"])}
    nome_norm = df["nome"].map(cache)
    cpf, nasc = df["cpf"], df["nasc"]
    titulo = df["titulo"].str.lstrip("0")
    ok_cpf = cpf_valido(cpf)
    ok_tit = titulo.str.fullmatch(r"\d{6,12}")
    ok_nasc = nasc.str.fullmatch(r"\d{2}/\d{2}/(19\d{2}|20[01]\d)") & (nome_norm.str.len() > 0)
    chaves = pd.concat([
        ("C" + cpf)[ok_cpf],
        ("T" + titulo)[ok_tit],
        ("N" + nome_norm + "|" + nasc)[ok_nasc],
    ])
    e = pd.DataFrame({"k": chaves.to_numpy(), "r": chaves.index.to_numpy()})
    # Uma chave ligada a pessoas com 3+ primeiros nomes diferentes é erro de cadastro: descarta.
    e["p"] = nome_norm.str.split(" ", n=1).str[0].to_numpy()[e["r"].to_numpy()]
    nun = e.groupby("k")["p"].nunique()
    ruins = nun.index[nun > 2]
    if len(ruins):
        log(f"chaves descartadas por conflito: {len(ruins):,}")
        e = e[~e["k"].isin(ruins)]
    cod, uniq = pd.factorize(e["k"])
    total = n + len(uniq)
    m = coo_matrix((np.ones(len(e), np.int8), (e["r"].to_numpy(), cod + n)), shape=(total, total))
    _, rot = connected_components(m, directed=False)
    return rot[:n], nome_norm


def montar_chapas(df, tab):
    """Companheiros de chapa de cada candidatura majoritária.

    Titular (presidente, governador, prefeito, senador), vice e suplentes da mesma
    chapa têm o mesmo número na mesma UE e eleição. Retorna {linha: [[pid, cargo, nome], ...]}.
    Espera df ordenado e com índice 0..n-1.
    """
    titular_de = []
    for c in tab["cargo"].itens:
        n = normaliza(c)
        titular_de.append(TITULAR_DA_CHAPA.get(n, n if n in TITULARES else ""))
    titular = np.array(titular_de, dtype=object)[df["cargo"].to_numpy()]
    ok = (titular != "") & (df["nr"].to_numpy() != "")
    sub = df.loc[ok, ["ano", "eleicao", "sg_ue", "nr", "pid", "cargo", "nome"]]
    chave = (sub["ano"].astype(str) + "|" + sub["eleicao"].astype(str) + "|" + sub["sg_ue"]
             + "|" + sub["nr"] + "|" + titular[ok])
    pid, cargo, nome = df["pid"].to_numpy(), df["cargo"].to_numpy(), df["nome"].to_numpy()
    linha_df = sub.index.to_numpy()
    chapas = {}
    for linhas in sub.groupby(chave.to_numpy()).indices.values():
        if not 2 <= len(linhas) <= 5:  # grupos maiores indicam número repetido/erro de cadastro
            continue
        idx = linha_df[linhas]
        membros = [[int(pid[j]), int(cargo[j]), nome[j]] for j in idx]
        for k, j in enumerate(idx):
            outros = [m for n, m in enumerate(membros) if n != k and m[0] != membros[k][0]]
            if outros:
                chapas[int(j)] = outros
    return chapas


def percentis_eleitos(df, foi_eleito):
    """Percentis 0..100 do patrimônio declarado dos eleitos, por ano e cargo ("ano|código do cargo").

    Usado no site para frases como "maior que o de 92% dos deputados federais eleitos em 2022".
    """
    el = foi_eleito[df["resultado"].to_numpy()] & ~np.isnan(df["bens"].to_numpy())
    sub = df.loc[el, ["ano", "cargo", "bens"]]
    out = {}
    for (ano, cargo), g in sub.groupby(["ano", "cargo"]):
        if len(g) >= 20:
            out[f"{ano}|{cargo}"] = [int(round(x)) for x in np.percentile(g["bens"].to_numpy(), range(101))]
    log(f"percentis de patrimônio: {len(out)} grupos ano/cargo")
    return out


def carregar_ipca():
    """Número-índice do IPCA (IBGE/SIDRA) de outubro de cada ano + o mês mais recente.

    Tenta a API do IBGE; se falhar, usa scripts/ipca.json (cópia versionada).
    """
    reserva = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipca.json")
    try:
        url = "https://apisidra.ibge.gov.br/values/t/1737/n1/all/v/2266/p/all?formato=json"
        with urllib.request.urlopen(url, timeout=60) as r:
            linhas = json.load(r)[1:]
        indices = {x["D3C"]: float(x["V"]) for x in linhas if re.fullmatch(r"[0-9.]+", x["V"])}
        log(f"IPCA: {len(indices)} meses via API do IBGE")
    except Exception as e:  # noqa: BLE001 — qualquer falha de rede cai na cópia local
        with open(reserva, encoding="utf-8") as f:
            indices = json.load(f)["indices"]
        log(f"IPCA: API indisponível ({e}); usando cópia local com {len(indices)} meses")
    ultimo = max(indices)
    return {
        "outubro": {k[:4]: v for k, v in indices.items() if k.endswith("10") and k >= "1994"},
        "ref_mes": ultimo,
        "ref_indice": indices[ultimo],
    }


def chaves_busca(nome_norm, urnas_norm):
    ks = set()
    t = tokens(nome_norm)
    for x in t[1:]:
        ks.add(t[0] + " " + x)
    for u in urnas_norm:
        tu = tokens(u)
        ks.update(tu)
        for x in tu[1:]:
            ks.add(tu[0] + " " + x)
    return ks


def gerar(df, rot, nome_norm, tab, out):
    df["pessoa"] = rot
    df["nome_norm"] = nome_norm.to_numpy()
    df = df.sort_values(["pessoa", "ano"], kind="stable")
    ultima = df.groupby("pessoa", sort=False).tail(1)
    ordem = ultima.sort_values(["nome_norm", "nasc"], kind="stable")["pessoa"].to_numpy()
    pid_de = np.empty(rot.max() + 1, np.int64)
    pid_de[ordem] = np.arange(len(ordem))
    df["pid"] = pid_de[df["pessoa"].to_numpy()]
    df = df.sort_values(["pid", "ano", "cargo"], kind="stable").reset_index(drop=True)
    n_pessoas = len(ordem)
    maior = np.bincount(df["pid"].to_numpy()).max()
    log(f"pessoas: {n_pessoas:,} | candidaturas: {len(df):,} | maior grupo: {maior} candidaturas")

    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, "p"))
    os.makedirs(os.path.join(out, "idx"))

    n_cat = len(CATEGORIAS)
    col = {c: df[c].to_numpy() for c in
           ["pid", "ano", "eleicao", "cargo", "ue", "partido", "situacao", "resultado",
            "ocupacao", "bens", "nome", "urna", "nasc", "nome_norm", "cpf_mask",
            "genero", "instrucao", "cor", "uf_nasc", "coligacao", *[f"b{i}" for i in range(n_cat)]]}
    inicios = np.flatnonzero(np.r_[True, col["pid"][1:] != col["pid"][:-1]])
    fins = np.r_[inicios[1:], len(df)]

    # Relevância usada para ordenar as listas do índice: cargo mais alto em que foi
    # eleito(a), depois número de vitórias, depois número de candidaturas.
    peso_cargo = np.array([PESO_CARGO.get(normaliza(c), 1) for c in tab["cargo"].itens])
    foi_eleito = np.array([bool(re.match(r"ELEITO|MEDIA$", normaliza(r))) for r in tab["resultado"].itens])
    relevancia = [0] * n_pessoas
    chapas = montar_chapas(df, tab)
    log(f"candidaturas com companheiros de chapa: {len(chapas):,}")

    buckets = [dict() for _ in range(N_BUCKETS)]
    lote = []
    for pid, (a, b) in enumerate(zip(inicios, fins)):
        el = foi_eleito[col["resultado"][a:b]]
        melhor = int(peso_cargo[col["cargo"][a:b]][el].max()) if el.any() else 0
        relevancia[pid] = melhor * 1_000_000 + int(el.sum()) * 1_000 + int(b - a)
        urnas = []
        for u in col["urna"][a:b][::-1]:
            if u and u not in urnas:
                urnas.append(u)
        nasc_validos = [x for x in col["nasc"][a:b][::-1] if re.fullmatch(r"\d{2}/\d{2}/\d{4}", x)]
        ano_nasc = int(nasc_validos[0][-4:]) if nasc_validos else None
        ocup = next((int(o) for o in col["ocupacao"][a:b][::-1] if o), 0)
        cands = []
        for i in range(a, b):
            v = col["bens"][i]
            tem_bens = not np.isnan(v) and v > 0
            # Posições (site/app.js): 0 ano, 1 cargo, 2 local, 3 partido, 4 situação, 5 resultado,
            # 6 bens (total), 7 eleição suplementar, 8 chapa, 9 bens por categoria, 10 ocupação, 11 coligação.
            cand = [
                int(col["ano"][i]), int(col["cargo"][i]), int(col["ue"][i]), int(col["partido"][i]),
                int(col["situacao"][i]), int(col["resultado"][i]),
                None if np.isnan(v) else int(round(v)), int(col["eleicao"][i]),
                chapas.get(i),
                [int(round(col[f"b{k}"][i])) for k in range(n_cat)] if tem_bens else None,
                int(col["ocupacao"][i]),
                col["coligacao"][i],
            ]
            while len(cand) > 8 and cand[-1] in (None, "", 0):  # corta campos finais vazios
                cand.pop()
            cands.append(cand)
        # CPF mascarado da candidatura mais recente que o tenha (em 2024 o TSE não divulgou CPF)
        cpf_mask = next((c for c in col["cpf_mask"][a:b][::-1] if c), None)
        perfil = [
            next((int(x) for x in col[c][a:b][::-1] if x), 0) for c in ("genero", "instrucao", "cor")
        ] + [next((x for x in col["uf_nasc"][a:b][::-1] if x), "")]
        lote.append([col["nome"][b - 1], urnas[:5], ano_nasc, ocup, cands, cpf_mask, perfil])

        urnas_norm = {normaliza(u) for u in urnas}
        for k in chaves_busca(col["nome_norm"][b - 1], urnas_norm):
            balde = buckets[fnv1a(k) % N_BUCKETS]
            lista = balde.get(k)
            if lista is None:
                balde[k] = [pid]
            elif isinstance(lista, list):
                lista.append(pid)
                if len(lista) > LIMITE_LISTA:
                    balde[k] = len(lista)
            else:
                balde[k] = lista + 1

        if len(lote) == PESSOAS_POR_ARQUIVO or pid == n_pessoas - 1:
            with open(os.path.join(out, "p", f"{pid // PESSOAS_POR_ARQUIVO}.json"), "w", encoding="utf-8") as f:
                json.dump(lote, f, ensure_ascii=False, separators=(",", ":"))
            lote = []
        if pid and pid % 500_000 == 0:
            log(f"  {pid:,} pessoas gravadas")

    for i, balde in enumerate(buckets):
        for k, lista in balde.items():
            if isinstance(lista, list) and len(lista) > 1:
                lista.sort(key=lambda p: -relevancia[p])
        with open(os.path.join(out, "idx", f"{i:03x}.json"), "w", encoding="utf-8") as f:
            json.dump(balde, f, separators=(",", ":"))

    anos = sorted(int(a) for a in np.unique(col["ano"]))
    meta = {
        "gerado_em": time.strftime("%Y-%m-%d"),
        "versao": time.strftime("%Y%m%d%H%M%S"),  # usada pelo site para invalidar cache
        "fonte": "Portal de Dados Abertos do TSE — https://dadosabertos.tse.jus.br",
        "anos": anos,
        "pessoas": n_pessoas,
        "candidaturas": int(len(df)),
        "n_buckets": N_BUCKETS,
        "por_arquivo": PESSOAS_POR_ARQUIVO,
        "tabelas": {k: t.itens for k, t in tab.items()},
        "categorias_bens": CATEGORIAS,
        "percentis": percentis_eleitos(df, foi_eleito),
        "ipca": carregar_ipca(),
    }
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    log("pronto")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, help="pasta com os .zip do TSE")
    ap.add_argument("--out", required=True, help="pasta de saída (será recriada)")
    ap.add_argument("--anos", default="", help="restringe a alguns anos, ex.: 2020,2022,2024")
    args = ap.parse_args()
    anos = {int(a) for a in args.anos.split(",") if a.strip()}

    tab = {k: Tabela() for k in ["eleicao", "cargo", "ue", "partido", "situacao", "resultado", "ocupacao",
                                 "genero", "instrucao", "cor"]}
    bens = carregar_bens(args.raw, anos)
    df = carregar_candidaturas(args.raw, anos, bens, tab)
    del bens
    rot, nome_norm = agrupar_pessoas(df)
    df["cpf_mask"] = mascarar_cpf(df["cpf"])
    df = df.drop(columns=["cpf", "titulo"])  # CPF completo e título não saem daqui
    gerar(df, rot, nome_norm, tab, args.out)


if __name__ == "__main__":
    main()
