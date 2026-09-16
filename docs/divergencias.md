# Divergências entre a planilha e o motor

> **Nota histórica.** Este documento descreve o *nascimento* do sistema em modo
> paridade com a planilha. As chaves de correção abaixo **já foram viradas** —
> a coluna "Corrigido" da tabela é o estado vivo desde os parâmetros v2 — e o
> motor evoluiu além delas (modelo de demanda novo na v4, âncora do σ na v5).
> A lógica atual, com fórmulas e exemplos, está em `motor.md`; a camada XYZ de
> previsibilidade, em `xyz.md`.

A planilha `Cálculo de Pedido Triana.xlsx` foi auditada célula a célula antes de
uma linha de código ser escrita. Cinco achados mudam número na tela.

O sistema **nasce reproduzindo todos os cinco**, inclusive os erros. Isso não é
conservadorismo: é a única forma de provar que a migração não perdeu nada. O
harness `scripts/parity.mjs` compara 248 SKUs contra `Processamento` e os sete
agregados contra `Variáveis`, e derruba o build em qualquer desvio.

Cada achado tem uma chave em `replenishment_params`. Virar uma chave publica uma
versão nova (a tabela é append-only), o que deixa no banco a data, o autor e o
snapshot de antes e de depois. Quando o pedido de uma semana vier 40% maior que
o da anterior, a resposta está no banco.

| # | Achado | Chave | Legado | Corrigido |
|---|---|---|---|---|
| 1 | Janela de 28 dias ancorada em `TODAY()` | `recent_window_anchor` | `today` | `reference_date` |
| 2 | Estoque de segurança para item fora de coleção | `safety_stock_for_out_of_collection` | `true` | `false` |
| 3 | σ lido de uma base colada à mão | `sigma_source` | `external` | `computed` |
| 4 | Em trânsito perdido por espaço em branco | `sku_match_mode` | `exact` | `normalized` |
| 5 | Descontinuado perdido por espaço em branco | `sku_match_mode` | `exact` | `normalized` |

Os achados 4 e 5 são o mesmo bug em dois lugares, então dividem uma chave só:
virar um sem virar o outro não faz sentido.

---

## 1 — A demanda estimada está pela metade

**O que acontece.** A coluna `N` (`venda semanal 28 dias`) filtra as vendas por
`>= TODAY()-28`. A coluna `K`, ao lado, ancora na **maior data de venda da
base**. A base termina em **03/08/2026**; a planilha foi aberta em **11/09/2026**.
A janela pede vendas a partir de 14/08/2026 — depois do fim da base.

Resultado: `N = 0` nos **248 SKUs**, sem exceção. E como

```
O (venda ponderada) = (M + N) / 2
```

toda a demanda estimada do sistema está exatamente **metade** do que deveria.
`O` alimenta `PP` e `EMax`, então todo ponto de pedido e todo estoque máximo da
planilha estão subdimensionados.

**Por que ninguém percebeu.** Não há erro na tela. `N = 0` parece "não vendeu
nas últimas 4 semanas", que é uma leitura plausível — e que fica plausível para
sempre, porque a base nunca alcança o relógio.

**Impacto.** Não é um ajuste fino: é um fator 2 na projeção de demanda. Virar
esta chave é a mudança de maior efeito das cinco, e é a que deve ser virada
primeiro depois que a importação estiver rodando com dados frescos.

**No motor.** Com `recent_window_anchor = 'reference_date'` a janela passa a
ancorar na mesma data que a coluna `K` — a maior data de venda — e as duas
colunas voltam a falar do mesmo período.

---

## 2 — O estoque de segurança de item fora de coleção entra no agregado

**O que acontece.** O briefing diz que item fora de coleção não recebe estoque
de segurança. A planilha diz o contrário: a coluna `T` **calcula** `ES` para os
125 itens fora de coleção (700 peças no total) e esses 700 entram no agregado.

Só `PP` (`U`) e `EMax` (`V`) é que ficam em branco.

