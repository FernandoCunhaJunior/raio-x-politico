#!/usr/bin/env python3
"""Gera os dados estáticos do Raio-X Político a partir dos arquivos do TSE.

Entrada: pasta com os .zip originais do Portal de Dados Abertos do TSE
  - consulta_cand_AAAA.zip  (candidaturas)
  - bem_candidato_AAAA.zip  (bens declarados, 2006 em diante)
  - consulta_cand_complementar_AAAA.zip e motivo_cassacao_AAAA.zip (situação detalhada,
    destino dos votos, processo e motivos de indeferimento/cassação, 2014 em diante)

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
    "SG_UF", "SG_UE", "NM_UE", "DS_CARGO", "SQ_CANDIDATO", "NR_CANDIDATO", "NM_CANDIDATO", "NR_PARTIDO",
    "NM_URNA_CANDIDATO", "NR_CPF_CANDIDATO", "DS_SITUACAO_CANDIDATURA",
    "SG_PARTIDO", "NM_PARTIDO", "DT_NASCIMENTO", "NR_TITULO_ELEITORAL_CANDIDATO",
    "DS_OCUPACAO", "DS_SIT_TOT_TURNO",
    "DS_GENERO", "DS_GRAU_INSTRUCAO", "DS_COR_RACA", "SG_UF_NASCIMENTO",
    "DS_COMPOSICAO_COLIGACAO", "DS_COMPOSICAO_FEDERACAO",
]
# Detalhes da situação da candidatura (julgamento do registro, cassação, destino dos votos, processo).
# Até 2016 vêm no próprio consulta_cand; de 2018 em diante, no consulta_cand_complementar_AAAA.zip.
COLS_DET = ["DS_DETALHE_SITUACAO_CAND", "DS_SITUACAO_CANDIDATO_PLEITO", "DS_SITUACAO_JULGAMENTO",
            "NM_TIPO_DESTINACAO_VOTOS", "DS_SITUACAO_CANDIDATO_TOT", "DS_SITUACAO_CASSACAO",
            "DS_SITUACAO_DIPLOMA", "NR_PROCESSO"]
COLS_CAND += COLS_DET
COLS_BENS = ["SG_UE", "SQ_CANDIDATO", "VR_BEM_CANDIDATO", "DS_TIPO_BEM_CANDIDATO", "DS_BEM_CANDIDATO"]
# Colunas que não existem em todos os anos (federações surgiram em 2022): ausentes viram "".
COLS_OPCIONAIS = {"DS_COMPOSICAO_FEDERACAO", "DS_COMPOSICAO_COLIGACAO", "SG_UF_NASCIMENTO", "DS_COR_RACA",
                  "NR_ORDEM_REDE_SOCIAL", "NR_ORDEM", *COLS_DET}  # redes sociais: "NR_ORDEM" em 2022

# Em 2006/2008 quase todo bem foi registrado como "Outros bens e direitos"; para esses tipos
# genéricos a categoria é deduzida da descrição (texto sem acento, maiúsculo).
TIPOS_GENERICOS = {"OUTROS BENS E DIREITOS", "OUTROS BENS MOVEIS", "OUTROS"}
REGRAS_DESCRICAO = [
    (4, r"EM ESPECIE"),
    (2, r"QUOTA|COTAS? (DE|DO|DA) CAPITAL|CAPITAL SOCIAL|PARTICIPACAO|\bACOES\b|\bLTDA\b|\bEIRELI\b|\bS ?/? ?A\b|EMPRESA"),
    (1, r"VEICULO|AUTOMOVEL|CARRO|MOTOCICLETA|\bMOTO\b|CAMINH|CAMIONETE|PICK ?UP|TRATOR|ONIBUS|AERONAVE|LANCHA|BARCO"
        r"|EMBARCAC|\bPLACA\b|RENAVAM|\bFIAT\b|VOLKSWAGEN|\bVW\b|CHEVROLET|\bFORD\b|HONDA|TOYOTA|RENAULT|HYUNDAI|YAMAHA"),
    (0, r"IMOVEL|CASA|APARTAMENTO|\bAPTO\b|TERRENO|\bLOTE\b|SITIO|FAZENDA|CHACARA|\bSALA\b|\bLOJA\b|GALPAO|PREDIO"
        r"|HECTARE|ALQUEIRE|EDIFICIO|RESIDENCIA|MATRICULA|ESCRITURA|\bGLEBA\b|AREA DE TERRA|PONTO COMERCIAL"),
    (3, r"CONTA CORRENTE|\bC ?/ ?C\b|POUPANCA|APLICAC|SALDO|DEPOSITO|\bBANCO\b|\bCDB\b|FUNDO|PREVIDENCIA|VGBL|PGBL"
        r"|TITULO|CREDITO|EMPRESTIMO|CONSORCIO|TESOURO|INVESTIMENTO"),
]

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
        r"|EMPRESTIMO|ATIVO|FUTUROS|OPCOES|LEASING|PECULIO"),
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
    for c in faltando & COLS_OPCIONAIS:
        df[c] = ""
    if faltando - COLS_OPCIONAIS:
        raise SystemExit(f"{caminho}: colunas ausentes {sorted(faltando - COLS_OPCIONAIS)}")
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


def classificar_por_descricao(df, genericos):
    """Reclassifica, pela descrição, itens cujo tipo é genérico ("Outros bens e direitos")."""
    alvo = df["DS_TIPO_BEM_CANDIDATO"].isin(genericos)
    if not alvo.any():
        return 0
    desc = (df.loc[alvo, "DS_BEM_CANDIDATO"].str.normalize("NFKD")
            .str.encode("ascii", "ignore").str.decode("ascii").str.upper()
            .str.replace(r"[^A-Z0-9/ ]+", " ", regex=True))
    nova = pd.Series(len(CATEGORIAS) - 1, index=desc.index)
    pendente = pd.Series(True, index=desc.index)
    for cat, rx in REGRAS_DESCRICAO:
        casou = pendente & desc.str.contains(rx, regex=True)
        nova[casou] = cat
        pendente &= ~casou
    df.loc[alvo, "cat"] = nova
    return int((~pendente).sum())


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
        genericos = {t for t in cats if normaliza(t) in TIPOS_GENERICOS}
        reclass = classificar_por_descricao(df, genericos)
        chave = df["SG_UE"] + "|" + df["SQ_CANDIDATO"]
        tabela = df.pivot_table(index=chave, columns="cat", values="v", aggfunc="sum", fill_value=0.0)
        tabela = tabela.reindex(columns=range(len(CATEGORIAS)), fill_value=0.0)
        tabela.columns = [f"c{i}" for i in tabela.columns]
        tabela["total"] = tabela.sum(axis=1)
        bens[ano] = tabela
        por_cat = df.groupby("cat")["v"].sum() / max(df["v"].sum(), 1)
        partes = ", ".join(f"{CATEGORIAS[i]} {por_cat.get(i, 0):.0%}" for i in range(len(CATEGORIAS)))
        log(f"bens {ano}: {len(df):,} itens, {len(tabela):,} candidaturas | {partes} | {reclass:,} reclassificados pela descrição")
        o = df[df["cat"] == len(CATEGORIAS) - 1].groupby("DS_TIPO_BEM_CANDIDATO")["v"].sum()
        outros = outros.add(o, fill_value=0)
    if len(outros):
        log("tipos classificados como 'Outros' (maiores valores):")
        for t, v in outros.sort_values(ascending=False).head(25).items():
            log(f"    R$ {v:>18,.0f}  {t}")
    return bens


COLS_RECEITA = ["SG_UE", "SQ_CANDIDATO", "DS_FONTE_RECEITA", "VR_RECEITA"]


def fonte_receita(ds):
    """0 = Fundo Especial (FEFC, "fundo eleitoral"), 1 = Fundo Partidário, 2 = outros recursos."""
    n = normaliza(ds)
    if "FUNDO ESPECIAL" in n or "FEFC" in n:
        return 0
    if "FUNDO PARTIDARIO" in n:
        return 1
    return 2


def carregar_receitas(raw, anos):
    """Por ano: DataFrame indexado por 'SG_UE|SQ_CANDIDATO' com colunas total, fefc, fp (em R$).

    Fonte: prestacao_de_contas_eleitorais_candidatos_AAAA.zip (TSE), arquivo receitas_candidatos_AAAA_BRASIL.csv.
    Inclui recursos financeiros e estimáveis e transferências recebidas de partidos/outros candidatos.
    """
    receitas = {}
    for caminho in sorted(glob.glob(os.path.join(raw, "prestacao_de_contas_eleitorais_candidatos_*.zip"))):
        ano = ano_do_arquivo(caminho)
        if anos and ano not in anos:
            continue
        partes, contagem = [], pd.Series(dtype=float)
        with zipfile.ZipFile(caminho) as z:
            nome = next((n for n in z.namelist() if re.fullmatch(rf"receitas_candidatos_{ano}_BRASIL\.csv", n, re.I)), None)
            if not nome:
                log(f"receitas {ano}: arquivo nacional não encontrado — ignorado")
                continue
            with z.open(nome) as f:
                for bloco in pd.read_csv(f, sep=";", encoding="latin-1", dtype=str, keep_default_na=False,
                                         usecols=lambda c: c in COLS_RECEITA, chunksize=1_000_000):
                    fontes = {d: fonte_receita(d) for d in pd.unique(bloco["DS_FONTE_RECEITA"])}
                    bloco["f"] = bloco["DS_FONTE_RECEITA"].map(fontes)
                    bloco["v"] = para_reais(bloco["VR_RECEITA"])
                    contagem = contagem.add(bloco.groupby("DS_FONTE_RECEITA")["v"].sum(), fill_value=0)
                    chave = bloco["SG_UE"] + "|" + bloco["SQ_CANDIDATO"]
                    partes.append(bloco.pivot_table(index=chave, columns="f", values="v", aggfunc="sum", fill_value=0.0))
        tab = pd.concat(partes).groupby(level=0).sum().reindex(columns=[0, 1, 2], fill_value=0.0)
        tab.columns = ["fefc", "fp", "outros"]
        tab["total"] = tab.sum(axis=1)
        receitas[ano] = tab
        resumo = ", ".join(f"{k or '(vazio)'}: R$ {v / 1e6:,.1f} mi" for k, v in contagem.sort_values(ascending=False).items())
        log(f"receitas {ano}: {len(tab):,} candidaturas com receitas | {resumo}")
    return receitas


def normalizar_url(u):
    """Corrige esquema/host (o TSE grava muitas URLs em maiúsculas) e adiciona https:// se faltar."""
    u = (u or "").strip()
    if not u:
        return ""
    if not re.match(r"(?i)https?://", u):
        u = "https://" + u
    m = re.match(r"(?i)(https?://)([^/]+)(.*)", u)
    return (m.group(1).lower() + m.group(2).lower() + m.group(3)) if m else u


