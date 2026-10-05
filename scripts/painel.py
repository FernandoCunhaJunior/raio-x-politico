"""Painel das eleições: números agregados por ano, UF e cargo (chamado por build.py).

Saída em OUT/painel/:
  - AAAA.json    {"ano", "cargos", "ufs", "g": {"UF|CARGO": bloco}, "part": {"UF|CARGO": {turno: [...]}}}
                 UF "BR" = Brasil inteiro; CARGO "TODOS" = todos os cargos titulares somados.
  - indice.json  {"anos", "serie": {"UF|CARGO": {ano: {...}}}}  séries para os gráficos de evolução

Bloco (todas as contagens são [candidaturas, eleitos]):
  n, ren (reeleitos / já eleitos antes / estreantes), partidos, esp (6 grupos do espectro),
  perfil (genero, cor, instrucao, idade, ocupacao), din (verba pública, receitas, custo do voto, patrimônio),
  restr (situações, motivos, decisões coletivas)
"""
import json
import os
import zipfile

import numpy as np
import pandas as pd

CARGOS_PAINEL = ["PRESIDENTE", "GOVERNADOR", "SENADOR", "DEPUTADO FEDERAL", "DEPUTADO ESTADUAL",
                 "DEPUTADO DISTRITAL", "PREFEITO", "VEREADOR"]
COD_CARGO_TSE = {1: "PRESIDENTE", 3: "GOVERNADOR", 5: "SENADOR", 6: "DEPUTADO FEDERAL", 7: "DEPUTADO ESTADUAL",
                 8: "DEPUTADO DISTRITAL", 11: "PREFEITO", 13: "VEREADOR"}
# Ordem de preferência para o comparecimento em "todos os cargos" (o arquivo nacional de presidente vale para BR;
# nos estados de 2026 só há governador e demais cargos estaduais no portal)
CARGO_PRINCIPAL = ["PRESIDENTE", "GOVERNADOR", "PREFEITO", "SENADOR", "DEPUTADO FEDERAL", "VEREADOR"]
GRUPOS_ESPECTRO = ["Esquerda", "Centro-esquerda", "Centro", "Centro-direita", "Direita", "Sem classificação"]
FAIXAS_IDADE = [(29, "Até 29"), (39, "30 a 39"), (49, "40 a 49"), (59, "50 a 59"), (200, "60 ou mais")]
SITUACOES = [("Indeferida", r"INDEFER|NAO CONHEC|INAPTO"), ("Cassada", r"CASSAD"), ("Renúncia", r"RENUNC"),
             ("Cancelada", r"CANCEL"), ("Falecimento", r"FALEC")]


def _grupo_espectro(sigla, ano, regras, faixas, sigla_norm):
    s = sigla_norm(sigla)
    r = next((r for r in regras if r[0] == s and ano >= r[1]), None)
    if not r:
        return 5
    nome = next((n for lim, n in faixas if r[3] <= lim), "")
    nome = {"Extrema-esquerda": "Esquerda", "Extrema-direita": "Direita"}.get(nome, nome)
    return GRUPOS_ESPECTRO.index(nome) if nome in GRUPOS_ESPECTRO else 5


def _cont(rotulos, eleito):
    """{rótulo: [candidaturas, eleitos]} ordenado por candidaturas."""
    t = pd.DataFrame({"r": rotulos, "e": eleito}).groupby("r")["e"].agg(["size", "sum"])
    t = t.sort_values("size", ascending=False)
    return {str(k): [int(a), int(b)] for k, (a, b) in zip(t.index, t.to_numpy())}


def _mediana(x):
    x = x[np.isfinite(x)]
    return None if not len(x) else int(round(float(np.median(x))))