**A prova.** `Variáveis!L7` (estoque de segurança a preço de venda) vale
**426.670**. Somando só os itens em coleção daria **285.235**. A diferença —
R$ 141.435 — são exatamente os 700 itens fora de coleção.

Ou seja: o número que a Triana usa hoje inclui estoque de segurança para peça
que ela decidiu não repor. Quando a planilha diz que precisa manter R$ 426 mil
de segurança, R$ 141 mil disso é para item que vai sair do catálogo.

**Impacto.** Nenhum no pedido de compra (`Z` depende de `U` e `V`, que são
nulos). Todo o impacto está no dimensionamento de capital de giro.

**No motor.** `safety_stock_for_out_of_collection = false` deixa `T` nulo junto
com `U` e `V`, e o agregado cai para os R$ 285.235 reais.

---

## 3 — O desvio-padrão não é calculado, é colado

**O que acontece.** A coluna `Q` não calcula nada: é um `XLOOKUP` numa tabela
colada à mão, com **0 como valor padrão** quando o SKU não está lá.

σ entra direto em `ES = CEIL(Z × σ × √(lead time em semanas))`. σ = 0 ⇒ ES = 0.

**A armadilha.** Um lançamento que começou a vender **depois** do dia em que a
tabela foi colada não está nela, recebe σ = 0, recebe ES = 0 — **em silêncio**.
Não há célula de erro, não há `#N/D`: a fórmula tem valor padrão. Hoje nenhum
item em coleção está nessa situação, o que significa que a bomba está armada e
não explodiu ainda.

**Quando a tabela foi colada.** 10/07/2026. Isso não estava documentado em lugar
nenhum — foi descoberto varrendo todos os cortes de venda possíveis e medindo,
para cada um, quantos σ o cálculo interno reproduz. Em 10/07/2026 (49 semanas de
histórico) o cálculo reproduz **223 dos 443** SKUs bit a bit. Em qualquer outro
corte, um punhado.

Isso é a confirmação de que **o método está certo e a base é que está velha**: os
220 que não batem divergem porque venderam depois do congelamento, não porque a
conta esteja errada.

O método reproduzido: buckets semanais de 7 dias ancorados na **menor data de
venda da empresa** (não do item — cada SKU numa régua própria daria σ
incomparável entre itens), semanas sem venda contam como zero, desvio
**amostral** (n−1). O populacional não reproduz nenhum dos 443.

**No motor.** `sigma_source = 'computed'` deriva σ do próprio histórico a cada
cálculo, e a tabela `external_sigma` fica como ponte para o teste de paridade —
não como destino. Itens com menos de 4 semanas de histórico ganham
`low_confidence = true`: o número continua na tela, mas marcado.

---

## 4 — 757 peças em trânsito invisíveis

**O que acontece.** `SUMIF` e `COUNTIF` do Excel ignoram a caixa das letras mas
**não aparam espaço em branco**. As referências que vêm do fornecedor chegam
sujas: `'C03CL51O  '`, `' C25AN01P'`.

São **13 referências com espaço**, afetando 9 dos 248 SKUs. O arquivo de trânsito
tem **4.286 peças**; a planilha enxerga **3.529**. **757 peças** estão a caminho
e não aparecem em lugar nenhum.

**O que isso custa.** Trânsito invisível vira compra em duplicidade, porque
`Y` (comprar?) testa `E + W <= U`:

> **C27PG02O** — estoque 4, ponto de pedido 9, **30 peças já em trânsito**.
> A planilha manda comprar 10.
> Com `W = 30`, `4 + 30 = 34 > 9`: não deveria comprar nada.

Uma linha inteira do pedido de compra da semana existe só porque um SKU tinha
dois espaços no fim.

**No motor.** `sku_match_mode = 'normalized'` casa por `sku_norm`
(`upper(btrim(sku))`), e as 757 peças aparecem. Em modo `exact` o motor compara
por `sku_upper` (`upper(sku)`, sem aparar), que é literalmente o que o Excel faz.

