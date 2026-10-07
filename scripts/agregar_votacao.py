#!/usr/bin/env python3
"""Resume a votação do TSE em um arquivo pequeno por ano (usado por build.py).

Entrada (pasta --raw), do Portal de Dados Abertos do TSE:
  - votacao_candidato_munzona_AAAA.zip  votos nominais por candidato, município e zona (vários GB descompactados)
  - detalhe_votacao_munzona_AAAA.zip    votos válidos, brancos, nulos... por cargo, município e zona

Saída: votacao_resumo_AAAA.zip com um CSV (separador ";"), uma linha por candidato e turno:
  SG_UE;SQ_CANDIDATO;NR_TURNO;CD_CARGO;VOTOS;VOTOS_VALIDOS;VALIDOS_CARGO;POSICAO;N_CANDIDATOS
  - VOTOS: votos nominais recebidos (inclusive os depois anulados)
  - VOTOS_VALIDOS: votos nominais que contaram como válidos
  - VALIDOS_CARGO: total de votos válidos do cargo naquele local e turno (denominador do %)
  - POSICAO / N_CANDIDATOS: colocação por votos nominais entre os candidatos do cargo no local e turno

Uso: python scripts/agregar_votacao.py --raw PASTA --anos 2014,2016,...
Os arquivos de saída vão para o release privado junto com os demais .zip do TSE.
"""
import argparse
import os
import zipfile

import pandas as pd

CHAVE = ["SG_UE", "SQ_CANDIDATO", "NR_TURNO", "CD_CARGO"]


def csv_nacional(z):
    nomes = [n for n in z.namelist() if n.lower().endswith(".csv")]
    br = [n for n in nomes if n.upper().endswith("_BRASIL.CSV")]
    return br or nomes


def ler_em_partes(caminho, colunas, agrupar, somar):
    """Lê o CSV em blocos (os arquivos têm vários GB) e já vai somando."""
    partes = []
    with zipfile.ZipFile(caminho) as z:
        for nome in csv_nacional(z):
            with z.open(nome) as f:
                cab = f.readline().decode("latin-1").strip().replace('"', "").split(";")
            usar = [c for c in colunas if c in cab]
            with z.open(nome) as f:
                for bloco in pd.read_csv(f, sep=";", encoding="latin-1", dtype=str, usecols=usar,
                                         keep_default_na=False, chunksize=2_000_000):
                    for c in somar:
                        bloco[c] = pd.to_numeric(bloco[c], errors="coerce").fillna(0).astype("int64") \
                            if c in bloco else 0
                    partes.append(bloco.groupby(agrupar, as_index=False)[somar].sum())
    return pd.concat(partes).groupby(agrupar, as_index=False)[somar].sum()


def resumir(raw, ano):
    cand = ler_em_partes(os.path.join(raw, f"votacao_candidato_munzona_{ano}.zip"),
                         CHAVE + ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"],
                         CHAVE, ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"])
    if not cand["QT_VOTOS_NOMINAIS_VALIDOS"].any():  # 2014 não tem a coluna: considera todos válidos
        cand["QT_VOTOS_NOMINAIS_VALIDOS"] = cand["QT_VOTOS_NOMINAIS"]
    # Válidos = nominais válidos + legenda válidos. (Em 2014 o QT_TOTAL_VOTOS_VALIDOS do TSE não
    # inclui a legenda; a soma das duas colunas bate com o total oficial em todos os anos.)
    det = ler_em_partes(os.path.join(raw, f"detalhe_votacao_munzona_{ano}.zip"),
                        ["SG_UE", "NR_TURNO", "CD_CARGO", "QT_VOTOS_NOMINAIS_VALIDOS", "QT_TOTAL_VOTOS_LEG_VALIDOS"],
                        ["SG_UE", "NR_TURNO", "CD_CARGO"], ["QT_VOTOS_NOMINAIS_VALIDOS", "QT_TOTAL_VOTOS_LEG_VALIDOS"])
    det["QT_TOTAL_VOTOS_VALIDOS"] = det.pop("QT_VOTOS_NOMINAIS_VALIDOS") + det.pop("QT_TOTAL_VOTOS_LEG_VALIDOS")
    df = cand.merge(det, on=["SG_UE", "NR_TURNO", "CD_CARGO"], how="left")
    grupo = df.groupby(["SG_UE", "NR_TURNO", "CD_CARGO"])["QT_VOTOS_NOMINAIS"]
    df["POSICAO"] = grupo.rank(method="min", ascending=False).astype(int)
    df["N_CANDIDATOS"] = grupo.transform("size")
    df = df.rename(columns={"QT_VOTOS_NOMINAIS": "VOTOS", "QT_VOTOS_NOMINAIS_VALIDOS": "VOTOS_VALIDOS",
                            "QT_TOTAL_VOTOS_VALIDOS": "VALIDOS_CARGO"})
    df["VALIDOS_CARGO"] = df["VALIDOS_CARGO"].fillna(0).astype("int64")
    cols = CHAVE + ["VOTOS", "VOTOS_VALIDOS", "VALIDOS_CARGO", "POSICAO", "N_CANDIDATOS"]
    destino = os.path.join(raw, f"votacao_resumo_{ano}.zip")
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"votacao_resumo_{ano}.csv", df[cols].to_csv(sep=";", index=False))
    print(f"{ano}: {len(df):,} linhas -> {destino} ({os.path.getsize(destino) / 1e6:.1f} MB)", flush=True)
    return df


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--anos", required=True)
    a = ap.parse_args()
    for ano in [int(x) for x in a.anos.split(",") if x.strip()]:
        resumir(a.raw, ano)
        participacao(a.raw, ano)
        votos_partido_uf(a.raw, ano)
        municipios(a.raw, ano)



