# Como o motor calcula — do histórico de vendas ao pedido de compra

Este documento explica a lógica viva do sistema (parâmetros **v5**, set/2026),
com as fórmulas reais, exemplos numéricos e o porquê de cada escolha. Para a
arqueologia da planilha que o sistema substituiu, ver `divergencias.md`.

A ideia em uma frase: **olhar o que cada peça vendeu por semana, medir o quanto
essa venda balança, e manter estoque suficiente para atravessar os ~80 dias que
uma compra leva para chegar — sem estourar capital em peça que não gira.**

---

## O fluxo em cinco passos

```
vendas (Tiny) ─┐
estoque        ├─► replenishment_calc ─► snapshot ─► 4 telas leem o MESMO snapshot
em trânsito    │      (o motor, em SQL)
fora de coleção┘
```

Toda tela (Painel, Pedido de Compra, Curva ABC, Saúde dos Dados) lê do mesmo
`snapshot_id`. É o que impede duas telas de discordarem entre si — o defeito
clássico de recalcular ao vivo em cada página.

Os parâmetros são **versionados e append-only**: ninguém edita a versão
corrente; muda-se publicando uma versão nova, com data, autor e snapshot de
antes e de depois. Quando o pedido de uma semana vier 40% maior que o da
anterior, a resposta está no banco.

---

## Passo 1 — A data de referência

O motor não usa "hoje" do relógio: usa a **maior data de venda da base**
(`reference_date_mode = 'max_sale_date'`). Analogia: um médico não mede a
febre pelo horário da consulta, mede pelo termômetro. Se a sincronização parou
há 5 dias, ancorar em "hoje" faria as janelas recentes pescarem num período sem
dados — exatamente o bug que deixou a demanda da planilha pela metade durante
meses (achado nº 1 de `divergencias.md`).

## Passo 2 — A demanda semanal (`weekly_blended`)

**Modelo vivo: `weighted_90_180`** (desde os parâmetros v4):

```
D90  = vendas dos últimos 90 dias  ÷ 13   (semanas)
D180 = vendas dos últimos 180 dias ÷ 26

demanda semanal = 0,7 × D90 + 0,3 × D180
```

Analogia: para adivinhar o trânsito de amanhã, o que você fez **neste mês**
vale mais do que a média do semestre — mas a média do semestre evita que um
feriado atípico te engane. 70% recente, 30% estrutural.

**Exemplo.** Um anel vendeu 130 peças nos últimos 90 dias e 208 nos últimos 180:

```
D90  = 130 ÷ 13 = 10,0 por semana
D180 = 208 ÷ 26 =  8,0 por semana
demanda = 0,7 × 10 + 0,3 × 8 = 9,4 peças/semana
```

**Por que este modelo e não outro.** Ele não foi escolhido por parecer
sofisticado: foi o vencedor de um backtest rolling — voltamos no tempo em 8
datas de corte, fingimos não conhecer o futuro, previmos 4/8/12/16/24 semanas à
frente e medimos o erro contra o que realmente aconteceu (2.264 observações):

| Modelo | Erro (wMAPE) geral | Erro na classe A |
|---|---:|---:|
| Legado da planilha (média vida toda + 28d) ÷ 2 | 0,631 | 0,529 |
| **0,7×D90 + 0,3×D180 (vivo)** | **0,458** | **0,321** |

O modelo legado errava ~53% nos itens que mais importam; o vivo erra ~32%.
Variantes testadas e rejeitadas: 50/30/20 com janela de 28d (empata com o
legado), fator de tendência (piora tudo), só-D90 (bom no backtest, frágil
demais numa janela única).

## Passo 3 — O desvio-padrão σ (o "nervosismo" da demanda)

Se todo SKU vendesse a mesma quantidade toda semana, estoque de segurança seria
desnecessário. O σ mede o quanto a venda semanal balança em torno da média.

**Como é calculado:** a história da empresa é dividida em **baldes de 7 dias**;
cada balde recebe a soma de vendas do SKU naquela semana (semana sem venda =
balde com zero); σ é o desvio **amostral** (n−1) desses baldes.

**A régua começa na primeira venda do SKU** (`sigma_anchor = 'sku_first_sale'`,
desde os parâmetros v5). A regra conceitual:

> Semana anterior à primeira venda do SKU não é demanda zero.
> É **ausência de observação**.

Um colar lançado há 12 semanas não "vendeu zero" nas 45 semanas anteriores —
ele não existia. Contar essas semanas (o comportamento legado) parecia
inofensivo, mas fazia o oposto do que se imagina:

**Demonstração numérica.** Lançamento com 4 semanas de vida vendendo
`20, 0, 10, 0`:

```
Só as 4 semanas de vida (correto):
  média = 7,5 → σ = √[(12,5² + 7,5² + 2,5² + 7,5²) ÷ 3] = √91,7 ≈ 9,6

Com 50 zeros de antes do lançamento (legado):
  54 observações, média = 30 ÷ 54 ≈ 0,56 → σ ≈ 3,0
```

Os zeros pré-existência **diluíam** o σ para um terço. Lançamento é justamente
o padrão mais errático (`20, 0, 10, 0`...), e o sistema legado o tratava como o
mais comportado — sub-protegendo exatamente onde há menos histórico para
confiar. O diff de ativação confirmou: σ **subiu** em 93 dos 128 itens em
coleção (mediana +243% nos SKUs com <4 semanas), o estoque de segurança
agregado foi de 997 → 1.130 peças (R$ 56,3 mil → R$ 63,3 mil a CMV) e os
veteranos de 50+ semanas não mudaram nada. Coerente com as 66 rupturas reais
observadas no período.

