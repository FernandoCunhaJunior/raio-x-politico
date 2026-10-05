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
# Sucessão de legendas (renomeações, incorporações e fusões), para comparar eleitos com a eleição anterior.
# Chaves e valores em sigla normalizada (sem espaços, maiúsculas).
SUCESSORA = {
    "PR": "PL", "PRB": "REPUBLICANOS", "PMDB": "MDB", "PPS": "CIDADANIA", "PTN": "PODE", "PEN": "PATRIOTA",
    "PATRI": "PATRIOTA", "PTDOB": "AVANTE", "PSDC": "DC", "SD": "SOLIDARIEDADE", "PTC": "AGIR", "PMN": "MOBILIZA",
    "PSL": "UNIÃO", "DEM": "UNIÃO", "PTB": "PRD", "PATRIOTA": "PRD", "PROS": "SOLIDARIEDADE", "PSC": "PODE",
    "PHS": "PODE", "PPL": "PCDOB", "PRP": "PATRIOTA", "PFL": "DEM", "PPB": "PP", "PP": "PP",
}


def _traduz_anteriores(prev, atuais, sigla_norm):
    """Leva os eleitos da eleição anterior para a legenda atual correspondente.
    Retorna ({sigla atual: eleitos}, {sigla atual: [siglas antigas]})."""
    por_norm = {sigla_norm(x): x for x in atuais}
    out, origem = {}, {}
    for sig, n in prev.items():
        k, vistos = sigla_norm(sig), set()
        while k not in por_norm and k in SUCESSORA and k not in vistos:
            vistos.add(k)
            k = SUCESSORA[k]
        alvo = por_norm.get(k, sig)
        out[alvo] = out.get(alvo, 0) + n
        if alvo != sig:
            origem.setdefault(alvo, []).append(sig)
    return out, origem


FAIXAS_RECEITA = [(10_000, "Até R$ 10 mil"), (50_000, "R$ 10 a 50 mil"), (200_000, "R$ 50 a 200 mil"),
                  (1_000_000, "R$ 200 mil a 1 mi"), (float("inf"), "Mais de R$ 1 mi")]
FAIXAS_BENS = [(0, "Nenhum bem"), (100_000, "Até R$ 100 mil"), (500_000, "R$ 100 a 500 mil"),
               (2_000_000, "R$ 500 mil a 2 mi"), (float("inf"), "Mais de R$ 2 mi")]
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


def _faixas(valores, el, faixas):
    """[[candidaturas, eleitos], ...] por faixa de valor (NaN = sem informação, fica de fora)."""
    v = np.asarray(valores, dtype=float)
    ok = np.isfinite(v)
    out, ini = [], -np.inf
    for lim, _ in faixas:
        m = ok & (v > ini) & (v <= lim)
        out.append([int(m.sum()), int((m & el).sum())])
        ini = lim
    return out


def _media_nota(notas, pesos=None):
    n = np.asarray(notas, dtype=float)
    w = np.ones_like(n) if pesos is None else np.asarray(pesos, dtype=float)
    ok = np.isfinite(n) & (w > 0)
    return round(float((n[ok] * w[ok]).sum() / w[ok].sum()), 2) if ok.any() else None


def _mediana(x):
    x = x[np.isfinite(x)]
    return None if not len(x) else int(round(float(np.median(x))))