def participacao(raw, ano):
    """participacao_AAAA.zip: comparecimento, abstenção, válidos, brancos e nulos por UF, cargo e turno
    (somados das zonas do detalhe_votacao_munzona; SG_UF "ZZ" = exterior)."""
    cols = ["QT_APTOS", "QT_COMPARECIMENTO", "QT_ABSTENCOES", "QT_VOTOS_NOMINAIS_VALIDOS",
            "QT_TOTAL_VOTOS_LEG_VALIDOS", "QT_VOTOS_BRANCOS", "QT_TOTAL_VOTOS_NULOS"]
    d = ler_em_partes(os.path.join(raw, f"detalhe_votacao_munzona_{ano}.zip"),
                      ["SG_UF", "CD_CARGO", "NR_TURNO", *cols], ["SG_UF", "CD_CARGO", "NR_TURNO"], cols)
    d["VALIDOS"] = d.pop("QT_VOTOS_NOMINAIS_VALIDOS") + d.pop("QT_TOTAL_VOTOS_LEG_VALIDOS")
    destino = os.path.join(raw, f"participacao_{ano}.zip")
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"participacao_{ano}.csv", d.to_csv(sep=";", index=False))
    print(f"{ano}: participação, {len(d):,} linhas -> {destino}", flush=True)


def votos_partido_uf(raw, ano):
    """votos_partido_uf_AAAA.zip: votos nominais válidos por UF, cargo, turno e partido
    (base do "viés do voto" no mapa do painel; em presidente, o partido mais votado = vencedor no estado)."""
    chave = ["SG_UF", "CD_CARGO", "NR_TURNO", "SG_PARTIDO"]
    d = ler_em_partes(os.path.join(raw, f"votacao_candidato_munzona_{ano}.zip"),
                      chave + ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"], chave,
                      ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"])
    if not d["QT_VOTOS_NOMINAIS_VALIDOS"].any():  # 2014: sem a coluna de válidos
        d["QT_VOTOS_NOMINAIS_VALIDOS"] = d["QT_VOTOS_NOMINAIS"]
    d = d.rename(columns={"QT_VOTOS_NOMINAIS_VALIDOS": "VOTOS"}).drop(columns="QT_VOTOS_NOMINAIS")
    d = d[d["VOTOS"] > 0]
    destino = os.path.join(raw, f"votos_partido_uf_{ano}.zip")
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"votos_partido_uf_{ano}.csv", d.to_csv(sep=";", index=False))
    print(f"{ano}: votos por partido e UF, {len(d):,} linhas -> {destino}", flush=True)


TOP_DEPUTADOS_MUNICIPIO = 15  # deputados mais votados guardados por município (os demais somam pouco)


def municipios(raw, ano):
    """municipio_AAAA.zip, base da página por município:
      - part.csv:  comparecimento por município, cargo e turno (todos os anos)
      - votos.csv: votos válidos por município, cargo, turno e candidato nas eleições GERAIS
                   (presidente, governador e senador: todos; deputados: os 15 mais votados no município)
    Nas eleições municipais a votação de prefeito e vereador já está em votacao_resumo (SG_UE = município)."""
    cols = ["QT_APTOS", "QT_COMPARECIMENTO", "QT_ABSTENCOES", "QT_VOTOS_NOMINAIS_VALIDOS",
            "QT_TOTAL_VOTOS_LEG_VALIDOS", "QT_VOTOS_BRANCOS", "QT_TOTAL_VOTOS_NULOS"]
    chave_p = ["SG_UF", "CD_MUNICIPIO", "NM_MUNICIPIO", "CD_CARGO", "NR_TURNO"]
    p = ler_em_partes(os.path.join(raw, f"detalhe_votacao_munzona_{ano}.zip"), chave_p + cols, chave_p, cols)
    p["VALIDOS"] = p.pop("QT_VOTOS_NOMINAIS_VALIDOS") + p.pop("QT_TOTAL_VOTOS_LEG_VALIDOS")
    arquivos = {"part.csv": p}
    if ano % 4 == 2:  # eleição geral
        chave = ["SG_UF", "CD_MUNICIPIO", "CD_CARGO", "NR_TURNO", "SQ_CANDIDATO"]
        v = ler_em_partes(os.path.join(raw, f"votacao_candidato_munzona_{ano}.zip"),
                          chave + ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"], chave,
                          ["QT_VOTOS_NOMINAIS", "QT_VOTOS_NOMINAIS_VALIDOS"])
        if not v["QT_VOTOS_NOMINAIS_VALIDOS"].any():
            v["QT_VOTOS_NOMINAIS_VALIDOS"] = v["QT_VOTOS_NOMINAIS"]
        v = v.rename(columns={"QT_VOTOS_NOMINAIS_VALIDOS": "VOTOS"}).drop(columns="QT_VOTOS_NOMINAIS")
        v = v[v["VOTOS"] > 0]
        v["CD_CARGO"] = v["CD_CARGO"].astype(int)
        deputado = v["CD_CARGO"].isin([6, 7, 8])
        pos = v.groupby(["CD_MUNICIPIO", "CD_CARGO", "NR_TURNO"])["VOTOS"].rank(method="first", ascending=False)
        v = v[~deputado | (pos <= TOP_DEPUTADOS_MUNICIPIO)]
        arquivos["votos.csv"] = v
    destino = os.path.join(raw, f"municipio_{ano}.zip")
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        for nome, d in arquivos.items():
            z.writestr(nome, d.to_csv(sep=";", index=False))
    print(f"{ano}: municípios, " + ", ".join(f"{k} {len(d):,} linhas" for k, d in arquivos.items()) + f" -> {destino}", flush=True)


if __name__ == "__main__":
    main()
