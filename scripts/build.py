#!/usr/bin/env python3
"""Gera os dados estáticos do Raio-X Político a partir dos arquivos do TSE.

Entrada: pasta com os .zip originais do Portal de Dados Abertos do TSE
  - consulta_cand_AAAA.zip  (candidaturas)
  - bem_candidato_AAAA.zip  (bens declarados, 2006 em diante)

Saída (pasta --out):
  - meta.json          tabelas de códigos (cargos, partidos, locais...) e estatísticas
  - idx/XXX.json       índice de busca: chave de nome -> lista de ids de pessoa
  - p/N.json           fichas das pessoas (256 por arquivo)

O CPF e o título de eleitor são usados apenas para juntar as candidaturas
da mesma pessoa e NÃO são gravados na saída.
"""
import argparse
import glob
import json
import os
import re
import shutil
import time
import unicodedata
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

COLS_CAND = [
    "ANO_ELEICAO", "NM_TIPO_ELEICAO", "NR_TURNO", "CD_ELEICAO", "DS_ELEICAO",
    "SG_UF", "SG_UE", "NM_UE", "DS_CARGO", "SQ_CANDIDATO", "NM_CANDIDATO",
    "NM_URNA_CANDIDATO", "NR_CPF_CANDIDATO", "DS_SITUACAO_CANDIDATURA",
    "SG_PARTIDO", "NM_PARTIDO", "DT_NASCIMENTO", "NR_TITULO_ELEITORAL_CANDIDATO",
    "DS_OCUPACAO", "DS_SIT_TOT_TURNO",
]
COLS_BENS = ["SG_UE", "SQ_CANDIDATO", "VR_BEM_CANDIDATO"]


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


def carregar_bens(raw, anos):
    bens = {}
    for caminho in sorted(glob.glob(os.path.join(raw, "bem_candidato_*.zip"))):
        ano = ano_do_arquivo(caminho)
        if anos and ano not in anos:
            continue
        df = ler_csv(caminho, COLS_BENS)
        df["v"] = para_reais(df["VR_BEM_CANDIDATO"])
        bens[ano] = df.groupby(df["SG_UE"] + "|" + df["SQ_CANDIDATO"])["v"].sum()
        log(f"bens {ano}: {len(df):,} itens, {len(bens[ano]):,} candidaturas")
    return bens


def carregar_candidaturas(raw, anos, bens, tab):
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
        suplementar = df["NM_TIPO_ELEICAO"].str.upper().str.contains("SUPLEMENTAR")
        eleicao = df["DS_ELEICAO"].where(suplementar, "")
        if ano in bens:
            valor = (df["SG_UE"] + "|" + df["SQ_CANDIDATO"]).map(bens[ano]).fillna(0.0).to_numpy()
            com_bens = (valor > 0).mean()
        else:
            valor = np.full(len(df), np.nan)
            com_bens = None
        blocos.append(pd.DataFrame({
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
        }))
        extra = f", {com_bens:.0%} com bens declarados" if com_bens is not None else ""
        log(f"candidaturas {ano}: {len(df):,}{extra}")
    return pd.concat(blocos, ignore_index=True)


def agrupar_pessoas(df):
    """Junta candidaturas da mesma pessoa por CPF, título de eleitor ou nome+nascimento."""
    n = len(df)
    cache = {v: normaliza(v) for v in pd.unique(df["nome"])}
    nome_norm = df["nome"].map(cache)
    cpf, nasc = df["cpf"], df["nasc"]
    titulo = df["titulo"].str.lstrip("0")
    ok_cpf = cpf.str.fullmatch(r"\d{11}") & ~cpf.str.fullmatch(r"(\d)\1{10}")
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

    col = {c: df[c].to_numpy() for c in
           ["pid", "ano", "eleicao", "cargo", "ue", "partido", "situacao", "resultado",
            "ocupacao", "bens", "nome", "urna", "nasc", "nome_norm"]}
    inicios = np.flatnonzero(np.r_[True, col["pid"][1:] != col["pid"][:-1]])
    fins = np.r_[inicios[1:], len(df)]

    # Relevância usada para ordenar as listas do índice: cargo mais alto em que foi
    # eleito(a), depois número de vitórias, depois número de candidaturas.
    peso_cargo = np.array([PESO_CARGO.get(normaliza(c), 1) for c in tab["cargo"].itens])
    foi_eleito = np.array([bool(re.match(r"ELEITO|MEDIA$", normaliza(r))) for r in tab["resultado"].itens])
    relevancia = [0] * n_pessoas

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
            cands.append([
                int(col["ano"][i]), int(col["cargo"][i]), int(col["ue"][i]), int(col["partido"][i]),
                int(col["situacao"][i]), int(col["resultado"][i]),
                None if np.isnan(v) else int(round(v)), int(col["eleicao"][i]),
            ])
        lote.append([col["nome"][b - 1], urnas[:5], ano_nasc, ocup, cands])

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

    tab = {k: Tabela() for k in ["eleicao", "cargo", "ue", "partido", "situacao", "resultado", "ocupacao"]}
    bens = carregar_bens(args.raw, anos)
    df = carregar_candidaturas(args.raw, anos, bens, tab)
    del bens
    rot, nome_norm = agrupar_pessoas(df)
    df = df.drop(columns=["cpf", "titulo"])
    gerar(df, rot, nome_norm, tab, args.out)


if __name__ == "__main__":
    main()