def carregar_redes(raw):
    """{(ano, SQ_CANDIDATO): [urls]} a partir de rede_social_candidato_AAAA[_UF].zip (TSE, 2022+)."""
    redes = {}
    for caminho in sorted(glob.glob(os.path.join(raw, "rede_social_candidato_*.zip"))):
        m = re.search(r"rede_social_candidato_(\d{4})", os.path.basename(caminho))
        ano = int(m.group(1))
        df = ler_csv(caminho, ["SQ_CANDIDATO", "NR_ORDEM_REDE_SOCIAL", "NR_ORDEM", "DS_URL"])
        ordem = df["NR_ORDEM_REDE_SOCIAL"].where(df["NR_ORDEM_REDE_SOCIAL"] != "", df["NR_ORDEM"])
        df["ordem"] = pd.to_numeric(ordem, errors="coerce").fillna(99)
        for sq, g in df.sort_values("ordem").groupby("SQ_CANDIDATO"):
            vistos, urls = set(), []
            for u in map(normalizar_url, g["DS_URL"]):
                k = u.lower().rstrip("/")
                if u and k not in vistos:
                    vistos.add(k)
                    urls.append(u)
            redes.setdefault((ano, sq), []).extend(urls[:10])
    log(f"redes sociais: {len(redes):,} candidaturas com links declarados")
    return redes