def _bloco(s, ano):
    el = s["eleito"].to_numpy()
    b = {"n": [int(len(s)), int(el.sum())]}
    e = s[el]
    b["ren"] = [int(e["reeleito"].sum()), int(e["ja_eleito"].sum()), int(e["estreante"].sum()), int(s["estreante"].sum())]
    p = s.groupby("sigla")["eleito"].agg(["size", "sum"]).sort_values(["sum", "size"], ascending=False)
    b["partidos"] = [[k, int(a), int(c)] for k, (a, c) in zip(p.index, p.to_numpy())][:40]
    esp = np.zeros((6, 2), int)
    np.add.at(esp, (s["esp"].to_numpy(), 0), 1)
    np.add.at(esp, (s["esp"].to_numpy()[el], 1), 1)
    b["esp"] = esp.tolist()
    b["perfil"] = {
        "genero": _cont(s["genero"], el), "cor": _cont(s["cor"], el), "instrucao": _cont(s["instrucao"], el),
        "idade": _cont(s["faixa_idade"], el),
        "ocupacao": dict(list(_cont(s.loc[s["ocupacao"] != "", "ocupacao"], el[s["ocupacao"].to_numpy() != ""]).items())[:12]),
    }
    din = {}
    if ano >= 2018:
        pub = (s["rec_fefc"].fillna(0) + s["rec_fp"].fillna(0))
        din["pub_total"] = int(round(pub.sum()))
        pp = pub.groupby(s["sigla"]).sum().sort_values(ascending=False)
        din["pub_partidos"] = [[k, int(round(v))] for k, v in pp.items() if v > 0][:20]
        rec = s["rec_total"].to_numpy(dtype=float)
        din["rec_mediana"] = [_mediana(rec[el]), _mediana(rec[~el])]
        votos = s["votos_final"].to_numpy(dtype=float)
        ok = el & (votos > 0) & np.isfinite(rec)
        din["custo_voto"] = round(float(np.median(rec[ok] / votos[ok])), 2) if ok.any() else None
    if ano >= 2006:
        bens = s["bens"].to_numpy(dtype=float)
        din["bens_mediana"] = [_mediana(bens[el]), _mediana(bens)]
        din["bens_milionarios"] = [int((bens >= 1e6).sum()), int((bens[el] >= 1e6).sum())]
    if din:
        b["din"] = din
    sit = s["sit_cat"]
    b["restr"] = {"sit": {k: int((sit == k).sum()) for k, _ in SITUACOES if (sit == k).any()},
                  "coletivo": int(s["coletivo"].sum())}
    mot = s["motivos"].explode().dropna()
    if len(mot):
        b["restr"]["motivos"] = [[k, int(v)] for k, v in mot.value_counts().head(10).items()]
    return b


def _participacao(raw, ano, resultados_portal, ler_jws, ufs_br):
    """{"UF|CARGO": {"1": [aptos, comparecimento, abstenções, válidos, brancos, nulos], "2": [...]}}"""
    out = {}
    caminho = os.path.join(raw, f"participacao_{ano}.zip")
    linhas = []
    if os.path.exists(caminho):
        with zipfile.ZipFile(caminho) as z:
            d = pd.read_csv(z.open(z.namelist()[0]), sep=";", dtype={"SG_UF": str})
        for r in d.itertuples(index=False):
            linhas.append((r.SG_UF, int(r.CD_CARGO), int(r.NR_TURNO),
                           [r.QT_APTOS, r.QT_COMPARECIMENTO, r.QT_ABSTENCOES, r.VALIDOS, r.QT_VOTOS_BRANCOS,
                            r.QT_TOTAL_VOTOS_NULOS]))
    elif ano in resultados_portal:  # ano corrente: arquivos do portal já baixados por carregar_resultados
        cfg = resultados_portal[ano]
        pasta = os.path.join(raw, "resultados")
        for turno, suf in ((1, ""), (2, "2")):
            if f"federal{suf}" not in cfg:
                continue
            alvos = [("br", cfg[f"federal{suf}"], 1)] + [(u.lower(), cfg[f"estadual{suf}"], c) for u in ufs_br
                                                         for c in (3, 5, 6, 7, 8)]
            for uf, ele, cargo in alvos:
                nome = os.path.join(pasta, f"{uf}-c{cargo:04d}-e{int(ele):06d}-u.jws")
                if not os.path.exists(nome):
                    continue
                j = ler_jws(open(nome, "rb").read())
                e, v = j.get("e") or {}, j.get("v") or {}
                num = lambda x: int(x or 0)  # noqa: E731
                if not num(e.get("c")):
                    continue
                linhas.append(("BR" if uf == "br" else uf.upper(), cargo, turno,
                               [num(e.get("te")), num(e.get("c")), num(e.get("a")), num(v.get("vv")), num(v.get("vb")),
                                num(v.get("tvn"))]))
    for uf, cargo, turno, vals in linhas:
        ck = COD_CARGO_TSE.get(cargo)
        if not ck:
            continue
        vals = [int(x) for x in vals]
        out.setdefault(f"{uf}|{ck}", {})[str(turno)] = vals
        if uf != "BR":
            soma = out.setdefault(f"BR|{ck}", {}).setdefault(str(turno), [0] * 6)
            if (uf, cargo) != ("BR", 1):
                for i, x in enumerate(vals):
                    soma[i] += x
    # Presidente: o arquivo nacional (BR) prevalece; os por UF não existem no portal
    return out


