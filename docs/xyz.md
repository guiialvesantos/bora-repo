# A camada XYZ — o quanto dá para confiar na previsão de cada item

Nova em set/2026. O ABC responde "**o que importa?**" (fatia do faturamento).
O XYZ responde "**o quanto a previsão deste item é confiável?**". Juntas, as
duas letras dizem onde o olho humano vale mais: um item **AZ** — importante E
errático — é onde o modelo mais erra e onde o erro custa mais.

Analogia: previsão do tempo. Para o deserto (X), a previsão de amanhã quase
nunca erra; para a serra (Z), o mesmo meteorologista com os mesmos dados erra
o tempo todo. O problema não é o meteorologista — é a natureza da série. XYZ
classifica cada SKU pelo "clima" da sua demanda.

**O que a camada NÃO faz:** não entra no motor. `replenishment_calc` não lê
nada daqui — nenhum ES, PP ou EMax muda por causa do XYZ. O núcleo matemático
está congelado; XYZ é lente, não alavanca.

---

## Como a classe é calculada

### Eixo principal: o coeficiente de variação (CV)

```
CV = σ ÷ demanda semanal ponderada
```

É o "nervosismo relativo": um σ de 8 é enorme para quem vende 2 por semana
(CV 4,0) e irrisório para quem vende 80 (CV 0,1). Dividir pelo volume é o que
permite comparar um carro-chefe com um item de nicho na mesma régua.

**Exemplo.** O anel do `motor.md`: σ = 8, demanda = 9,4/semana →
CV = 8 ÷ 9,4 = **0,85** → classe **X**.

### Os cortes são da Triana, não da literatura

| Classe | Regra | Leitura |
|---|---|---|
| **X** | CV ≤ 1,0 | previsível |
| **Y** | 1,0 < CV ≤ 1,6 | intermediário |
| **Z** | CV > 1,6 | errático |

Os manuais sugerem cortes tipo 0,5/1,0 — calibrados para bens de consumo de
giro rápido. Semijoia tem demanda intermitente por natureza: com os cortes
genéricos quase toda a base cairia em Z e a classe não separaria nada (um
alarme que toca sempre não avisa nada). Os cortes 1,0/1,6 são os **tercis da
distribuição de CV da própria base** (128 itens em coleção, medidos em
13/09/2026: p33 ≈ 1,02, p66 ≈ 1,61), e ficam em `replenishment_params`
(`xyz_cut_x`, `xyz_cut_y`) — outra empresa, ou a própria Triana no futuro,
recalibra publicando uma versão nova de parâmetros.

Verificação de sanidade na base: a classe A ficou 16 X / 2 Y / 1 Z, a classe C
ficou 2 X / 28 Y / 36 Z. Itens de alto faturamento vendem de forma mais
estável — exatamente o padrão esperado; se a matriz saísse uniforme, os cortes
estariam separando ruído.

### Refinamento: o erro histórico do forecast

A segunda fonte é a tabela `forecast_accuracy`: para cada SKU, o **erro que o
modelo vivo de fato cometeu no passado**, medido pelo mesmo backtest rolling
que escolheu o modelo (cortes a cada 28 dias, horizontes de 8/12/16 semanas —
4 é ruído de uma semana de sorte, 24 quase não tem origem elegível):

```
wMAPE do SKU = Σ|previsto − real| ÷ Σreal      (nulo se Σreal = 0)
viés do SKU  = Σ(previsto − real) ÷ Σreal      (+ superestima, − subestima)
origens      = nº de datas de corte em que o SKU já existia
```

**O erro nunca decide a classe** — só o CV decide. Motivo: um slow mover que
vende 1 peça/semana tem wMAPE enorme *por construção* (errar 1 peça = errar
100%), e deixá-lo rebaixar a classe puniria o item por ser pequeno, não por
ser imprevisível. O erro entra como **contexto**, no formato honesto acordado:

```
AZ · erro histórico típico ±38% · 6 origens
```

Nunca "confiança: 89%" — uma porcentagem única de confiança é pseudo-precisão
que a base não sustenta. Recalculado toda semana pelo cron
`forecast-accuracy-weekly` (domingo 03:50 BRT); um corte novo de backtest só
nasce a cada ~28 dias de venda.

### Estados especiais (tão importantes quanto as classes)

| Estado | Quando | Por quê |
|---|---|---|
| **n/c** — não classificada | menos de 4 semanas de histórico (`low_confidence`) ou demanda zero | Classificar um lançamento de 2 semanas como Z transmitiria certeza falsa. "Ainda não sei" é a resposta honesta. |
| **sem erro medido** | wMAPE nulo (o realizado somou zero em todas as janelas avaliadas) | Não é erro zero nem erro infinito — é ausência de métrica honesta. Mostra-se o motivo, não um número. |
| **sem histórico de backtest** | SKU lançado depois do último corte elegível | O backtest ainda não teve chance de avaliá-lo. |

---

## Onde aparece na interface (Painel)

1. **Chip ao lado da classe ABC** na tabela por SKU — `A` + `X/Y/Z` (Z em
   âmbar), com o CV e a linha de erro no tooltip; `n/c` para os não
   classificados.
2. **Filtro de previsibilidade** — X / Y / Z / baixa amostra.
3. **Prioridade de atenção** — card que lista AZ primeiro, depois AY e BZ,
   ordenados por faturamento: são os itens para conferir à mão antes de
   aprovar o pedido. O resto pode rodar no automático.
4. **Matriz 3×3 ABC × XYZ** — o mapa da base inteira; o canto AZ acende em
   âmbar quando habitado.

## A implementação em uma linha

A classe é derivada **na leitura** (`src/lib/xyz.ts`), dos campos que o
snapshot já tem (σ e demanda) com os cortes dos parâmetros — por isso todas as
telas concordam, nenhuma migration de engine foi necessária e o núcleo segue
congelado. O banco só ganhou a tabela `forecast_accuracy` e a função
`forecast_accuracy_rebuild()` (migration `0018_xyz.sql`).