# Resultados oficiais (portal resultados.tse.jus.br), usados enquanto o TSE não publica a totalização nos
# dados abertos. Códigos das eleições no portal: federal (presidente) e estadual (governador, senador, deputados).
RESULTADOS_PORTAL = {
    2026: {"ciclo": "ele2026", "federal": "6257", "estadual": "6259", "data_turno2": "25/10/2026",
           "federal2": "6258", "estadual2": "6260",  # 2º turno (presidente e governador)
           "data_turno1": "04/10/2026"},
}
DATA_RESULTADOS = {}  # ano -> data (dd/mm/aaaa) dos resultados lidos do portal
UFS_BR = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR",
          "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"]


def _ler_jws(conteudo):
    """O portal publica JSON assinado (JWS): o JSON vem em base64url no segundo segmento."""
    import base64
    seg = conteudo.split(b".")[1]
    return json.loads(base64.urlsafe_b64decode(seg + b"=" * (-len(seg) % 4)).decode("utf-8"))


def carregar_resultados(raw, ano, turno=1):
    """{SQ_CANDIDATO: (situação, votos, % válidos, posição, nº de candidatos)} do `turno` de `ano`,
    a partir do portal de resultados do TSE. No 2º turno só há presidente e governador; arquivos que
    ainda não existem (antes da eleição, ou UF sem 2º turno) são ignorados.

    Arquivos salvos em raw/resultados/. Para presidente/governador com apuração 100% e situação em branco,
    os dois mais votados recebem "2º TURNO" quando ninguém foi eleito.
    """
    cfg = RESULTADOS_PORTAL.get(ano)
    if not cfg:
        return {}, ""
    destino = os.path.join(raw, "resultados")
    os.makedirs(destino, exist_ok=True)
    sufixo = "2" if turno == 2 else ""
    if f"federal{sufixo}" not in cfg:
        return {}, ""
    alvos = [("br", cfg[f"federal{sufixo}"], 1)]
    for uf in UFS_BR:
        for cargo in ((3,) if turno == 2 else (3, 5, 6, 8 if uf == "DF" else 7)):
            alvos.append((uf.lower(), cfg[f"estadual{sufixo}"], cargo))
    res, data, falhas = {}, "", 0
    for uf, ele, cargo in alvos:
        nome = f"{uf}-c{cargo:04d}-e{int(ele):06d}-u.jws"
        url = f"https://resultados.tse.jus.br/oficial/{cfg['ciclo']}/{ele}/dados/{uf}/{nome}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Lente Publica)"})
            with urllib.request.urlopen(req, timeout=90) as r:
                conteudo = r.read()
            with open(os.path.join(destino, nome), "wb") as f:
                f.write(conteudo)
            j = _ler_jws(conteudo)
        except Exception as e:  # noqa: BLE001
            falhas += 1
            if turno == 1:
                log(f"resultados: falha em {nome}: {e}")
            continue
        data = max(data, f"{j.get('dg', '')} {j.get('hg', '')}") if j.get("dg") else data
        cands = []

        def walk(o):
            if isinstance(o, dict):
                if "sqcand" in o and "vap" in o:
                    cands.append(o)
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(j)
        apurado = (j.get("s") or {}).get("pst", "")
        if turno == 1 and cargo in (1, 3) and apurado == "100,00" and not any(c.get("st") for c in cands) \
                and not any(c.get("e") == "s" for c in cands):
            for k, c in enumerate(sorted(cands, key=lambda c: -int(c.get("vap") or 0))):
                c["st"] = "2º turno" if k < 2 else "Não eleito"
        ordem = sorted(cands, key=lambda c: -int(c.get("vap") or 0))
        for pos, c in enumerate(ordem, 1):
            res[str(c["sqcand"])] = ((c.get("st") or "").strip(), int(c.get("vap") or 0),
                                     float((c.get("pvap") or "0").replace(",", ".")), pos, len(ordem))
    log(f"resultados {ano} ({turno}º turno): {len(res):,} candidatos em {len(alvos) - falhas}/{len(alvos)} arquivos "
        f"(gerados até {data})")
    if turno == 2 and not res:
        return res, data
    if data:
        DATA_RESULTADOS[ano] = data.split(" ")[0]
    return res, data


def carregar_votacao(raw, ano):
    """{"UE|SQ": [[turno, votos, % dos válidos ou None, posição, nº de candidatos], ...]} a partir de
    votacao_resumo_AAAA.zip (gerado por scripts/agregar_votacao.py). % = None quando os votos não
    contaram como válidos (candidatura indeferida/cassada)."""
    caminho = os.path.join(raw, f"votacao_resumo_{ano}.zip")
    if not os.path.exists(caminho):
        return {}
    with zipfile.ZipFile(caminho) as z:
        v = pd.read_csv(z.open(z.namelist()[0]), sep=";", dtype={"SG_UE": str, "SQ_CANDIDATO": str})
    v = v.sort_values("NR_TURNO")
    pct = (100 * v["VOTOS_VALIDOS"] / v["VALIDOS_CARGO"].where(v["VALIDOS_CARGO"] > 0)).round(2)
    pct = pct.where(v["VOTOS_VALIDOS"] > 0)
    out = {}
    for k, t, n, p, pos, tot in zip(v["SG_UE"] + "|" + v["SQ_CANDIDATO"], v["NR_TURNO"], v["VOTOS"], pct,
                                    v["POSICAO"], v["N_CANDIDATOS"]):
        out.setdefault(k, []).append([int(t), int(n), None if pd.isna(p) else float(p), int(pos), int(tot)])
    return out


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


def carregar_complementar(raw, ano, df):
    """Preenche COLS_DET a partir de consulta_cand_complementar_AAAA.zip (2018+), ligando por SQ_CANDIDATO."""
    caminho = os.path.join(raw, f"consulta_cand_complementar_{ano}.zip")
    if not os.path.exists(caminho):
        return 0
    comp = ler_csv(caminho, ["SQ_CANDIDATO", *COLS_DET]).drop_duplicates("SQ_CANDIDATO", keep="last")
    comp = comp.set_index("SQ_CANDIDATO").reindex(df["SQ_CANDIDATO"])
    for c in COLS_DET:
        v = comp[c].fillna("").to_numpy()
        df[c] = np.where(v != "", v, df[c].to_numpy())
    return int(comp[COLS_DET].notna().any(axis=1).sum())