As duas colunas geradas existem lado a lado em `products`,
`purchase_order_items`, `sales_order_items`, `discontinued_items` e
`external_sigma` justamente para que virar a chave seja uma troca de coluna e
não uma reescrita.

---

## 5 — Dois descontinuados contam como em coleção

**Mesmo bug, outro lugar.** A lista de itens fora de coleção tem **5 códigos com
espaço**. O `COUNTIF` da coluna `X` não os encontra, então dois itens que a
Triana tirou do catálogo continuam sendo tratados como em coleção:

- **C31BR02O**
- **C31BR02P**

Como estão "em coleção", os dois recebem `PP` e `EMax`, entram na curva ABC
(deslocando o ponto de corte de todo mundo) e podem entrar no pedido de compra.
É comprar item que foi decidido descontinuar.

**Confirmado no caminho:** o `COUNTIF` **é** insensível à caixa — há 259 códigos
na lista com caixa diferente da do catálogo, e o `in_collection` reproduz 248/248
usando `upper()` **sem** aparar. Não é que o Excel compare texto cru; é que ele
apara caixa e não apara espaço.

**No motor.** Mesma chave do achado 4: `sku_match_mode = 'normalized'`.

---

## O que o harness garante

`npm run parity` semeia um banco local com os mesmos artefatos de hoje, publica
os parâmetros em modo legado (`today_override = 2026-09-11`,
`recent_window_anchor = 'today'`, `safety_stock_for_out_of_collection = true`,
`sigma_source = 'external'`, `sku_match_mode = 'exact'`) e compara:

- **Tier 0 — igualdade inteira exata, 248 linhas.** `in_collection`, `abc_class`,
  `safety_stock`, `reorder_point`, `max_stock`, `in_transit`, `should_order`,
  `qty_to_order`. São os números em que alguém gasta dinheiro; um desvio derruba
  o build.
- **Tier 1 — 1e-9 relativo.** `cmv_used`, `weeks_in_catalog`, `total_sales`,
  `weekly_*`, `z`.
- **Tier 2 — σ.** Numa empresa própria, onde todo SKU que já vendeu vira produto
  (preço e estoque zero). Motivo: dos 443 SKUs da base legada só 202 continuam no
  catálogo, e justamente os que continuam são os que mais venderam depois do
  congelamento — medir só neles daria 38 acertos e esconderia que o método está
  certo.
- **Tier 3 — os sete agregados de `Variáveis`, ao centavo**, mais as contagens
  (248 SKUs, 123 em coleção, ABC 20/35/68, 9 linhas de pedido, 283 peças).
- **Tier 4 — as três constantes Z** do AS241.

### Duas coisas que o harness pegou e a planilha não tinha como pegar

**`weeks_in_catalog` dos 36 SKUs sem venda.** A planilha mostra **6605,29**. Não
é um número: é `MINIFS` sem correspondência devolvendo o serial 0
(30/12/1899), e a fórmula medindo a distância dali até hoje em semanas. O motor
grava nulo e o Tier 1 pula esses 36 — reproduzir 6605 seria pôr um artefato do
Excel na tela de alguém.

**Uma peça a mais em 6 SKUs.** `80::numeric / 7` fecha em escala 16
arredondando para **cima** (`11,4285714285714286`), então
`0,175 × isso = 2,000000000000000005` e o `CEIL` cobra uma peça que não existe.
Escrito como `O × 80 / 7` — multiplicando antes de dividir — o mesmo caso fecha
em 2 exato. Eram 6 SKUs com `PP` e `EMax` uma peça acima e **R$ 1.511 a mais** no
estoque máximo. Nenhuma tela mostraria isso.

Pela mesma razão a aritmética do motor é toda em `numeric` e nunca em
`double precision`: `round(numeric)` no Postgres arredonda meio-para-longe-de-zero,
igual ao `ROUND` do Excel, enquanto `round(double precision)` arredonda para o
par mais próximo e divergiria em todo `EMax` terminado em `,5`.