**Proteções:**
- menos de **4 semanas** de vida → `low_confidence = true` (o número aparece
  marcado na tela, e o item vira "não classificado" na camada XYZ);
- menos de **2 semanas** → não existe desvio amostral honesto de 1 observação;
  σ fica nulo (ES = 0) até a segunda semana, documentado, nunca silencioso.

## Passo 4 — Curva ABC e nível de serviço

Os itens em coleção são ordenados por faturamento semanal
(`demanda × preço de venda`) e cortados pelo acumulado:

- **A** — até 50% do faturamento acumulado (`abc_cut_a = 0,50`)
- **B** — até 80% (`abc_cut_b = 0,80`)
- **C** — o resto

Analogia: a fila do embarque prioritário. Poucos itens pagam a maior parte da
conta e ganham tratamento mais caro; deixar um C faltar custa menos do que
deixar um A faltar.

Cada classe compra um **nível de serviço** — a probabilidade de não faltar
durante o reabastecimento:

| Classe | Nível de serviço | Z |
|---|---:|---:|
| A | 97,5% | 1,960 |
| B | 95,0% | 1,645 |
| C | 90,0% | 1,282 |

O Z é o quantil da curva normal (`norm_s_inv`, algoritmo Wichura AS241,
calculado **no banco** para que o número da tela venha do mesmo caminho de
código do número do snapshot). Item em coleção sem classe usa o nível de C.

## Passo 5 — As três alturas de estoque e a decisão

Com demanda (passo 2), σ (passo 3) e Z (passo 4), e os parâmetros
`lead_time = 80 dias` e `ciclo de pedido = 2 semanas`:

```
ES   (estoque de segurança) = ⌈ Z × σ × √(80/7) ⌉
PP   (ponto de pedido)      = ⌈ ES + demanda × 80/7 ⌉
EMax (estoque máximo)       = arredonda( PP + demanda × 2 )

comprar?        estoque + em trânsito ≤ PP  (e o item está em coleção)
quanto comprar? EMax − estoque − em trânsito
```

Lendo em português: o **ES** é o colchão contra o nervosismo da demanda durante
as ~11,4 semanas de viagem da compra (analogia: sair mais cedo para o aeroporto
porque o trânsito é incerto — quanto mais incerto (σ) e mais importante o voo
(Z), mais cedo se sai). O **PP** é o colchão mais o consumo esperado até a
compra chegar. O **EMax** cobre ainda o ciclo entre um pedido e o próximo.

**Exemplo completo** (o anel do passo 2, classe A, σ = 8):

```
ES   = ⌈1,96 × 8 × √11,43⌉ = ⌈53,0⌉ = 54 peças
PP   = ⌈54 + 9,4 × 11,43⌉  = ⌈161,4⌉ = 162 peças
EMax = arredonda(162 + 9,4 × 2) = 181 peças

Estoque atual 100 + em trânsito 30 = 130 ≤ 162  → comprar
Quantidade: 181 − 130 = 51 peças
```

Duas miudezas que valem dinheiro: o em-trânsito casa por SKU **normalizado**
(`upper(btrim(...))` — espaço em branco no fim do código já escondeu 757 peças
e gerou compra duplicada), e toda a aritmética é `numeric`, nunca `double
precision` (o `round` do Postgres em `numeric` arredonda como o Excel;
em `double` arredonda para o par e divergiria em todo EMax terminado em ,5).

---

## Sobre o resultado: a camada XYZ

O ABC diz **o que importa**; a camada XYZ (nova, set/2026) diz **o quanto dá
para confiar na previsão de cada item**. Ela fica fora do motor — é lente, não
alavanca. Documentada em `xyz.md`.

---

## Como o motor evolui sem quebrar confiança

Toda mudança de comportamento segue o mesmo ritual, sem exceção:

1. **Flag nos parâmetros**, nascendo no comportamento antigo — a migration
   sozinha não muda nenhum número (provado por checksum: o cálculo antes e
   depois de aplicar é bit a bit igual).
2. **Diff de impacto obrigatório**: o mesmo cálculo com a flag ligada e
   desligada, lado a lado — distribuição da mudança, top 20, impacto em peças,
   reais e por classe ABC.
3. **Análise humana e aprovação** — inclusive quando o resultado contraria a
   hipótese (no sigma_anchor esperávamos σ cair em lançamentos; ele **subiu**,
   e a publicação só saiu depois de entender e aprovar a inversão).
4. **Publicação versionada** com snapshot antes e depois. Rollback = publicar
   de volta a flag antiga.

E a régua de admissão de qualquer ideia nova:

> **Modelos novos precisam vencer a referência fora da amostra ou melhorar o
> resultado econômico. Correções de definição precisam provar que a regra
> atual representa incorretamente o fenômeno e mostrar seu impacto por diff.**

Nada entra no motor porque parece sofisticado.

### Linha do tempo das versões de parâmetros (Triana)

| v | Quando | O que mudou | Natureza |
|---|---|---|---|
| 1 | 12/09/2026 | Nascimento em modo paridade com a planilha (σ já computado internamente) | — |
| 2 | 12/09/2026 | Chaves de correção viradas: janela recente ancorada na data de referência, ES só em coleção, SKU normalizado | correções de definição |
| 3 | 13/09/2026 | Ciclo de pedido 16 → 2 semanas | decisão de negócio |
| 4 | 13/09/2026 | `demand_model = weighted_90_180` | modelo novo, venceu no backtest |
| 5 | 13/09/2026 | `sigma_anchor = sku_first_sale` | correção de definição, provada por diff |