def carregar_motivos(raw, ano):
    """Motivos (fundamentos legais) do indeferimento/cassação: motivo_cassacao_AAAA.zip -> {"UE|SQ": [motivos]}."""
    caminho = os.path.join(raw, f"motivo_cassacao_{ano}.zip")
    if not os.path.exists(caminho):
        return {}
    with zipfile.ZipFile(caminho) as z:
        nome = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        with z.open(nome) as f:
            cab = f.readline().decode("latin-1")
    col = "DS_MOTIVO_CASSACAO" if "DS_MOTIVO_CASSACAO" in cab else "DS_MOTIVO"
    m = ler_csv(caminho, ["SG_UE", "SQ_CANDIDATO", col])
    m[col] = m[col].str.strip().str.rstrip(".").str.strip()
    m = m[m[col] != ""].drop_duplicates()
    return (m.groupby(m["SG_UE"] + "|" + m["SQ_CANDIDATO"])[col]
             .agg(lambda s: list(dict.fromkeys(s))).to_dict())


MOTIVO_COLETIVO = re.compile(r"PARTIDO|DRAP|COLIGA|FEDERA|COTA DE G", re.I)


def detalhar_situacao(df, motivos):
    """Explicação da situação de cada candidatura (só quando há algo a explicar).

    Retorna, por linha, None ou [julgamento, situação na totalização, destino dos votos, processo,
    motivos, decisão coletiva, cassação, diploma] (campos finais vazios cortados). "Decisão coletiva" =
    [anulados, total, motivo do grupo]: quando os votos de (quase) toda a chapa do partido para o cargo
    naquele local foram anulados juntos (ex.: partido invalidado, fraude à cota de gênero), o problema
    não é da pessoa, e sim do partido/chapa.
    """
    # Julgamento do registro individual (2024+: DS_SITUACAO_JULGAMENTO; 2018-2022: situação no pleito;
    # até 2016: detalhe da situação). Cassações posteriores aparecem na totalização/cassação.
    jul = df["DS_SITUACAO_JULGAMENTO"].where(df["DS_SITUACAO_JULGAMENTO"] != "", df["DS_SITUACAO_CANDIDATO_PLEITO"])
    jul = jul.where(jul != "", df["DS_DETALHE_SITUACAO_CAND"]).str.upper()
    tot = df["DS_SITUACAO_CANDIDATO_TOT"].str.upper()
    destino = df["NM_TIPO_DESTINACAO_VOTOS"]
    chave = df["SG_UE"] + "|" + df["SQ_CANDIDATO"]
    mot = chave.map(motivos)

    # Decisão coletiva: grupos (local, cargo, partido) com 3+ candidaturas que receberam votos,
    # e 80%+ delas com votos anulados/cassadas ao mesmo tempo.
    anulado = destino.str.startswith("Anulado") | tot.str.startswith("CASSADO")
    com_voto = destino.str.match(r"V[áa]lido|Anulado|Nulo")
    grupo = df["SG_UE"] + "|" + df["DS_CARGO"] + "|" + df["SG_PARTIDO"]
    g = pd.DataFrame({"g": grupo, "a": anulado & com_voto, "v": com_voto})
    soma = g.groupby("g")[["a", "v"]].transform("sum")
    coletivo = anulado & (soma["v"] >= 3) & (soma["a"] >= 3) & (soma["a"] >= 0.8 * soma["v"])
    motivo_grupo = {}
    for gk, ms in zip(grupo[coletivo], mot[coletivo]):
        if isinstance(ms, list):
            for x in ms:
                if MOTIVO_COLETIVO.search(x):
                    motivo_grupo.setdefault(gk, x)

    sit = df["DS_SITUACAO_CANDIDATURA"].str.upper()
    notavel = ((~sit.isin(["", "APTO", "DEFERIDO"])) | mot.notna() | destino.str.startswith(("Anulado", "Nulo"))
               | ~tot.isin(["", "DEFERIDO", "APTO"]) | (df["DS_SITUACAO_CASSACAO"] != "")
               | (df["DS_SITUACAO_DIPLOMA"] != "") | ~jul.isin(["", "DEFERIDO", "APTO"]))
    saida = np.full(len(df), None, dtype=object)
    for i in np.flatnonzero(notavel.to_numpy()):
        col = None
        if coletivo.iat[i]:
            gk = grupo.iat[i]
            col = [int(soma["a"].iat[i]), int(soma["v"].iat[i]), motivo_grupo.get(gk, "")]
        cassacao = df["DS_SITUACAO_CASSACAO"].iat[i]
        d = [jul.iat[i], tot.iat[i], destino.iat[i], df["NR_PROCESSO"].iat[i],
             mot.iat[i] if isinstance(mot.iat[i], list) else None, col,
             "" if cassacao.upper() == "REGULAR" else cassacao, df["DS_SITUACAO_DIPLOMA"].iat[i]]
        while d and d[-1] in (None, ""):
            d.pop()
        saida[i] = d or None
    return saida, int(coletivo.sum())


