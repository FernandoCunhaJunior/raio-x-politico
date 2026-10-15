"""Roda o build.py normal e, no meio, gera o export simplificado para o sistema UNAI.

Não altera o build.py: intercepta gerar_partidos(col, tab, out), que o build chama logo
depois de montar as colunas de todas as candidaturas, e aproveita esses dados.
Se o export falhar, só registra um aviso — o site continua sendo gerado e publicado.
"""
import time

import numpy as np

import build
from unai_export import gerar_unai

_original = build.gerar_partidos


def _gerar_partidos_com_unai(col, tab, out):
    try:
        inicios = np.flatnonzero(np.r_[True, col["pid"][1:] != col["pid"][:-1]])
        fins = np.r_[inicios[1:], len(col["pid"])]
        gerar_unai(col, tab, out, inicios, fins, {
            "normaliza": build.normaliza, "sigla_norm": build.sigla_norm,
            "regras": build.carregar_classificacao_partidos(), "faixas": build.FAIXAS_ESPECTRO,
            "log": build.log, "gerado_em": time.strftime("%Y-%m-%d")})
    except Exception as e:  # noqa: BLE001
        build.log(f"AVISO: export UNAI não gerado: {e!r}")
    return _original(col, tab, out)


build.gerar_partidos = _gerar_partidos_com_unai

if __name__ == "__main__":
    build.main()
