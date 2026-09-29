# Lente Pública

Digite o nome de uma pessoa e veja:

- se ela **já foi candidata** (eleições de 1994 a 2026);
- se **já foi eleita**, para quais cargos e onde;
- por quais **partidos** concorreu;
- a **evolução do patrimônio declarado** ao TSE (2006 em diante), por tipo de bem e corrigida pelo IPCA;
- a variação do patrimônio **durante cada mandato** e a comparação com os demais eleitos do mesmo cargo;
- perfil (nascimento, gênero, cor/raça, instrução, ocupações declaradas), coligações e **companheiros de chapa**
  (vices e suplentes, com link para a ficha de cada um).

🔎 **Site:** https://lentepublica.com.br

Todos os dados vêm do [Portal de Dados Abertos do TSE](https://dadosabertos.tse.jus.br).

## Como funciona

```
TSE (zip) ──► repo PRIVADO raio-x-politico-dados ──► GitHub Actions (scripts/build.py) ──► GitHub Pages (site/)
              (release "dados-tse", CPF completo)                                          (CPF mascarado)
```

1. **Dados brutos** — os arquivos `consulta_cand_AAAA.zip` (candidaturas) e `bem_candidato_AAAA.zip`
   (bens declarados) contêm CPF completo e por isso ficam na release `dados-tse` do repositório
   **privado** `raio-x-politico-dados`, que também é a base do módulo de investigação (uso restrito).
   O CDN do TSE bloqueia downloads automatizados, por isso eles são baixados por um navegador
   e enviados para a release. O workflow lê esse repositório com o secret `DADOS_TOKEN`
   (fine-grained token, permissão *Contents: read* apenas em `raio-x-politico-dados`).
2. **Processamento** — `scripts/build.py`:
   - lê o CSV nacional de cada ano, mantém a linha do último turno de cada candidatura;
   - soma os bens declarados por candidatura;
   - **agrupa as candidaturas da mesma pessoa** ligando CPF, título de eleitor e nome + data de nascimento
     (o CPF deixou de ser divulgado em alguns anos; o título e a data de nascimento cobrem esses casos);
   - gera um índice de busca estático (`site/data/idx/`) e as fichas das pessoas (`site/data/p/`).
   No site o CPF aparece **mascarado** (`***.456.789-**`, padrão do Portal da Transparência) para ajudar
   a distinguir homônimos; o CPF completo e o título de eleitor **não** são publicados.
3. **Site** — HTML/CSS/JS puro em `site/`, sem servidor: a busca baixa só os pedaços do índice necessários.

## Como buscar

- Use o **nome completo** ou o **nome de urna** (ex.: “Lula”, “Tiririca”). Acentos e maiúsculas não importam.
- A busca combina o primeiro nome com os demais: “Jair Bolsonaro” encontra “Jair Messias Bolsonaro”.
- Nomes muito comuns pedem mais sobrenomes.

## Atualizar os dados

1. Baixe os novos zips em https://dadosabertos.tse.jus.br (conjuntos “Candidatos – AAAA”:
   recursos “Candidatos” e “Bens de candidatos”).
2. Envie para a release do repositório privado, substituindo os antigos:
   ```bash
   gh release upload dados-tse -R FernandoCunhaJunior/raio-x-politico-dados consulta_cand_2026.zip bem_candidato_2026.zip --clobber
   ```
3. Rode o workflow **“Gerar dados e publicar site”** em *Actions* (ou `gh workflow run build.yml`).

Para testar mais rápido, o workflow aceita a entrada `anos` (ex.: `2022,2024`).

### Rodar localmente

```bash
pip install -r requirements.txt
gh release download dados-tse -R FernandoCunhaJunior/raio-x-politico-dados --dir raw --pattern "*.zip"  # requer acesso ao repo privado
python scripts/build.py --raw raw --out site/data
python -m http.server -d site 8000
```

## Limitações

- “Ocupou cargo” aqui significa **ter sido eleito(a)**. Cargos por nomeação (secretários, ministros etc.)
  não constam nas bases do TSE. Eleito não garante posse nem mandato completo; suplentes que assumiram não
  são identificados.
- Bens só existem a partir de 2006 e são **valores nominais**, como declarados (sem correção pela inflação).
- O agrupamento de pessoas é automático: homônimos antigos (anos sem CPF/título) podem aparecer separados
  ou, raramente, misturados.
- Os dados de 2026 são preliminares e mudam até o fim das eleições.

## Licença

Código sob licença MIT. Os dados são do TSE (licença Creative Commons Attribution).
