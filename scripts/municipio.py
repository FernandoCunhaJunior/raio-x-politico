"""Página por município (municipio.html): um arquivo por município + índice por UF (chamado por build.py).

Saída em OUT/municipio/:
  - UF.json            [[código TSE, nome, eleitorado, [ano, sigla, nome de urna, pid] do prefeito eleito mais recente], ...]
  - UF/gAAAA.json      candidatos das eleições gerais da UF (e de presidente): [[pid, nome de urna, sigla, cargo, res, número], ...]
  - UF/CODIGO.json     {"c", "n", "uf",
                        "m": {ano: {"pref": [...], "ver": {"el": [...], "outros": [...], "n": total, "part": [...]}}},
                        "g": {ano: {"cargo": {"turno": [[índice em gAAAA, votos], ...]}}, "gv": {ano: {"cargo": {"turno": válidos}}}},
                        "p": {ano: {"turno": [aptos, comparecimento, abstenções, válidos, brancos, nulos]}}}
Candidatura municipal: [pid, nome de urna, sigla, número, res, votos 1º turno, % 1º, votos 2º turno, % 2º]
res: "E" eleito, "S" suplente, "N" não eleito, "2" foi ao 2º turno, "B" candidatura barrada/inapta, "" sem resultado.
"""
import json
import os
import re
import zipfile

import numpy as np
import pandas as pd

CARGOS_MUN = {"PREFEITO": "pref", "VEREADOR": "ver"}
CARGOS_GERAIS = {"PRESIDENTE": 1, "GOVERNADOR": 3, "SENADOR": 5, "DEPUTADO FEDERAL": 6, "DEPUTADO ESTADUAL": 7,
                 "DEPUTADO DISTRITAL": 8}
COD_PARA_CARGO = {v: k for k, v in CARGOS_GERAIS.items()}
ANO_TODOS_VEREADORES = 2020  # a partir daqui guarda todos os candidatos a vereador; antes, só os eleitos (limite de tamanho do site)


def _res(resultado, situacao, normaliza):
    r, s = normaliza(resultado), normaliza(situacao)
    if re.match(r"ELEITO|MEDIA$", r):
        return "E"
    if "TURNO" in r:
        return "2"
    if r.startswith("SUPLENTE"):
        return "S"
    if s and not re.match(r"APTO|DEFERIDO", s):
        return "B"
    if r.startswith("NAO ELEITO"):
        return "N"
    return ""


def _ler_zip(caminho, nome):
    with zipfile.ZipFile(caminho) as z:
        if nome not in z.namelist():
            return None
        return pd.read_csv(z.open(nome), sep=";", dtype={"SG_UF": str, "CD_MUNICIPIO": str, "SQ_CANDIDATO": str,
                                                        "NM_MUNICIPIO": str})