def carregar_candidaturas(raw, anos, bens, tab, receitas):
    correcoes = carregar_correcoes()
    blocos = []
    for caminho in sorted(glob.glob(os.path.join(raw, "consulta_cand_*.zip"))):
        if not re.fullmatch(r"consulta_cand_\d{4}\.zip", os.path.basename(caminho)):
            continue  # ignora consulta_cand_complementar_AAAA.zip (usado só na colinha)
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
        # Resultado do portal de resultados (quando o arquivo de candidatos ainda não traz a totalização)
        votos = np.full(len(df), np.nan)
        pct = np.full(len(df), np.nan)
        # Votação por turno: [[turno, votos, % válidos, posição, nº candidatos], ...]
        mapa_vot = carregar_votacao(raw, ano)
        votacao = (df["SG_UE"] + "|" + df["SQ_CANDIDATO"]).map(mapa_vot).to_numpy(dtype=object)
        if ano in RESULTADOS_PORTAL and (df["DS_SIT_TOT_TURNO"] == "").all():
            mapa_res, _ = carregar_resultados(raw, ano)
            mapa_res2, _ = carregar_resultados(raw, ano, turno=2)
            if mapa_res:
                achado = df["SQ_CANDIDATO"].map(mapa_res)
                tem = achado.notna()
                df.loc[tem, "DS_SIT_TOT_TURNO"] = achado[tem].map(lambda x: x[0].upper())
                votos = achado.map(lambda x: x[1] if isinstance(x, tuple) else np.nan).to_numpy(dtype=float)
                pct = achado.map(lambda x: x[2] if isinstance(x, tuple) else np.nan).to_numpy(dtype=float)
                achado2 = df["SQ_CANDIDATO"].map(mapa_res2)
                # No 2º turno, o resultado final (eleito / não eleito) substitui o "2º turno"
                fim2 = achado2.map(lambda x: isinstance(x, tuple) and bool(x[0])).astype(bool)
                df.loc[fim2, "DS_SIT_TOT_TURNO"] = achado2[fim2].map(lambda x: x[0].upper())
                votacao = np.empty(len(df), dtype=object)
                votacao[:] = [
                    [[t, x[1], x[2], x[3], x[4]] for t, x in ((1, a), (2, b)) if isinstance(x, tuple)] or None
                    for a, b in zip(achado, achado2)]
                log(f"resultados {ano}: aplicados a {int(tem.sum()):,} candidaturas "
                    f"({int(achado2.notna().sum()):,} com 2º turno)")
        log(f"votação {ano}: {sum(x is not None and x == x for x in votacao):,} candidaturas com votos")
        herdados = completar_resultados(df, ano, correcoes)
        n_comp = carregar_complementar(raw, ano, df)
        motivos = carregar_motivos(raw, ano)
        det, n_coletivo = detalhar_situacao(df, motivos)
        log(f"situação {ano}: complementar em {n_comp:,}, motivos de {len(motivos):,}, "
            f"{sum(x is not None for x in det):,} com explicação, {n_coletivo:,} em decisão coletiva da chapa")
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
        extras.update(votos=votos, pct_validos=pct, votacao=votacao)
        # Receitas de campanha (2018+): NaN = sem prestação de contas/receitas no arquivo do TSE
        if ano in receitas:
            r = receitas[ano].reindex(df["SG_UE"] + "|" + df["SQ_CANDIDATO"])
            extras.update(rec_total=r["total"].to_numpy(), rec_fefc=r["fefc"].to_numpy(), rec_fp=r["fp"].to_numpy())
        else:
            extras.update(rec_total=np.full(len(df), np.nan), rec_fefc=np.full(len(df), np.nan),
                          rec_fp=np.full(len(df), np.nan))
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
            "sq": df["SQ_CANDIDATO"].to_numpy(),
            "uf": df["SG_UF"].to_numpy(),
            "nr_partido": df["NR_PARTIDO"].to_numpy(),
            "det": det,
        }))
        extra = f", {com_bens:.0%} com bens declarados" if com_bens is not None else ""
        log(f"candidaturas {ano}: {len(df):,}{extra}, {herdados:,} resultados de vice/suplente herdados do titular")
    return pd.concat(blocos, ignore_index=True)


# Códigos internos das eleições ordinárias no DivulgaCandContas (usados na URL da foto do candidato).
# Fonte: https://divulgacandcontas.tse.jus.br/divulga/rest/v1/eleicao/ordinarias — (ano, UF específica, código)
ELEICOES_FOTO = [
    (2004, None, "14431"), (2006, None, "14423"), (2008, None, "14422"), (2010, None, "14417"),
    (2012, None, "1699"), (2014, None, "680"), (2016, None, "2"), (2018, None, "2022802018"),
    (2020, "AP", "2032002020"), (2020, None, "2030402020"), (2022, None, "2040602022"),
    (2024, None, "2045202024"), (2026, None, "20322002026"),
]


def indice_eleicao_foto(ano, uf):
    for k, (a, u, _) in enumerate(ELEICOES_FOTO):
        if a == ano and (u is None or u == uf):
            return k
    return None


CADASTROS_CGU = ["ceis", "cnep", "ceaf"]


def baixar_cgu(destino):
    """Baixa CEIS, CNEP e CEAF do Portal da Transparência (arquivo do dia ou dos dias anteriores).

    Retorna {cadastro: (caminho_zip, 'AAAAMMDD')}. Falhas não interrompem o build.
    """
    os.makedirs(destino, exist_ok=True)
    ua = {"User-Agent": "Mozilla/5.0 (raio-x-politico; +https://github.com/FernandoCunhaJunior/raio-x-politico)"}
    hoje = pd.Timestamp.now(tz="America/Bahia").normalize()
    out = {}
    for cad in CADASTROS_CGU:
        for d in range(8):
            data = (hoje - pd.Timedelta(days=d)).strftime("%Y%m%d")
            url = f"https://portaldatransparencia.gov.br/download-de-dados/{cad}/{data}"
            caminho = os.path.join(destino, f"{cad}_{data}.zip")
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=ua), timeout=120) as r:
                    conteudo = r.read()
                if conteudo[:2] != b"PK":
                    continue
                with open(caminho, "wb") as f:
                    f.write(conteudo)
                out[cad] = (caminho, data)
                break
            except Exception:  # noqa: BLE001 — tenta o dia anterior
                continue
        log(f"CGU {cad.upper()}: " + (f"arquivo de {out[cad][1]}" if cad in out else "NÃO DISPONÍVEL (seguindo sem)"))
    return out


def resumo_fundamentacao(txt):
    """'LEI 8429 - ART. 12 - INDEPENDENTEMENTE...' -> 'Lei 8429, art. 12' (+ 'e outras')."""
    partes = [p for p in (txt or "").split(";") if p.strip()]
    if not partes:
        return ""
    seg = [s.strip() for s in partes[0].split(" - ")][:2]
    r = ", ".join(seg).replace("LEI ", "Lei ").replace("ART.", "art.")
    return r + (" e outras" if len(partes) > 1 else "")


