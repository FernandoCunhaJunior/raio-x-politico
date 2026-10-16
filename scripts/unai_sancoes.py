"""Sanções da CGU (CEIS e CNEP) para o export UNAI.

Baixa os arquivos públicos do Portal da Transparência (download-de-dados/ceis e /cnep),
que trazem o CPF de pessoa física MASCARADO (***.123.456-**), e casa com as pessoas do
export pelo par (nome normalizado, 6 dígitos do meio do CPF). Só usa dado público e já
mascarado. Se o download falhar, devolve vazio e o export segue sem sanções.
"""
import csv
import io
import re
import time
import unicodedata
import urllib.request
import zipfile
from datetime import date, timedelta

URL = "https://portaldatransparencia.gov.br/download-de-dados/{base}/{dia}"
UA = {"User-Agent": "Mozilla/5.0 (raio-x-politico; export UNAI)"}


def _norm(t):
    t = unicodedata.normalize("NFKD", str(t or "")).encode("ascii", "ignore").decode().upper()
    return " ".join(re.sub(r"[^A-Z0-9 ]", " ", t).split())


def _meio_cpf(t):
    d = re.sub(r"\D", "", str(t or ""))
    return d if len(d) == 6 else (d[3:9] if len(d) == 11 else "")


def _baixar(base, log, dias=10):
    for k in range(dias):
        dia = (date.today() - timedelta(days=k)).strftime("%Y%m%d")
        try:
            req = urllib.request.Request(URL.format(base=base, dia=dia), headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                dados = r.read()
            z = zipfile.ZipFile(io.BytesIO(dados))
            nome = next(n for n in z.namelist() if n.lower().endswith(".csv"))
            log(f"Sanções {base.upper()}: arquivo de {dia} ({len(dados) / 1e6:.1f} MB)")
            return z.read(nome).decode("latin-1")
        except Exception:  # noqa: BLE001 — tenta o dia anterior
            time.sleep(1)
    log(f"AVISO: não consegui baixar {base.upper()} nos últimos {dias} dias")
    return ""


def _col(cab, *chaves):
    """Índice da 1ª coluna cujo cabeçalho normalizado contém todas as chaves."""
    for i, h in enumerate(cab):
        h = _norm(h)
        if all(c in h for c in chaves):
            return i
    return None


def carregar_sancoes(log):
    """{(nome_norm, meio_cpf): [sanção, ...]} só de pessoas físicas."""
    idx = {}
    for base in ("ceis", "cnep"):
        txt = _baixar(base, log)
        if not txt:
            continue
        linhas = csv.reader(io.StringIO(txt), delimiter=";")
        cab = next(linhas, [])
        c_tipo = _col(cab, "TIPO DE PESSOA")
        c_doc = _col(cab, "CPF OU CNPJ")
        c_nome = _col(cab, "NOME DO SANCIONADO")
        c_cat = _col(cab, "CATEGORIA DA SANCAO")
        c_ini = _col(cab, "DATA INICIO SANCAO")
        c_fim = _col(cab, "DATA FINAL SANCAO")
        c_org = next((i for i, h in enumerate(cab) if _norm(h) == "ORGAO SANCIONADOR"), _col(cab, "ORGAO SANCIONADOR"))
        c_uf = _col(cab, "UF ORGAO SANCIONADOR")
        c_proc = _col(cab, "NUMERO DO PROCESSO")
        c_fund = _col(cab, "FUNDAMENTACAO LEGAL")
        if None in (c_doc, c_nome):
            log(f"AVISO: cabeçalho inesperado no {base.upper()}: {cab[:6]}")
            continue
        n = 0
        g = lambda row, c: (row[c].strip() if c is not None and c < len(row) else "")  # noqa: E731
        for row in linhas:
            if c_tipo is not None and g(row, c_tipo)[:1].upper() not in ("F", ""):
                continue  # só pessoa física
            meio = _meio_cpf(g(row, c_doc))
            if not meio:
                continue
            idx.setdefault((_norm(g(row, c_nome)), meio), []).append({
                "cadastro": base.upper(),
                "categoria": g(row, c_cat),
                "inicio": g(row, c_ini),
                "fim": g(row, c_fim),
                "orgao": g(row, c_org),
                "uf": g(row, c_uf),
                "processo": g(row, c_proc),
                "fundamento": g(row, c_fund)[:160],
            })
            n += 1
        log(f"Sanções {base.upper()}: {n:,} registros de pessoa física")
    return idx


def sancoes_da_pessoa(idx, nome, cpf_mask):
    if not idx or not cpf_mask:
        return []
    lista = idx.get((_norm(nome), _meio_cpf(cpf_mask)), [])
    # mais recentes primeiro (datas dd/mm/aaaa)
    chave = lambda s: (s["inicio"][6:10], s["inicio"][3:5], s["inicio"][:2])  # noqa: E731
    hoje = date.today().strftime("%Y%m%d")
    out = []
    for s in sorted(lista, key=chave, reverse=True)[:10]:
        f = s["fim"]
        fim = f[6:10] + f[3:5] + f[:2] if re.fullmatch(r"\d{2}/\d{2}/\d{4}", f) else ""
        out.append(dict(s, vigente=(not fim) or fim >= hoje))
    return out