def gerar_municipios(df, tab, out, raw, ctx):
    normaliza, log, cap = ctx["normaliza"], ctx["log"], ctx["cap"]
    cargos = np.array([normaliza(c) for c in tab["cargo"].itens], dtype=object)
    ck = cargos[df["cargo"].to_numpy()]
    ordinaria = df["eleicao"].to_numpy() == 0
    siglas = [p.split("|")[0] for p in tab["partido"].itens]
    res_txt = tab["resultado"].itens
    sit_txt = tab["situacao"].itens
    nomes_ue = [x.split("|")[1] if "|" in x else x for x in tab["ue"].itens]

    base = df.loc[ordinaria, ["pid", "ano", "uf", "sg_ue", "ue", "partido", "resultado", "situacao", "urna", "nome",
                              "nr", "sq", "votacao"]].copy()
    base["ck"] = ck[ordinaria]
    base["ano"] = base["ano"].astype(int)
    base["sigla"] = [siglas[p] for p in base["partido"]]
    base["res"] = [_res(res_txt[r], sit_txt[s], normaliza) for r, s in zip(base["resultado"], base["situacao"])]
    base["urna"] = [u or n for u, n in zip(base["urna"], base["nome"])]

    def votos_turno(v, t):
        if isinstance(v, list):
            for x in v:
                if x[0] == t:
                    return [x[1], x[2]]
        return [None, None]

    municipios = {}  # (uf, cod) -> dict

    def mun(uf, cod, nome):
        m = municipios.get((uf, cod))
        if m is None:
            m = municipios[(uf, cod)] = {"c": cod, "n": nome, "uf": uf, "m": {}, "g": {}, "gv": {}, "p": {}}
        elif nome and not m["n"]:
            m["n"] = nome
        return m

    # 1) Eleições municipais: prefeito e vereador de cada município
    mun_rows = base[base["ck"].isin(list(CARGOS_MUN))]
    for (ano, uf, cod), g in mun_rows.groupby(["ano", "uf", "sg_ue"], sort=False):
        nome = nomes_ue[int(g["ue"].iloc[0])]
        m = mun(uf, cod, nome)
        bloco = m["m"].setdefault(str(ano), {})
        for c, chave in CARGOS_MUN.items():
            x = g[g["ck"] == c]
            if not len(x):
                continue
            linhas = []
            for r in x.itertuples(index=False):
                v1, v2 = votos_turno(r.votacao, 1), votos_turno(r.votacao, 2)
                linha = [int(r.pid), r.urna, r.sigla, r.nr, r.res, v1[0], v1[1]]
                if v2[0] is not None:
                    linha += [v2[0], v2[1]]
                while linha and linha[-1] is None:
                    linha.pop()
                linhas.append(linha)
            linhas.sort(key=lambda l: (-(l[5] or 0) if len(l) > 5 else 0, l[4] != "E", l[1]))
            if chave == "pref":
                bloco["pref"] = linhas
            else:
                partidos = {}
                for l in linhas:
                    p = partidos.setdefault(l[2], [l[2], 0, 0, 0])
                    p[1] += 1
                    p[2] += l[4] == "E"
                    p[3] += (l[5] or 0) if len(l) > 5 else 0
                eleitos = [l for l in linhas if l[4] == "E"]
                outros = [l for l in linhas if l[4] != "E"] if ano >= ANO_TODOS_VEREADORES else []
                bloco["ver"] = {"el": eleitos, "outros": outros, "n": len(linhas),
                                "part": sorted(partidos.values(), key=lambda p: (-p[2], -p[3], -p[1]))}

    # 2) Eleições gerais: votação no município (arquivo municipio_AAAA.zip) + participação (todos os anos)
    gerais = base[base["ck"].isin(list(CARGOS_GERAIS))]
    dicionarios = {}  # (uf, ano) -> ([linhas], {sq: índice})
    anos = sorted(int(a) for a in base["ano"].unique())
    for ano in anos:
        caminho = os.path.join(raw, f"municipio_{ano}.zip")
        if not os.path.exists(caminho):
            continue
        part = _ler_zip(caminho, "part.csv")
        principal = 11 if ano % 4 == 0 else 1
        if part is not None:
            for r in part.itertuples(index=False):
                if r.SG_UF == "ZZ":
                    continue
                cod = str(r.CD_MUNICIPIO).zfill(5)
                cargo = int(r.CD_CARGO)
                m = municipios.get((r.SG_UF, cod))
                if m is None:
                    if ano % 4 == 0:
                        continue
                    m = mun(r.SG_UF, cod, r.NM_MUNICIPIO)
                alvo = m["p"].setdefault(str(ano), {})
                # cargo principal: prefeito (municipal) / presidente (geral); DF: governador se não houver
                if cargo == principal or (cargo == 3 and not alvo):
                    alvo[str(int(r.NR_TURNO))] = [int(r.QT_APTOS), int(r.QT_COMPARECIMENTO), int(r.QT_ABSTENCOES),
                                                  int(r.VALIDOS), int(r.QT_VOTOS_BRANCOS), int(r.QT_TOTAL_VOTOS_NULOS)]
                if cargo in COD_PARA_CARGO:
                    m["gv"].setdefault(str(ano), {}).setdefault(COD_PARA_CARGO[cargo], {})[str(int(r.NR_TURNO))] = int(r.VALIDOS)
        votos = _ler_zip(caminho, "votos.csv")
        if votos is None:
            continue
        cand_ano = gerais[gerais["ano"] == ano]
        por_sq = {sq: r for sq, r in zip(cand_ano["sq"], cand_ano.itertuples(index=False))}
        for r in votos.itertuples(index=False):
            uf, cod, cargo = r.SG_UF, str(r.CD_MUNICIPIO).zfill(5), int(r.CD_CARGO)
            if uf == "ZZ" or cargo not in COD_PARA_CARGO:
                continue
            c = por_sq.get(str(r.SQ_CANDIDATO))
            if c is None:
                continue
            linhas, idx = dicionarios.setdefault((uf, ano), ([], {}))
            if c.sq not in idx:
                idx[c.sq] = len(linhas)
                linhas.append([int(c.pid), c.urna, c.sigla, c.ck, c.res, c.nr])
            m = municipios.get((uf, cod)) or mun(uf, cod, "")
            (m["g"].setdefault(str(ano), {}).setdefault(c.ck, {}).setdefault(str(int(r.NR_TURNO)), [])
             .append([idx[c.sq], int(r.VOTOS)]))
        log(f"municípios {ano}: votação geral de {votos['CD_MUNICIPIO'].nunique():,} municípios")

    # 3) Gravação
    pasta = os.path.join(out, "municipio")
    os.makedirs(pasta, exist_ok=True)
    por_uf = {}
    for (uf, cod), m in municipios.items():
        for g in m["g"].values():
            for turnos in g.values():
                for lista in turnos.values():
                    lista.sort(key=lambda x: -x[1])
        anos_m = sorted({*m["m"], *m["g"], *m["p"]}, reverse=True)
        m["anos"] = [int(a) for a in anos_m]
        os.makedirs(os.path.join(pasta, uf), exist_ok=True)
        with open(os.path.join(pasta, uf, f"{cod}.json"), "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, separators=(",", ":"))
        ultimo = next((m["p"][a] for a in sorted(m["p"], reverse=True) if m["p"][a].get("1")), None)
        pref = None
        for a in sorted(m["m"], reverse=True):
            el = [l for l in m["m"][a].get("pref", []) if l[4] == "E"]
            if el:
                pref = [int(a), el[0][2], el[0][1], el[0][0]]
                break
        por_uf.setdefault(uf, []).append([cod, cap(m["n"]), ultimo["1"][0] if ultimo else None, pref])
    for uf, lista in por_uf.items():
        lista.sort(key=lambda x: normaliza(x[1]))
        with open(os.path.join(pasta, f"{uf}.json"), "w", encoding="utf-8") as f:
            json.dump(lista, f, ensure_ascii=False, separators=(",", ":"))
    for (uf, ano), (linhas, _) in dicionarios.items():
        with open(os.path.join(pasta, uf, f"g{ano}.json"), "w", encoding="utf-8") as f:
            json.dump(linhas, f, ensure_ascii=False, separators=(",", ":"))
    log(f"municípios: {len(municipios):,} páginas em {len(por_uf)} UFs")