def carregar_sancoes(arquivos):
    """Lê as sanções de pessoas físicas da CGU.

    Retorna (registros, por_cpf, por_mascara): registros é a lista publicada no site;
    por_cpf mapeia CPF completo -> índices; por_mascara mapeia 'dígitos visíveis|nome' -> índices.
    """
    registros, por_cpf, por_mascara = [], {}, {}
    for cad, (caminho, _) in arquivos.items():
        with zipfile.ZipFile(caminho) as z:
            nome_csv = next(n for n in z.namelist() if n.lower().endswith(".csv"))
            with z.open(nome_csv) as f:
                s = pd.read_csv(f, sep=";", encoding="latin-1", dtype=str, keep_default_na=False)
        s.columns = [normaliza(c) for c in s.columns]
        s = s[s["TIPO DE PESSOA"] == "F"]
        for d in s.to_dict("records"):
            doc = d.get("CPF OU CNPJ DO SANCIONADO", "")
            nome = normaliza(d.get("NOME DO SANCIONADO", ""))
            digitos = re.sub(r"\D", "", doc)
            i = len(registros)
            registros.append([
                cad.upper(), d.get("CATEGORIA DA SANCAO", ""), d.get("DATA INICIO SANCAO", ""),
                d.get("DATA FINAL SANCAO", ""), d.get("ORGAO SANCIONADOR", ""), d.get("UF ORGAO SANCIONADOR", ""),
                d.get("NUMERO DO PROCESSO", ""), resumo_fundamentacao(d.get("FUNDAMENTACAO LEGAL", "")),
                d.get("CODIGO DA SANCAO", ""), d.get("DATA DO TRANSITO EM JULGADO", ""),
            ])
            if len(digitos) == 11:
                por_cpf.setdefault(digitos, []).append((i, nome))
            elif re.fullmatch(r"\*{3}\.\d{3}\.\d{3}-\*{2}", doc) and nome:
                por_mascara.setdefault(f"{digitos}|{nome}", []).append(i)
        log(f"sanções {cad.upper()}: {len(s):,} registros de pessoa física")
    return registros, por_cpf, por_mascara


def cruzar_sancoes(df, nome_norm, sancoes):
    """Liga sanções às candidaturas: CPF completo (+ mesmo primeiro nome) ou CPF parcial + nome idêntico."""
    registros, por_cpf, por_mascara = sancoes
    cpf = df["cpf"].to_numpy()
    ok = cpf_valido(df["cpf"]).to_numpy()
    nomes = nome_norm.to_numpy()
    achados = {}
    for i in np.flatnonzero(ok):
        c, nome = cpf[i], nomes[i]
        idx = [j for j, n in por_cpf.get(c, []) if n.split(" ")[:1] == nome.split(" ")[:1]]
        idx += por_mascara.get(f"{c[3:9]}|{nome}", [])
        if idx:
            achados[i] = idx
    return achados


def cpf_valido(cpf):
    return cpf.str.fullmatch(r"\d{11}") & ~cpf.isin([d * 11 for d in "0123456789"])  # sem \1: pyarrow não aceita


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


def sigla_norm(s):
    return re.sub(r"\s+", "", s or "").upper()


def carregar_classificacao_partidos():
    """Regras [sigla normalizada, ano_inicio, sigla no estudo, nota] de scripts/partidos_classificacao.csv."""
    caminho = os.path.join(os.path.dirname(os.path.abspath(__file__)), "partidos_classificacao.csv")
    t = pd.read_csv(caminho, sep=";", dtype=str, comment="#", keep_default_na=False)
    return [[sigla_norm(r.sigla), int(r.ano_inicio or 0), r.sigla_estudo, float(r.nota.replace(",", ".")), r.observacao]
            for r in t.itertuples()]


def gerar_partidos(col, tab, out):
    """data/partidos.json: partidos registrados no TSE + todas as legendas presentes nos dados, com estatísticas."""
    caminho = os.path.join(os.path.dirname(os.path.abspath(__file__)), "partidos_tse.json")
    with open(caminho, encoding="utf-8") as f:
        tse = json.load(f)
    eleito = np.array([bool(re.match(r"ELEITO|MEDIA$", normaliza(r))) for r in tab["resultado"].itens])
    siglas = np.array([p.split("|")[0] for p in tab["partido"].itens], dtype=object)[col["partido"]]
    nomes = np.array([p.split("|")[-1] for p in tab["partido"].itens], dtype=object)[col["partido"]]
    d = pd.DataFrame({"sigla": siglas, "nome": nomes, "ano": col["ano"], "eleito": eleito[col["resultado"]]})
    d = d[d["sigla"] != ""]
    d["norm"] = d["sigla"].map(sigla_norm)
    hist = []
    for norm, g in d.groupby("norm"):
        hist.append({
            "sigla": g["sigla"].mode().iat[0], "nome": g.sort_values("ano")["nome"].iat[-1],
            "primeiro": int(g["ano"].min()), "ultimo": int(g["ano"].max()),
            "candidaturas": int(len(g)), "eleitos": int(g["eleito"].sum()),
        })
    with open(os.path.join(out, "partidos.json"), "w", encoding="utf-8") as f:
        json.dump({"tse": tse, "historico": hist}, f, ensure_ascii=False, separators=(",", ":"))
    log(f"partidos: {len(tse['partidos'])} registrados no TSE, {len(hist)} legendas nos dados")


def gerar_listas(col, out):
    """data/lista/AAAA_UF.json: {cargo: [[pid, local, partido, resultado], ...]} para consultas por filtro."""
    os.makedirs(os.path.join(out, "lista"), exist_ok=True)
    grupos = {}
    for i in range(len(col["pid"])):
        chave = (int(col["ano"][i]), col["uf"][i] or "BR")
        grupos.setdefault(chave, {}).setdefault(int(col["cargo"][i]), []).append(
            [int(col["pid"][i]), int(col["ue"][i]), int(col["partido"][i]), int(col["resultado"][i])])
    indice = {}
    for (ano, uf), por_cargo in grupos.items():
        with open(os.path.join(out, "lista", f"{ano}_{uf}.json"), "w", encoding="utf-8") as f:
            json.dump(por_cargo, f, separators=(",", ":"))
        indice.setdefault(str(ano), []).append(uf)
    log(f"listas por eleição/UF: {len(grupos)} arquivos")
    return {a: sorted(u) for a, u in indice.items()}


def percentis_verba_publica(df):
    """Percentis 0..100 da verba pública (fundo eleitoral + partidário) recebida por candidatos, por ano e cargo."""
    ok = ~np.isnan(df["rec_total"].to_numpy())
    sub = df.loc[ok, ["ano", "cargo"]].assign(pub=(df["rec_fefc"] + df["rec_fp"])[ok])
    out = {}
    for (ano, cargo), g in sub.groupby(["ano", "cargo"]):
        if len(g) >= 20:
            out[f"{ano}|{cargo}"] = [int(round(x)) for x in np.percentile(g["pub"].to_numpy(), range(101))]
    log(f"percentis de verba pública: {len(out)} grupos ano/cargo")
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