def _bloco(s, ano, prev=None, sigla_norm=None):
    """prev: {sigla: eleitos} na eleição anterior do mesmo tipo, mesmo local e cargo."""
    el = s["eleito"].to_numpy()
    origem = {}
    if prev:
        prev, origem = _traduz_anteriores(prev, set(s["sigla"]), sigla_norm)
    b = {"n": [int(len(s)), int(el.sum())]}
    e = s[el]
    b["ren"] = [int(e["reeleito"].sum()), int(e["ja_eleito"].sum()), int(e["estreante"].sum()), int(s["estreante"].sum())]
    p = s.groupby("sigla")["eleito"].agg(["size", "sum"]).sort_values(["sum", "size"], ascending=False)
    # [sigla, candidaturas, eleitos, eleitos na eleição anterior]
    b["partidos"] = [[k, int(a), int(c), int((prev or {}).get(k, 0))] + ([" + ".join(origem[k])] if k in origem else [])
                     for k, (a, c) in zip(p.index, p.to_numpy())][:40]
    if prev:  # partidos que tinham eleitos na anterior e agora não aparecem na lista
        presentes = {x[0] for x in b["partidos"]}
        b["partidos"] += [[k, 0, 0, int(v)] for k, v in prev.items() if v and k not in presentes]
    b["nota"] = _media_nota(s["nota"].to_numpy()[el])
    b["nota_cand"] = _media_nota(s["nota"].to_numpy())
    esp = np.zeros((6, 2), int)
    np.add.at(esp, (s["esp"].to_numpy(), 0), 1)
    np.add.at(esp, (s["esp"].to_numpy()[el], 1), 1)
    b["esp"] = esp.tolist()
    b["perfil"] = {
        "genero": _cont(s["genero"], el), "cor": _cont(s["cor"], el), "instrucao": _cont(s["instrucao"], el),
        "idade": _cont(s["faixa_idade"], el),
        # pirâmide: gênero x faixa de idade, [candidaturas, eleitos]
        "piramide": {g: [[int(((s["genero"] == g) & (s["faixa_idade"] == f)).sum()),
                          int(((s["genero"] == g) & (s["faixa_idade"] == f) & s["eleito"]).sum())] for _, f in FAIXAS_IDADE]
                     for g in ("Feminino", "Masculino")},
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
        din["frec"] = _faixas(rec, el, FAIXAS_RECEITA)
        din["pub_eleitos"] = int(round(pub[el].sum()))
    if ano >= 2006:
        bens = s["bens"].to_numpy(dtype=float)
        din["bens_mediana"] = [_mediana(bens[el]), _mediana(bens)]
        din["bens_milionarios"] = [int((bens >= 1e6).sum()), int((bens[el] >= 1e6).sum())]
        din["fbens"] = _faixas(np.nan_to_num(bens, nan=0.0), el, FAIXAS_BENS)
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


def _votos_partido(raw, ano, ctx):
    """DataFrame [uf, ck, turno, sigla, votos] com votos nominais válidos por partido.
    2014-2024: votos_partido_uf_AAAA.zip; ano corrente: arquivos do portal de resultados (baixa os de presidente por UF)."""
    caminho = os.path.join(raw, f"votos_partido_uf_{ano}.zip")
    if os.path.exists(caminho):
        with zipfile.ZipFile(caminho) as z:
            d = pd.read_csv(z.open(z.namelist()[0]), sep=";", dtype={"SG_UF": str, "SG_PARTIDO": str})
        d["ck"] = d["CD_CARGO"].map(COD_CARGO_TSE)
        d = d.dropna(subset=["ck"])
        return pd.DataFrame({"uf": d["SG_UF"], "ck": d["ck"], "turno": d["NR_TURNO"].astype(int),
                             "sigla": d["SG_PARTIDO"], "votos": d["VOTOS"].astype("int64")})
    cfg = ctx["resultados_portal"].get(ano)
    if not cfg:
        return None
    import urllib.request
    pasta = os.path.join(raw, "resultados")
    os.makedirs(pasta, exist_ok=True)
    linhas = []
    for turno, suf in ((1, ""), (2, "2")):
        if f"federal{suf}" not in cfg:
            continue
        alvos = [(u.lower(), cfg[f"federal{suf}"], 1) for u in [*ctx["ufs_br"], "ZZ"]]
        alvos += [(u.lower(), cfg[f"estadual{suf}"], c) for u in ctx["ufs_br"]
                  for c in ((3,) if turno == 2 else (3, 5, 6, 7, 8))]
        for uf, ele, cargo in alvos:
            nome = f"{uf}-c{cargo:04d}-e{int(ele):06d}-u.jws"
            arq = os.path.join(pasta, nome)
            if not os.path.exists(arq) and cargo == 1:  # presidente por UF: não é baixado pelo build principal
                url = f"https://resultados.tse.jus.br/oficial/{cfg['ciclo']}/{ele}/dados/{uf}/{nome}"
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Lente Publica)"})
                    with urllib.request.urlopen(req, timeout=60) as r:
                        conteudo = r.read()
                    with open(arq, "wb") as f:
                        f.write(conteudo)
                except Exception:  # noqa: BLE001 — UF sem o arquivo (ex.: 2º turno ainda não apurado)
                    continue
            if not os.path.exists(arq):
                continue
            with open(arq, "rb") as f:
                j = ctx["ler_jws"](f.read())
            for cg in j.get("carg") or []:
                for agr in cg.get("agr") or []:
                    for par in agr.get("par") or []:
                        v = sum(int(c.get("vap") or 0) for c in par.get("cand") or []
                                if (c.get("dvt") or "").startswith("V"))
                        if v:
                            linhas.append((uf.upper(), COD_CARGO_TSE[cargo], turno, par.get("sg", ""), v))
    if not linhas:
        return None
    return pd.DataFrame(linhas, columns=["uf", "ck", "turno", "sigla", "votos"])


