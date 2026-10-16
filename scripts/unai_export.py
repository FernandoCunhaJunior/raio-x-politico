"""Export para o sistema UNAI (Power Apps + Power Automate, licença standard).

O Power Automate standard não tem o conector HTTP nem como calcular o hash FNV-1a do índice
do site. Por isso geramos uma cópia simplificada, fatiada pelo PRIMEIRO NOME normalizado:

  data/unai/meta.json             {"versao", "gerado_em", "ufs", "arquivos": {"BA": n}}
  data/unai/<UF>/<PRIMEIRONOME>.json
      [ {pessoa}, ... ]  — só pessoas com ao menos uma candidatura na UF
  data/unai/<UF>/_indice_<LETRA>.txt
      " NOME1 NOME2 ... "  — primeiros nomes que têm arquivo (o fluxo confere antes de baixar)

O fluxo do Power Automate:
  1. recebe o nome do investigado (o app já envia normalizado: sem acento, maiúsculo);
  2. "Carregar arquivo da URL" (OneDrive for Business, standard) de
     https://lentepublica.com.br/data/unai/BA/<PRIMEIRONOME>.json;
  3. "Filtrar matriz" pelos demais sobrenomes e devolve as pessoas ao app.

Campos com nomes legíveis (não posicionais) para facilitar o Filtrar matriz / ParseJSON.
Só usa dados que o site já publica (CPF mascarado, sem título de eleitor).
"""
import json
import os
import re
from collections import defaultdict

STOP = {"DA", "DE", "DO", "DAS", "DOS", "E", "D", "DI", "DU"}
ELEITO_RE = re.compile(r"ELEITO|MEDIA$")
GRUPOS = {"Extrema-esquerda": "Esquerda", "Esquerda": "Esquerda", "Centro-esquerda": "Centro-esquerda",
          "Centro": "Centro", "Centro-direita": "Centro-direita", "Direita": "Direita",
          "Extrema-direita": "Direita"}


def _espectro(sigla, ano, regras, faixas, sigla_norm):
    s = sigla_norm(sigla)
    r = next((r for r in regras if r[0] == s and ano >= r[1]), None)
    if not r:
        return None
    nome = next((n for lim, n in faixas if r[3] <= lim), None)
    return GRUPOS.get(nome)


def gerar_unai(col, tab, out, inicios, fins, ctx, ufs=("BA",), site="https://lentepublica.com.br"):
    normaliza, sigla_norm = ctx["normaliza"], ctx["sigla_norm"]
    regras, faixas, log = ctx["regras"], ctx["faixas"], ctx["log"]
    cargos = tab["cargo"].itens
    ues = tab["ue"].itens          # "UF|NOME DA UE"
    partidos = tab["partido"].itens  # "SIGLA|NOME"
    resultados = tab["resultado"].itens
    situacoes = tab["situacao"].itens
    eleito_cod = [bool(ELEITO_RE.match(normaliza(r))) for r in resultados]
    alvo = set(ufs)

    fatias = {uf: defaultdict(list) for uf in ufs}
    for pid, (a, b) in enumerate(zip(inicios, fins)):
        ufs_pessoa = {col["uf"][i] for i in range(a, b)} & alvo
        if not ufs_pessoa:
            continue
        nome_norm = col["nome_norm"][b - 1]
        tk = [t for t in nome_norm.split() if t not in STOP]
        if not tk:
            continue
        cands = []
        for i in range(a, b):
            ano = int(col["ano"][i])
            sigla = partidos[col["partido"][i]].split("|")[0]
            uf_ue, _, local = ues[col["ue"][i]].partition("|")
            bens = col["bens"][i]
            cands.append({
                "ano": ano,
                "cargo": cargos[col["cargo"][i]],
                "local": local,
                "uf": col["uf"][i] or uf_ue,
                "partido": sigla,
                "espectro": _espectro(sigla, ano, regras, faixas, sigla_norm),
                "situacao": situacoes[col["situacao"][i]],
                "resultado": resultados[col["resultado"][i]],
                "eleito": eleito_cod[col["resultado"][i]],
                "bens": None if bens != bens or bens <= 0 else int(round(bens)),  # NaN-safe
            })
        cands.sort(key=lambda c: -c["ano"])
        nasc = next((x for x in col["nasc"][a:b][::-1] if re.fullmatch(r"\d{2}/\d{2}/\d{4}", str(x))), None)
        urnas = []
        for u in col["urna"][a:b][::-1]:
            if u and u not in urnas:
                urnas.append(u)
        ult = cands[0]
        pessoa = {
            "pid": pid,
            "nome": col["nome"][b - 1],
            "nomeNorm": " " + " ".join(tk) + " ",  # espaços nas pontas: contains(' SILVA ') casa palavra inteira
            "urnas": urnas[:5],
            "anoNasc": int(nasc[-4:]) if nasc else None,
            "cpf": next((c for c in col["cpf_mask"][a:b][::-1] if c), None),
            "jaEleito": any(c["eleito"] for c in cands),
            "ultimoAno": ult["ano"],
            "ultimoCargo": ult["cargo"],
            "ultimoLocal": ult["local"],
            "ultimoPartido": ult["partido"],
            "ultimoEspectro": ult["espectro"],
            "link": f"{site}/#q={'+'.join(tk)}&p={pid}",
            "cands": cands,
        }
        for uf in ufs_pessoa:
            fatias[uf][tk[0]].append(pessoa)

    base = os.path.join(out, "unai")
    resumo = {}
    for uf, por_nome in fatias.items():
        os.makedirs(os.path.join(base, uf), exist_ok=True)
        for primeiro, lista in por_nome.items():
            lista.sort(key=lambda p: (not p["jaEleito"], -p["ultimoAno"]))
            with open(os.path.join(base, uf, f"{primeiro}.json"), "w", encoding="utf-8") as f:
                json.dump(lista, f, ensure_ascii=False, separators=(",", ":"))
        # Índice por letra inicial (_indice_A.txt ...): " NOME1 NOME2 ... ". O fluxo consulta o índice
        # antes de baixar o arquivo do nome, e assim nunca pede um arquivo que não existe (404).
        por_letra = defaultdict(list)
        for primeiro in por_nome:
            por_letra[primeiro[0]].append(primeiro)
        for letra in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":  # todas as letras, mesmo sem nomes: o índice sempre existe
            por_letra.setdefault(letra, [])
        for letra, nomes in por_letra.items():
            with open(os.path.join(base, uf, f"_indice_{letra}.txt"), "w", encoding="utf-8") as f:
                f.write(" " + " ".join(sorted(nomes)) + " ")
        resumo[uf] = {"arquivos": len(por_nome), "pessoas": sum(len(v) for v in por_nome.values()),
                      "indices": len(por_letra)}
        log(f"UNAI {uf}: {resumo[uf]['pessoas']:,} pessoas em {resumo[uf]['arquivos']:,} arquivos")
    with open(os.path.join(base, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"gerado_em": ctx.get("gerado_em"), "ufs": resumo,
                   "url": f"{site}/data/unai/<UF>/<PRIMEIRONOME>.json"}, f, ensure_ascii=False)