CARGOS_COLINHA = ["DEPUTADO FEDERAL", "DEPUTADO ESTADUAL", "DEPUTADO DISTRITAL", "SENADOR", "GOVERNADOR", "PRESIDENTE"]


def gerar_colinha(col, chapas, tab, out, raw, redes=None):
    """data/colinha/AAAA_UF.json: candidatos que estão NA URNA na eleição mais recente (para montar a "colinha").

    Usa consulta_cand_complementar_AAAA.zip (TSE): ST_CANDIDATO_INSERIDO_URNA e DS_SITUACAO_JULGAMENTO.
    Cada candidato: [número, nome de urna, sigla, número do partido, pid, SQ, UE, situação (se não deferida), companheiros].
    """
    ano = int(col["ano"].max())
    caminho = os.path.join(raw, f"consulta_cand_complementar_{ano}.zip")
    if not os.path.exists(caminho):
        log(f"colinha: {os.path.basename(caminho)} não encontrado — colinha desativada")
        return None
    comp = ler_csv(caminho, ["SQ_CANDIDATO", "ST_CANDIDATO_INSERIDO_URNA", "DS_SITUACAO_JULGAMENTO", "DT_GERACAO"])
    situacao = dict(zip(comp["SQ_CANDIDATO"], zip(comp["ST_CANDIDATO_INSERIDO_URNA"], comp["DS_SITUACAO_JULGAMENTO"])))
    data_tse = comp["DT_GERACAO"].max() if len(comp) else ""
    cargo_norm = [normaliza(c) for c in tab["cargo"].itens]
    res_norm = [normaliza(r) for r in tab["resultado"].itens]
    siglas = [p.split("|")[0] for p in tab["partido"].itens]
    linhas = np.flatnonzero(col["ano"] == ano)
    # Depois do 1º turno: a colinha passa a mostrar só quem disputa o 2º turno (presidente/governador)
    turno2 = any(cargo_norm[col["cargo"][i]] in ("PRESIDENTE", "GOVERNADOR") and "TURNO" in res_norm[col["resultado"][i]]
                 for i in linhas)
    cfg = RESULTADOS_PORTAL.get(ano, {})
    por_uf, na_urna, fora = {}, 0, 0
    for i in linhas:
        cargo = cargo_norm[col["cargo"][i]]
        if cargo not in CARGOS_COLINHA:
            continue
        ins, julg = situacao.get(col["sq"][i], ("", ""))
        if turno2:
            if cargo not in ("PRESIDENTE", "GOVERNADOR") or "TURNO" not in res_norm[col["resultado"][i]]:
                fora += 1
                continue
            julg = ""
        elif normaliza(ins) != "SIM":
            fora += 1
            continue
        na_urna += 1
        comp_txt = "; ".join(f"{cap_py(tab['cargo'].itens[c])}: {n}" for _, c, n in (chapas.get(int(i)) or []))
        alerta = "" if normaliza(julg) == "DEFERIDO" else julg
        uf = col["uf"][i] or "BR"
        por_uf.setdefault(uf, {}).setdefault(cargo, []).append([
            col["nr"][i], col["urna"][i] or col["nome"][i], siglas[col["partido"][i]], col["nr_partido"][i],
            int(col["pid"][i]), col["sq"][i], col["sg_ue"][i], alerta, comp_txt,
            (redes or {}).get((ano, col["sq"][i]), []),
            None if np.isnan(col["votos"][i]) else [int(col["votos"][i]), round(float(col["pct_validos"][i]), 2)],
            # 2º turno (portal), quando já apurado: [votos, % válidos]
            next(([t[1], t[2]] for t in (col["votacao"][i] if isinstance(col["votacao"][i], list) else [])
                  if t[0] == 2), None)])
    os.makedirs(os.path.join(out, "colinha", ), exist_ok=True)
    if turno2:  # estados sem 2º turno para governador ainda votam para presidente: arquivo (vazio) para todos
        for uf in UFS_BR:
            por_uf.setdefault(uf, {})
        for lista in (c for cs in por_uf.values() for c in cs.values()):
            lista.sort(key=lambda x: -(x[10][0] if x[10] else 0))  # no 2º turno, ordem de votação do 1º turno
    for uf, cargos in por_uf.items():
        for lista in cargos.values():
            if not turno2:
                lista.sort(key=lambda x: normaliza(x[1]))
        partidos = sorted({(c[3], c[2]) for k, l in cargos.items() if k.startswith("DEPUTADO") for c in l if c[3]},
                          key=lambda x: int(x[0]) if x[0].isdigit() else 999)
        with open(os.path.join(out, "colinha", f"{ano}_{uf}.json"), "w", encoding="utf-8") as f:
            json.dump({"ano": ano, "data_tse": data_tse, "cargos": cargos, "partidos": partidos}, f,
                      ensure_ascii=False, separators=(",", ":"))
    turno = 2 if turno2 else 1
    if turno2:
        data_tse = DATA_RESULTADOS.get(ano, data_tse)
    log(f"colinha {ano} ({turno}º turno): {na_urna:,} candidatos em {len(por_uf)} UFs ({fora:,} excluídos)")
    return {"ano": ano, "turno": turno, "data_eleicao": cfg.get(f"data_turno{turno}", ""), "data_tse": data_tse,
            "ufs": sorted(por_uf)}


def cap_py(s):
    return " ".join(w if w.lower() in {"de", "da", "do"} else w.capitalize() for w in (s or "").lower().split())