def _resumo_votos(v, ano, nota_de):
    """Por turno: {"esp": votos por grupo [6], "nota": média ponderada pelos votos, "top": [[sigla, votos]], "total"}"""
    out = {}
    for t, x in v.groupby("turno"):
        x = x.groupby("sigla")["votos"].sum().sort_values(ascending=False)
        esp = [0] * 6
        notas, pesos = [], []
        for sig, n in x.items():
            g, nota = nota_de(sig, ano)
            esp[g] += int(n)
            if nota is not None:
                notas.append(nota)
                pesos.append(n)
        out[str(int(t))] = {"esp": esp, "nota": _media_nota(notas, pesos),
                            "top": [[k, int(n)] for k, n in x.head(8).items()], "total": int(x.sum())}
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

    def nota_de(sigla, ano):
        """(grupo do espectro 0-5, nota 0-10 ou None) da legenda naquele ano."""
        k = (sigla, ano)
        if k not in cache:
            sn = sigla_norm(sigla)
            r = next((r for r in regras if r[0] == sn and ano >= r[1]), None)
            cache[k] = (_grupo_espectro(sigla, ano, regras, faixas, sigla_norm), r[3] if r else None)
        return cache[k]
    gn = [nota_de(s, a) for s, a in zip(d["sigla"], d["ano"])]
    d["esp"] = [x[0] for x in gn]
    d["nota"] = [np.nan if x[1] is None else x[1] for x in gn]
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

    el_part = {}  # (ano, uf, cargo) -> {sigla: eleitos}
    for (a, u, c, sg), n in d[d["eleito"]].groupby(["ano", "uf", "ck", "sigla"]).size().items():
        for uu in {u, "BR"}:
            for cc in (c, "TODOS"):
                dd = el_part.setdefault((a, uu, cc), {})
                dd[sg] = dd.get(sg, 0) + int(n)
    pasta = os.path.join(out, "painel")
    os.makedirs(pasta, exist_ok=True)
    serie = {}
    anos = sorted(int(a) for a in d["ano"].unique())
    for ano in anos:
        da = d[d["ano"] == ano]
        cargos_ano = [c for c in CARGOS_PAINEL if (da["ck"] == c).any()]
        ufs = sorted(u for u in da["uf"].unique() if u != "BR")
        g = {}
        votos = _votos_partido(raw, ano, ctx)
        anterior = ano - 4 if (ano - 4) in set(anos) else None
        for uf in ["BR", *ufs]:
            du = da if uf == "BR" else da[da["uf"] == uf]
            for c in ["TODOS", *cargos_ano]:
                s = du if c == "TODOS" else du[du["ck"] == c]
                if not len(s):
                    # Presidente nos estados: não há candidatos "do estado", mas há a votação no estado
                    vv = votos[(votos["ck"] == c) & (votos["uf"] == uf)] if votos is not None else []
                    if len(vv):
                        g[f"{uf}|{c}"] = {"so_votos": 1, "votos": _resumo_votos(vv, ano, nota_de), "votos_cargo": c}
                        vr = g[f"{uf}|{c}"]["votos"]
                        fim = vr[max(vr)]
                        serie.setdefault(f"{uf}|{c}", {})[ano] = {
                            "vnota": vr.get("1", {}).get("nota"), "vesp": vr.get("1", {}).get("esp"),
                            "top_v": fim["top"][0][0] if fim["top"] else None}
                    continue
                b = _bloco(s, ano, el_part.get((anterior, uf, c), {}) if anterior else None, sigla_norm)
                b["ant"] = anterior
                if votos is not None:
                    # "Todos os cargos": o voto do cargo principal (presidente / governador / prefeito)
                    cv = c if c != "TODOS" else next((x for x in CARGO_PRINCIPAL if (votos["ck"] == x).any()), None)
                    vv = votos[(votos["ck"] == cv) & ((votos["uf"] == uf) if uf != "BR" else True)]
                    if len(vv):
                        b["votos"] = _resumo_votos(vv, ano, nota_de)
                        b["votos_cargo"] = cv
                g[f"{uf}|{c}"] = b
                n_el = b["n"][1]
                fem = b["perfil"]["genero"].get("Feminino", [0, 0])
                serie.setdefault(f"{uf}|{c}", {})[ano] = {
                    "n": b["n"], "esp": [e[1] for e in b["esp"]], "esp_cand": [e[0] for e in b["esp"]],
                    "fem": fem, "pub": (b.get("din") or {}).get("pub_total"),
                    "ren": b["ren"][0] if n_el else None, "nota": b.get("nota"),
                    "vnota": (b.get("votos") or {}).get("1", {}).get("nota"),
                    "vesp": (b.get("votos") or {}).get("1", {}).get("esp"),
                    # partido com mais eleitos / mais votado no último turno (mapas "vencedor" da linha do tempo)
                    "top_el": next((x[0] for x in b["partidos"] if x[2]), None),
                    "top_v": (lambda v: v[max(v)]["top"][0][0] if v and v[max(v)]["top"] else None)(b.get("votos"))}
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
