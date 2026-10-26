# Colinha do eleitor ("Monte sua colinha")

A colinha deixa o eleitor escolher seus candidatos, filtrando por partido e espectro, e imprimir um cartão
de bolso com os números na ordem da urna. Ela só faz sentido perto de uma eleição e por isso fica
**desligada fora do período eleitoral**. O código continua no projeto; este arquivo explica como ela
funciona e como religar.

Situação atual: **desativada** desde 26/10/2026, depois do 2º turno das eleições gerais de 2026.

## Como ligar e desligar

| Onde | O que muda |
| --- | --- |
| `scripts/build.py` → `COLINHA_ATIVA` | `True` gera `data/colinha/` e preenche `meta.json → colinha`; `False` não gera nada e grava `colinha: null` |
| `site/index.html` → botão `.botao-colinha` | Vem escondido (`hidden`); `site/app.js` (função `iniciar`) só mostra o botão quando `META.colinha` existe |
| Link antigo `#colinha=1` | Com a colinha desligada, mostra o aviso "Colinha fora do ar" (`mostrarColinha` em `site/app.js`) |

Depois de mudar `COLINHA_ATIVA`, rode o workflow "Gerar dados e publicar site" no GitHub Actions.

## Como funciona

### 1. Dados (scripts/build.py → `gerar_colinha`)

- **Eleição considerada:** a mais recente da base (`ano = col["ano"].max()`).
- **Quem está na urna:** vem do arquivo `consulta_cand_complementar_AAAA.zip` do TSE (colunas
  `ST_CANDIDATO_INSERIDO_URNA` e `DS_SITUACAO_JULGAMENTO`). Entra só quem tem `ST_CANDIDATO_INSERIDO_URNA = SIM`.
  Sem esse arquivo no release `dados-tse`, a colinha não é gerada.
- **Alerta:** candidatura na urna mas sem julgamento "DEFERIDO" (ex.: indeferida com recurso) aparece com aviso
  "voto pode ser anulado".
- **Cargos:** `CARGOS_COLINHA` (deputado federal, estadual/distrital, senador, governador, presidente).
- **Saída:** um arquivo por UF, `data/colinha/AAAA_UF.json` (presidente fica em `AAAA_BR.json`):
  `{"ano", "data_tse", "cargos": {cargo: [candidato, ...]}, "partidos": [[número, sigla], ...]}`.
  Cada candidato é a lista `[número, nome de urna, sigla, número do partido, pid, SQ, UE, alerta,
  companheiros de chapa, redes sociais, votos 1º turno, votos 2º turno]`.
- **meta.json → colinha:** `{"ano", "turno", "data_eleicao", "data_tse", "ufs"}`. A `data_eleicao` vem de
  `RESULTADOS_PORTAL[ano]["data_turno1"]` ou `["data_turno2"]`.

### 2. Modo 2º turno (automático)

Quando os resultados do 1º turno chegam pelo portal do TSE (`RESULTADOS_PORTAL`) e algum candidato a presidente
ou governador fica com resultado "2º TURNO", a colinha passa a mostrar **só quem disputa o 2º turno**. Ela gera
arquivo para todas as UFs (todos votam para presidente) e ordena pelos votos do 1º turno.

Atenção: depois da apuração do 2º turno, o resultado vira "ELEITO"/"NÃO ELEITO" e essa detecção deixa de
valer. É o momento de desligar a colinha.

### 3. Página (site/app.js)

- **Ordem da urna:** `VAGAS_COLINHA` define as vagas e os dígitos de cada uma:
  dep. federal 4 · dep. estadual/distrital 5 · senador 3 (dois votos em 2026) · governador 2 · presidente 2.
- **Filtros:**
  - busca por nome ou número em cada vaga;
  - filtro por **partido** nas vagas de deputado: escolher só o partido equivale ao voto de legenda, e o
    número do partido vai para o cartão;
  - filtro por **espectro**, válido para todas as vagas, com gráfico de distribuição.
- **Escolhas do eleitor:** guardadas só no navegador dele (`localStorage`, chave `colinha_<ano>[_t2]_<UF>`).
  Nada é enviado ao servidor.
- **Impressão:** `#colinha=1&uf=XX&imprimir=1` monta o cartão com 90 mm de largura (`style.css`, `@media print`).

## Checklist para a próxima eleição

1. **Eleição geral (2030), mesmos cargos:**
   - [ ] Baixar do TSE `consulta_cand_AAAA.zip` e `consulta_cand_complementar_AAAA.zip` e enviar ao release
     privado `dados-tse`. Repetir perto da eleição (ex.: sexta e sábado antes), porque situações mudam.
   - [ ] Conferir `VAGAS_COLINHA`: número de vagas de senador (1 ou 2 votos, alternando a cada eleição) e dígitos.
   - [ ] Atualizar `RESULTADOS_PORTAL` com o ciclo e os códigos das eleições no portal
     (`federal`, `estadual`, `federal2`, `estadual2`) e as datas `data_turno1` e `data_turno2`.
   - [ ] Trocar o texto fixo do botão em `site/index.html` (a data é sobrescrita pelo `app.js`).
   - [ ] `COLINHA_ATIVA = True` e rodar o workflow.
2. **Eleição municipal (2028), prefeito e vereador:** exige adaptação antes de religar.
   - [ ] Incluir `PREFEITO` e `VEREADOR` em `CARGOS_COLINHA`.
   - [ ] Gerar um arquivo por **município**, e não por UF. Um arquivo por UF com todos os vereadores do estado
     ficaria grande demais.
   - [ ] Em `VAGAS_COLINHA`: vereador (5 dígitos, com voto de legenda) e prefeito (2 dígitos), nessa ordem.
   - [ ] Na página: escolher o município depois da UF (a lista de municípios já existe em
     `data/municipio/UF.json`).
3. **Depois da eleição:** `COLINHA_ATIVA = False` e rodar o workflow.