def gerar(df, rot, nome_norm, tab, out, registros_sancoes, fontes_sancoes, raw):
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
            "genero", "instrucao", "cor", "uf_nasc", "coligacao", "sanc", "sq", "sg_ue", "uf",
            "rec_total", "rec_fefc", "rec_fp", "votos", "pct_validos", "votacao", "det",
            *[f"b{i}" for i in range(n_cat)]]}
    com_sancao = com_foto = com_redes = 0
    redes = carregar_redes(raw)
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
            # 6 bens (total), 7 eleição suplementar, 8 chapa, 9 bens por categoria, 10 ocupação, 11 coligação,
            # 12 receitas de campanha [total, fundo eleitoral (FEFC), fundo partidário],
            # 13 votação por turno [[turno, votos, % dos válidos ou null, posição, nº de candidatos], ...]
            #    (2014+: dados abertos do TSE resumidos por scripts/agregar_votacao.py; ano corrente: portal).
            # 14 detalhes da situação (ver detalhar_situacao): [julgamento, totalização, destino dos votos,
            #    processo, motivos, decisão coletiva, cassação, diploma] ou ausente.
            rt = col["rec_total"][i]
            receita = None if np.isnan(rt) else [int(round(rt)), int(round(col["rec_fefc"][i])), int(round(col["rec_fp"][i]))]
            votos = col["votacao"][i] if isinstance(col["votacao"][i], list) else None
            cand = [
                int(col["ano"][i]), int(col["cargo"][i]), int(col["ue"][i]), int(col["partido"][i]),
                int(col["situacao"][i]), int(col["resultado"][i]),
                None if np.isnan(v) else int(round(v)), int(col["eleicao"][i]),
                chapas.get(i),
                [int(round(col[f"b{k}"][i])) for k in range(n_cat)] if tem_bens else None,
                int(col["ocupacao"][i]),
                col["coligacao"][i],
                receita,
                votos,
                col["det"][i],
            ]
            while len(cand) > 8 and cand[-1] in (None, "", 0):  # corta campos finais vazios
                cand.pop()
            cands.append(cand)
        # CPF mascarado da candidatura mais recente que o tenha (em 2024 o TSE não divulgou CPF)
        cpf_mask = next((c for c in col["cpf_mask"][a:b][::-1] if c), None)
        perfil = [
            next((int(x) for x in col[c][a:b][::-1] if x), 0) for c in ("genero", "instrucao", "cor")
        ] + [next((x for x in col["uf_nasc"][a:b][::-1] if x), "")]
        pessoa = [col["nome"][b - 1], urnas[:5], ano_nasc, ocup, cands, cpf_mask, perfil]
        ids_sanc = sorted({j for x in col["sanc"][a:b] if isinstance(x, list) for j in x})
        pessoa.append([registros_sancoes[j] for j in ids_sanc] if ids_sanc else None)
        com_sancao += bool(ids_sanc)
        # Referências no DivulgaCandContas das candidaturas mais recentes: [eleição, SQ, UE].
        # Usadas para a foto (3 primeiras) e para o link da página oficial do candidato (proposta de governo etc.).
        fotos = []
        for i in range(b - 1, a - 1, -1):
            k = indice_eleicao_foto(int(col["ano"][i]), col["uf"][i]) if col["eleicao"][i] == 0 else None
            if k is not None and col["sq"][i]:
                fotos.append([k, col["sq"][i], col["sg_ue"][i]])
                if len(fotos) == 8:
                    break
        pessoa.append(fotos or None)
        com_foto += bool(fotos)
        # Redes sociais declaradas ao TSE na candidatura mais recente que as tenha (2022+)
        rede = next((redes[(int(col["ano"][i]), col["sq"][i])] for i in range(b - 1, a - 1, -1)
                     if (int(col["ano"][i]), col["sq"][i]) in redes), None)
        if rede:
            pessoa.append(rede)
            com_redes += 1
        lote.append(pessoa)

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

    log(f"pessoas com registro em cadastro de sanções da CGU: {com_sancao:,}")
    log(f"pessoas com referência de foto (2004+): {com_foto:,} | com redes sociais declaradas: {com_redes:,}")
    for i, balde in enumerate(buckets):
        for k, lista in balde.items():
            if isinstance(lista, list) and len(lista) > 1:
                lista.sort(key=lambda p: -relevancia[p])
        with open(os.path.join(out, "idx", f"{i:03x}.json"), "w", encoding="utf-8") as f:
            json.dump(balde, f, separators=(",", ":"))

    gerar_partidos(col, tab, out)
    listas = gerar_listas(col, out)
    for c in ("nr", "urna", "nr_partido"):
        col[c] = df[c].to_numpy()
    colinha = gerar_colinha(col, chapas, tab, out, raw, redes)
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
        "percentis_publico": percentis_verba_publica(df),
        "ipca": carregar_ipca(),
        "sancoes_fontes": fontes_sancoes,  # {"CEIS": "AAAAMMDD", ...}
        "fotos_eleicoes": [e for _, _, e in ELEICOES_FOTO],  # índice usado nas referências de foto
        "fotos_anos": [a for a, _, _ in ELEICOES_FOTO],  # ano de cada eleição acima (link da página no TSE)
        "listas": listas,  # {"2024": ["AC", "AL", ...]} — arquivos data/lista/AAAA_UF.json
        "colinha": colinha,  # {"ano": 2026, "data_tse": "dd/mm/aaaa", "ufs": [...]} ou None
        "espectro": {
            "fonte": "Bolognesi, B.; Ribeiro, E.; Codato, A. Uma Nova Classificação Ideológica dos Partidos "
                     "Políticos Brasileiros. Dados, v. 66, n. 2, 2023.",
            "doi": "https://doi.org/10.1590/dados.2023.66.2.303",
            # Faixas definidas pelos autores (limite superior de cada categoria)
            "faixas": [[1.5, "Extrema-esquerda"], [3.0, "Esquerda"], [4.49, "Centro-esquerda"], [5.5, "Centro"],
                       [7.0, "Centro-direita"], [8.5, "Direita"], [10.0, "Extrema-direita"]],
            "regras": carregar_classificacao_partidos(),
        },
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
    receitas = carregar_receitas(args.raw, anos)
    df = carregar_candidaturas(args.raw, anos, bens, tab, receitas)
    del bens, receitas
    rot, nome_norm = agrupar_pessoas(df)
    arquivos_cgu = baixar_cgu(os.path.join(args.raw, "cgu"))
    sancoes = carregar_sancoes(arquivos_cgu)
    achados = cruzar_sancoes(df, nome_norm, sancoes)
    df["sanc"] = pd.Series(achados, dtype=object).reindex(df.index)
    log(f"candidaturas ligadas a sanções da CGU: {len(achados):,}")
    df["cpf_mask"] = mascarar_cpf(df["cpf"])
    df = df.drop(columns=["cpf", "titulo"])  # CPF completo e título não saem daqui
    fontes = {cad.upper(): data for cad, (_, data) in arquivos_cgu.items()}
    gerar(df, rot, nome_norm, tab, args.out, sancoes[0], fontes, args.raw)


if __name__ == "__main__":
    main()