def gerar_painel(df, tab, out, raw, ctx):
    normaliza, sigla_norm = ctx["normaliza"], ctx["sigla_norm"]
    regras, faixas = ctx["regras"], ctx["faixas"]
    log = ctx["log"]
    cargos = np.array([normaliza(c) for c in tab["cargo"].itens], dtype=object)
    ck = cargos[df["cargo"].to_numpy()]
    manter = np.isin(ck, CARGOS_PAINEL) & (df["eleicao"].to_numpy() == 0)  # só titulares, eleições ordinárias
    d = df.loc[manter, ["pid", "ano", "uf", "partido", "resultado", "situacao", "genero", "cor", "instrucao",
                        "ocupacao", "nasc", "bens", "rec_total", "rec_fefc", "rec_fp", "votacao", "det"]].copy()
    d["ck"] = ck[manter]
    d["ano"] = d["ano"].astype(int)
    d["uf"] = d["uf"].replace("", "BR")
    rotulo = lambda t, codes: np.array(tab[t].itens, dtype=object)[codes.to_numpy()]  # noqa: E731
    d["sigla"] = [p.split("|")[0] for p in rotulo("partido", d["partido"])]
    res = rotulo("resultado", d["resultado"])
    d["eleito"] = [bool(ctx["eleito_re"].match(normaliza(r))) for r in res]
    d["genero"] = [ctx["cap"](x) or "Não informado" for x in rotulo("genero", d["genero"])]
    d["cor"] = [ctx["cap"](x) or "Não informado" for x in rotulo("cor", d["cor"])]
    d["instrucao"] = [ctx["cap"](x) or "Não informado" for x in rotulo("instrucao", d["instrucao"])]
    d["ocupacao"] = [ctx["cap"](x) for x in rotulo("ocupacao", d["ocupacao"].astype(int))]
    nasc = pd.to_numeric(d["nasc"].str[-4:], errors="coerce")
    idade = d["ano"] - nasc
    d["faixa_idade"] = "Não informado"
    for lim, nome in reversed(FAIXAS_IDADE):
        d.loc[(idade <= lim) & (idade >= 16), "faixa_idade"] = nome
    cache = {}
    d["esp"] = [cache.setdefault((s, a), _grupo_espectro(s, a, regras, faixas, sigla_norm))
                for s, a in zip(d["sigla"], d["ano"])]
    # Votos no último turno disputado (para custo do voto)
    d["votos_final"] = [v[-1][1] if isinstance(v, list) and v else np.nan for v in d["votacao"]]
    # Situação da candidatura agrupada + motivos do TSE + decisões coletivas (ver build.detalhar_situacao)
    sit_txt = [normaliza(a) + " " + normaliza(b) + " " + (normaliza(x[1]) if isinstance(x, list) and len(x) > 1 else "")
               for a, b, x in zip(rotulo("situacao", d["situacao"]), res, d["det"])]
    import re
    d["sit_cat"] = [next((k for k, rx in SITUACOES if re.search(rx, t)), "") for t in sit_txt]
    d["motivos"] = [x[4] if isinstance(x, list) and len(x) > 4 and x[4] else None for x in d["det"]]
    d["coletivo"] = [isinstance(x, list) and len(x) > 5 and bool(x[5]) for x in d["det"]]
    # Trajetória: reeleito (mesmo cargo na eleição anterior do mesmo tipo), já eleito antes, estreante
    el = d[d["eleito"]]
    eleitos_set = set(zip(el["pid"], el["ck"], el["ano"]))
    intervalo = np.where(d["ck"] == "SENADOR", 8, 4)
    d["reeleito"] = [(p, c, a - i) in eleitos_set for p, c, a, i in zip(d["pid"], d["ck"], d["ano"], intervalo)]
    primeira_vitoria = el.groupby("pid")["ano"].min()
    d["ja_eleito"] = d["pid"].map(primeira_vitoria).lt(d["ano"]).fillna(False).astype(bool)
    primeira_cand = df.groupby("pid")["ano"].min()
    d["estreante"] = d["pid"].map(primeira_cand).eq(d["ano"]).astype(bool)

    pasta = os.path.join(out, "painel")
    os.makedirs(pasta, exist_ok=True)
    serie = {}
    anos = sorted(int(a) for a in d["ano"].unique())
    for ano in anos:
        da = d[d["ano"] == ano]
        cargos_ano = [c for c in CARGOS_PAINEL if (da["ck"] == c).any()]
        ufs = sorted(u for u in da["uf"].unique() if u != "BR")
        g = {}
        for uf in ["BR", *ufs]:
            du = da if uf == "BR" else da[da["uf"] == uf]
            for c in ["TODOS", *cargos_ano]:
                s = du if c == "TODOS" else du[du["ck"] == c]
                if not len(s):
                    continue
                b = _bloco(s, ano)
                g[f"{uf}|{c}"] = b
                n_el = b["n"][1]
                fem = b["perfil"]["genero"].get("Feminino", [0, 0])
                serie.setdefault(f"{uf}|{c}", {})[ano] = {
                    "n": b["n"], "esp": [e[1] for e in b["esp"]], "esp_cand": [e[0] for e in b["esp"]],
                    "fem": fem, "pub": (b.get("din") or {}).get("pub_total"),
                    "ren": b["ren"][0] if n_el else None}
        part = _participacao(raw, ano, ctx["resultados_portal"], ctx["ler_jws"], ctx["ufs_br"])
        # "Todos os cargos": comparecimento do cargo principal da eleição naquele local
        for uf in ["BR", *ufs]:
            k = next((f"{uf}|{c}" for c in CARGO_PRINCIPAL if f"{uf}|{c}" in part), None)
            if k:
                part[f"{uf}|TODOS"] = part[k]
        for k, t in part.items():
            ult = t.get("1")
            if ult and k in serie and ano in serie[k]:
                serie[k][ano]["abst"] = round(100 * ult[2] / ult[0], 2) if ult[0] else None
        with open(os.path.join(pasta, f"{ano}.json"), "w", encoding="utf-8") as f:
            json.dump({"ano": ano, "cargos": cargos_ano, "ufs": ufs, "g": g, "part": part},
                      f, ensure_ascii=False, separators=(",", ":"))
        log(f"painel {ano}: {len(g)} recortes UF/cargo, participação em {len(part)}")
    with open(os.path.join(pasta, "indice.json"), "w", encoding="utf-8") as f:
        json.dump({"anos": anos, "grupos_espectro": GRUPOS_ESPECTRO, "serie": serie},
                  f, ensure_ascii=False, separators=(",", ":"))
