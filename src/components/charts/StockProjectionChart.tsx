import { useId, useMemo } from 'react'
import { AlertTriangle, Clock, ShoppingCart, Truck } from 'lucide-react'
import {
  Area, ComposedChart, Label, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

/**
 * Projeção de estoque — o que substituiu o dente-de-serra didático que ficava
 * aqui. Aquele desenho tinha geometria fixa em pixels: não mudava de SKU para
 * SKU, não mudava se o estoque dobrasse, e por isso não havia nada a tirar
 * dele.
 *
 * Este desce pela demanda real de cada item e responde a pergunta que faz
 * alguém abrir a tela: QUANDO acaba, e até quando dá para pedir sem faltar.
 *
 * **Passo de um dia, não de uma semana.** O produto do gráfico é uma data — "a
 * ruptura é 25 de setembro", "peça até 18". Simulando de sete em sete dias a
 * resposta só existiria em múltiplos de semana, e um erro de até seis dias na
 * data de pedir é grande demais quando o lead time é de sete.
 *
 * São dois cenários:
 *
 *   - área cheia: ninguém repõe. Desce até zerar. É o custo de não fazer nada.
 *   - linha tracejada: a política (s,S) rodando sozinha — toda vez que a
 *     posição cruza o PP, pede até o Emáx, e a carga entra no lead time. É
 *     daqui que sai o dente de serra. Simular só a compra de hoje não serrilha
 *     nada: dá um degrau e volta a descer para sempre.
 *
 * A simulação é POR ITEM e só depois somada. Somar primeiro e derivar uma reta
 * do total mentiria: um SKU que zera na semana 3 passaria a ser coberto pelo
 * estoque de outro. Item a item, cada um trava no zero e o agregado encurva.
 *
 * Como efeito colateral, o agregado NÃO serrilha, e isso é correto: centenas de
 * SKUs repondo cada um no seu ciclo estão fora de fase, os dentes se cancelam e
 * o que sobra é o nível médio para onde a política leva a carteira. A serra é
 * um fenômeno de UM item; a carteira tem patamar, não dente.
 */

export interface ProjectionItem {
  stock: number
  inTransit: number
  /** Demanda semanal combinada (weekly_blended). */
  weekly: number
  reorderPoint: number
  safetyStock: number
  maxStock: number
  /** Quantidade que o motor sugeriu comprar (qty_to_order). */
  suggestedQty: number
  /** 1 para um SKU (peças); preço de venda no agregado (reais). */
  weight: number
  /**
   * O em-trânsito repartido pelas datas previstas, em dias a partir da
   * referência. A soma é sempre `inTransit`. Vazio (ou ausente) = chega tudo
   * hoje, que é o que a projeção assumia antes de existirem as previsões.
   */
  arrivals?: { day: number; qty: number }[]
  /** SKU, para poder NOMEAR o tamanho que falta primeiro numa grade. */
  label?: string
}

interface Props {
  items: ProjectionItem[]
  /** Data de referência do snapshot (yyyy-mm-dd) — o dia 0 da projeção. */
  referenceDate: string
  leadTimeDays: number
  formatValue: (v: number) => string
  /**
   * Muda o que as faixas respondem. Em `sku` são DATAS de travessia. Em
   * `portfolio` são CONTAGENS, porque a travessia do ponto de pedido somado
   * quase nunca acontece — basta um item sem giro para segurar o total acima
   * dela para sempre, e a faixa viraria "além de um ano" três vezes.
   */
  granularity: 'sku' | 'portfolio'
  /**
   * Sete pesos de média 1, por dia da semana (0 = domingo). Ausente = reta.
   * Só redistribui a venda dentro da semana; o total semanal não muda.
   */
  dailyProfile?: number[]
}

const MIN_HORIZON = 84
/**
 * Quatro anos. Parece exagero até aparecer um item com 2.240 peças vendendo
 * 1,7/dia: a recomendação de compra dele cai em 1.134 dias, e um teto de um ano
 * devolvia "—" em "Pedir até" — a tela prometia uma data e entregava travessão.
 * Quem tem esse estoque precisa ver justamente o quão longe está a recompra.
 */
const MAX_HORIZON = 1460

interface Point {
  day: number
  stock: number
  policy: number
}

function addDays(iso: string, days: number): Date {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + Math.round(days))
  return d
}

/**
 * Dia e mês. O ano só entra quando o horizonte passa de um ano — aí "08 de dez"
 * deixa de ser uma data e vira uma adivinhação entre três dezembros.
 */
function shortDate(d: Date, withYear = false): string {
  const s = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '')
  return withYear ? `${s} ${String(d.getFullYear()).slice(2)}` : s
}

function longDate(d: Date): string {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

/**
 * Teto e marcas do eixo em número redondo. Deixar o recharts dividir o máximo
 * real por cinco produz régua tipo "55 pç / 165 pç", que obriga a ler o rótulo
 * para saber onde a linha do Emáx caiu.
 */
function axisScale(peak: number): { top: number; ticks: number[] } {
  if (!(peak > 0)) return { top: 1, ticks: [0, 1] }
  const mag = 10 ** Math.floor(Math.log10(peak / 4))
  // Escada fina (1; 1,5; 2; 2,5; 3; 4; 5) porque com a escada grossa um pico de
  // 4,0 mi caía num teto de 5,0 mi e um quinto do gráfico ficava vazio.
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 10].map((m) => m * mag).find((s) => peak / s <= 6)
    ?? mag * 10
  const top = Math.ceil(peak / step) * step
  return {
    top,
    ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step),
  }
}

export function StockProjectionChart({
  items, referenceDate, leadTimeDays, formatValue, granularity, dailyProfile,
}: Props) {
  const leadDays = Math.max(1, Math.round(leadTimeDays))
  // O degradê é um `<defs>` dentro do SVG: com id fixo, dois gráficos na mesma
  // página compartilhariam o mesmo e o segundo roubaria o preenchimento.
  const fillId = `proj-fill-${useId().replace(/:/g, '')}`

  const model = useMemo(() => {
    const totals = items.reduce(
      (acc, i) => {
        acc.stock += (i.stock + i.inTransit) * i.weight
        acc.daily += (i.weekly / 7) * i.weight
        acc.reorderPoint += i.reorderPoint * i.weight
        acc.safetyStock += i.safetyStock * i.weight
        acc.maxStock += i.maxStock * i.weight
        acc.suggested += i.suggestedQty * i.weight
        return acc
      },
      { stock: 0, daily: 0, reorderPoint: 0, safetyStock: 0, maxStock: 0, suggested: 0 },
    )

    /**
     * O horizonte acompanha a PRIMEIRA falta, não a soma zerando.
     *
     * A linha verde é a soma das variações, então ela só encosta no zero quando
     * o último tamanho sai — numa grade de 32 peças isso cai fora de qualquer
     * horizonte, e o cartão devolvia "além de 1.351 dias" ao lado de um "lote
     * sugerido: 35 pç". Os dois não podem estar certos ao mesmo tempo: quem
     * precisa de compra é um tamanho, e é a data dele que se decide.
     */
    const firstZero = items.reduce((min, i) => {
      if (!(i.weekly > 0)) return min
      return Math.min(min, (i.stock + i.inTransit) / (i.weekly / 7))
    }, Infinity)
    // E precisa caber DOIS ciclos de reposição depois do lead time, senão a
    // política desenha um dente só — e um dente só não se lê como serra, se lê
    // como degrau.
    const cycleDays = totals.daily > 0
      ? Math.max(0, totals.maxStock - totals.reorderPoint) / totals.daily
      : 0
    // A falta tem que CABER com o lead time depois dela: "Pedir até" é falta
    // menos lead time, e a chegada da reposição vem depois.
    const horizon = Math.min(
      MAX_HORIZON,
      Math.max(
        MIN_HORIZON,
        leadDays + Math.ceil(2 * cycleDays),
        Number.isFinite(firstZero) ? Math.ceil(firstZero) + leadDays + 28 : 0,
      ),
    )

    const base = new Array<number>(horizon + 1).fill(0)
    const policy = new Array<number>(horizon + 1).fill(0)

    /**
     * Quanto da taxa diária cai em cada dia do horizonte.
     *
     * Média 1 por construção, então a venda da semana continua sendo
     * exatamente `weekly_blended` — o perfil só diz em que dia dela a peça
     * sai. Sem ele, todo dia recebe 1/7 e a linha vira uma régua, afirmando
     * que domingo e sexta vendem igual quando a base diz que não.
     */
    const dow0 = new Date(`${referenceDate}T12:00:00`).getDay()
    const profile = dailyProfile?.length === 7 ? dailyProfile : null
    const shareAt = (d: number) => (profile ? profile[(dow0 + d) % 7] : 1)

    // O dia em que o primeiro item fica sem nada, e o dia em que o primeiro
    // entra na reserva. Medidos na simulação, não estimados: o em-trânsito
    // chegando em data prevista e o perfil semanal mexem em ambos.
    let firstOut = Infinity
    let firstSafety = Infinity
    // E o dia em que o primeiro item precisa ter o pedido colocado.
    let firstOrderBy = Infinity
    // Qual item. Sem o nome, "primeira falta em 07 de out" em cima de uma grade
    // com 2.240 peças parece defeito — com o nome (8616, 1 peça no estoque)
    // vira uma frase conferível em dez segundos.
    let firstOutLabel: string | null = null

    for (const item of items) {
      const daily = item.weekly / 7
      // Os mesmos marcos, medidos DENTRO do item. O prazo de pedir de um item
      // depende da ruptura DELE; cruzar o PP de um tamanho com a ruptura de
      // outro produziria uma data que não é de ninguém.
      let itemOut = Infinity
      let itemReorder = Infinity

      // Fila de chegadas. Precisa de folga de um lead time no fim para que um
      // pedido disparado no último dia tenha onde ser gravado.
      const len = horizon + leadDays + 2
      // Duas filas: no cenário "sem repor" só entram as compras JÁ FEITAS; no
      // da política entram também as que ela dispararia.
      const dueBase = new Array<number>(len).fill(0)
      const duePolicy = new Array<number>(len).fill(0)

      // O em-trânsito entra na data prevista, não no dia 0. Sem previsão (ou
      // com previsão vencida) cai em 0, que é a leitura antiga: conta como se
      // já estivesse aqui.
      let scheduled = 0
      for (const a of item.arrivals ?? []) {
        const d = Math.min(len - 1, Math.max(0, Math.round(a.day)))
        dueBase[d] += a.qty
        duePolicy[d] += a.qty
        scheduled += a.qty
      }
      const atOnce = item.inTransit - scheduled
      if (atOnce > 0) { dueBase[0] += atOnce; duePolicy[0] += atOnce }

      let baseHand = item.stock
      let polHand = item.stock
      // A posição de hoje já conta o trânsito inteiro — é a mesma base que o
      // motor usa para disparar a compra. O que muda é QUANDO ele vira saldo.
      let polOnOrder = item.inTransit
      // A posição do cenário "sem repor": o que ainda vai chegar das compras já
      // feitas. É contra ela que o ponto de pedido é lido, igual ao motor.
      let baseOnOrder = item.inTransit

      // Quem já está no chão não precisa de simulação para faltar.
      if (item.stock + item.inTransit <= 0) itemOut = 0
      if (item.stock + item.inTransit <= item.safetyStock) firstSafety = 0
      if (item.stock + item.inTransit <= item.reorderPoint) itemReorder = 0

      for (let d = 0; d <= horizon; d++) {
        baseHand += dueBase[d]
        baseOnOrder -= dueBase[d]
        polHand += duePolicy[d]
        polOnOrder -= duePolicy[d]

        base[d] += baseHand * item.weight
        policy[d] += polHand * item.weight

        // Dispara pela POSIÇÃO (mão + pendente), não pelo saldo físico — que é
        // a condição do motor. Pelo saldo físico o item pediria de novo todo
        // dia durante o lead time inteiro.
        const position = polHand + polOnOrder
        if (item.maxStock > 0 && position <= item.reorderPoint) {
          const qty = item.maxStock - position
          if (qty > 0) {
            duePolicy[d + leadDays] += qty
            polOnOrder += qty
          }
        }

        // Falta é venda perdida, não venda adiada: o saldo trava no zero em vez
        // de virar negativo e ser "recuperado" quando a carga chega.
        const consume = daily * shareAt(d)
        // A fração do dia importa: sem ela toda resposta vira "daqui a N dias
        // cheios", arredondando para cima justamente o prazo que não se quer
        // arredondar para cima.
        if (consume > 0) {
          if (firstSafety > d && baseHand > item.safetyStock
            && baseHand - consume <= item.safetyStock) {
            firstSafety = Math.min(firstSafety, d + (baseHand - item.safetyStock) / consume)
          }
          if (itemOut > d && baseHand > 0 && baseHand - consume <= 0) {
            itemOut = d + baseHand / consume
          }
          // A POSIÇÃO cruzando o ponto de pedido — mão mais pendente, que é a
          // condição do motor. Pelo saldo físico o item só pediria depois de o
          // em-trânsito já ter sido consumido no papel.
          const pos = baseHand + Math.max(0, baseOnOrder)
          if (itemReorder > d && pos > item.reorderPoint && pos - consume <= item.reorderPoint) {
            itemReorder = d + (pos - item.reorderPoint) / consume
          }
        }
        baseHand = Math.max(0, baseHand - consume)
        polHand = Math.max(0, polHand - consume)
      }

      /**
       * O prazo de pedir DESTE item: a travessia do ponto de pedido.
       *
       * O PP é, por construção, a demanda do lead time MAIS o estoque de
       * segurança. Pedir quando a posição encosta nele faz a carga chegar
       * exatamente quando o saldo desce ao ES — o colchão fica inteiro, que é a
       * política que o motor dimensionou.
       *
       * Antes isto era `ruptura − lead time`, e estava errado pelo tamanho do
       * colchão: no Brinco Alba (ES 10 pç, 0,2/dia) atrasava a decisão em 50
       * dias e entregava a reposição no dia exato do zero. O usuário viu pelo
       * desenho — a linha verde cruzava o PP muito antes do marco "Pedir".
       *
       * O `min` com `ruptura − lead time` é o cinto: se o PP estiver
       * subdimensionado a ponto de sua travessia já não dar tempo do lead time,
       * "Pedir até" volta a ser o último dia possível. A célula promete uma
       * data em que pedir ainda evita a falta; ela não pode passar dessa.
       */
      const deadline = Number.isFinite(itemOut) ? itemOut - leadDays : Infinity
      const orderBy = Math.max(0, Math.min(itemReorder, deadline))
      if (orderBy < firstOrderBy) firstOrderBy = orderBy
      if (itemOut < firstOut) { firstOut = itemOut; firstOutLabel = item.label ?? null }
    }

    const data: Point[] = base.map((stock, day) => ({ day, stock, policy: policy[day] }))

    // No agregado a pergunta muda de "quando" para "quantos" — e a contagem é
    // sobre a posição de HOJE, que é a mesma condição que o motor usa para
    // disparar a compra.
    const counts = items.reduce(
      (acc, i) => {
        const pos = i.stock + i.inTransit
        if (pos <= 0) acc.out += 1
        else if (pos <= i.safetyStock) acc.safety += 1
        else if (pos <= i.reorderPoint) acc.reorder += 1
        return acc
      },
      { reorder: 0, safety: 0, out: 0 },
    )

    return {
      data,
      horizon,
      levels: totals,
      counts,
      atSafety: Number.isFinite(firstSafety) ? firstSafety : null,
      atOut: Number.isFinite(firstOut) ? firstOut : null,
      atOrderBy: Number.isFinite(firstOrderBy) ? firstOrderBy : null,
      outLabel: firstOutLabel as string | null,
    }
  }, [items, leadDays, referenceDate, dailyProfile])

  const { data, horizon, levels, counts, atSafety, atOut, atOrderBy, outLabel } = model

  const isSku = granularity === 'sku'
  const coverageDays = levels.daily > 0 ? levels.stock / levels.daily : null
  // Passou de um ano de horizonte, toda data precisa dizer o ano.
  const farOut = horizon > 330
  // Numa grade quem falta é um tamanho, não a peça. Chamar isso de "ruptura"
  // afirmaria sobre a soma uma coisa que a soma não diz.
  const multi = items.length > 1

  /**
   * As datas que mandam, medidas item a item na simulação.
   *
   * "Pedir até" é a travessia do ponto de pedido — a mesma condição que dispara
   * o motor. Pedir ali faz a carga chegar quando o saldo desce ao estoque de
   * segurança, deixando o colchão de pé.
   *
   * Com mais de um item a falta é a do PRIMEIRO a acabar, não a da soma: a
   * compra é por SKU, e o tamanho que zerou primeiro não espera os outros 31.
   */
  const dOut = atOut
  const dOrderBy = atOrderBy
  const dArrival = leadDays

  /**
   * Severidade pela folga até o prazo de pedir — não pelo nível de estoque. É a
   * diferença entre "está baixo" e "já passou da hora".
   *
   * O limiar NÃO pode ser o lead time inteiro. Com lead de 80 dias isso marcaria
   * "Atenção" em qualquer item com menos de 160 dias de cobertura, que é quase
   * todo o catálogo — e um alerta que acende sempre não é alerta. Um quarto do
   * lead time (piso de uma semana) é a janela em que a decisão realmente começa
   * a apertar.
   */
  const warnWindow = Math.max(7, Math.round(leadDays / 4))
  const severity: 'ok' | 'warn' | 'urgent' = dOrderBy == null
    ? 'ok'
    : dOrderBy <= 0 ? 'urgent' : dOrderBy <= warnWindow ? 'warn' : 'ok'

  const peak = Math.max(1, levels.maxStock, ...data.map((d) => Math.max(d.stock, d.policy)))
  const { top: ceiling, ticks: yTicks } = axisScale(peak)

  /**
   * As DUAS séries simuladas são o mesmo dado sob duas decisões, então dividem
   * a família: cyan, a rampa que o Infinify reserva para dado categórico. O que
   * as separa é peso e traço — "sem repor" é área cheia no 900, "seguindo a
   * política" é tracejada no 1100. Hue igual diz "mesma grandeza"; peso
   * diferente diz "cenário diferente".
   *
   * Cyan e não a cor de ação: barra de gráfico e botão primário na mesma cor
   * fazem o olho ler o dado como controle clicável.
   */
  const SERIES_STOCK = 'hsl(var(--cyan-900))'
  const SERIES_POLICY = 'hsl(var(--cyan-1100))'

  /**
   * As três réguas de política. ES é vermelho e PP é âmbar porque ambos são
   * ALARME — cruzar qualquer um dos dois é um evento. O Emáx não é: é só o
   * teto para onde a compra repõe, e pintá-lo de cor semântica sugeria um
   * perigo que não existe. Por isso ele é cinza neutro.
   *
   * Nenhuma das três pode ser cyan: elas atravessam a área cyan de ponta a
   * ponta e sumiriam dentro dela.
   *
   * Todas tracejadas e finas: são patamares de política, não dados medidos. Só
   * as duas séries simuladas têm traço cheio, e a diferença de peso é o que
   * separa "o que vai acontecer" de "a régua contra a qual se mede".
   */
  const LINES = [
    { key: 'max', value: levels.maxStock, short: 'Emáx', label: 'Estoque máximo', color: 'hsl(var(--mono-700))', dash: '6 4' },
    { key: 'reorder', value: levels.reorderPoint, short: 'PP', label: 'Ponto de pedido', color: 'hsl(var(--warning))', dash: '6 4' },
    { key: 'safety', value: levels.safetyStock, short: 'ES', label: 'Estoque de segurança', color: 'hsl(var(--destructive))', dash: '2 4' },
  ] as const

  /**
   * Marcos verticais. Só no SKU: no agregado a "data da ruptura" é a data em
   * que o último item some, um número que não descreve nada da carteira.
   *
   * Não há marco de "Hoje": o dia 0 é a borda esquerda do eixo e sua data já
   * está escrita ali embaixo, no primeiro tick. Uma linha tracejada colada no
   * eixo com um rótulo em cima só repetia o que a régua já dizia.
   *
   * NÃO há marco de "Chegada". Ele respondia outra pergunta — "se eu pedisse
   * hoje, quando chegaria?" — e desenhá-lo no mesmo eixo de "Pedir" produzia
   * uma entrega ANTES do pedido: chegada em 03/dez/26 e pedido em 15/jun/27.
   * As duas datas estão certas e não pertencem à mesma linha do tempo. O "e se"
   * fica na célula "Chega se pedir hoje", que diz no título que é hipótese.
   *
   * O que sobra são duas datas da MESMA história: pedir aqui, ou estar vazio
   * ali. A distância entre elas é o lead time MAIS a reserva — é essa folga
   * extra que faz a reposição chegar no ES e não no zero.
   *
   * Numa GRADE não sobra nenhuma: "Ruptura" e "Pedir" são de um tamanho só, e
   * desenhá-los sobre a soma pinta uma linha vermelha de ruptura atravessando
   * uma área de 2.240 peças — a curva não cruza nada ali. As datas ficam no
   * cartão, que é onde elas dizem de quem são.
   *
   * `row` empilha rótulos vizinhos em duas alturas, para o caso de "Pedir" e
   * "Ruptura" caírem perto e imprimirem "PedirRuptura".
   */
  const MARKS = (() => {
    if (!isSku || multi) return []
    const raw = [
      { key: 'pedir', at: dOrderBy, label: 'Pedir', color: 'hsl(var(--warning))' },
      { key: 'ruptura', at: dOut, label: 'Ruptura', color: 'hsl(var(--destructive))' },
    ]
      .filter((m): m is { key: string; at: number; label: string; color: string } =>
        m.at != null && m.at <= horizon)
      .sort((a, b) => a.at - b.at)

    let row = 0
    return raw.map((m, i) => {
      // 12% do eixo é a folga que um rótulo de ~7 caracteres ocupa na largura
      // típica do cartão. Abaixo disso, desce um degrau; acima, volta ao topo.
      if (i > 0) row = (m.at - raw[i - 1].at) / horizon < 0.12 ? (row + 1) % 2 : 0
      return { ...m, row }
    })
  })()

  /**
   * A ruptura sai em vermelho quando cai DENTRO de um lead time: aí ela não é
   * mais evitável por decisão nenhuma — mesmo pedindo agora, a carga chega
   * depois do estoque acabar. É fato, não uma segunda opinião sobre a
   * urgência que já está nos selos.
   */
  const outIsLocked = dOut != null && dOut <= leadDays

  const headline = [
    {
      key: 'cobertura',
      icon: Clock,
      label: 'Cobertura',
      value: coverageDays == null
        ? 'sem giro'
        : `${Math.round(coverageDays)} ${Math.round(coverageDays) === 1 ? 'dia' : 'dias'}`,
      // Uma casa decimal: a média diária de um item de baixo giro é 0,3 — o
      // formatador de peças arredondaria para "0" e a conta do gráfico
      // pareceria não fechar.
      hint: `${levels.daily.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}/dia`
        + ` · ${formatValue(levels.stock)} em posição`,
      // Numa grade a cobertura é da soma e a urgência é de um tamanho: um selo
      // "Urgente" em cima de "1.323 dias" faz o cartão discordar de si mesmo.
      tone: multi ? ('ok' as const) : severity,
      danger: false,
    },
    {
      key: 'ruptura',
      icon: AlertTriangle,
      label: multi ? 'Primeiro tamanho a faltar' : 'Ruptura em',
      value: dOut == null ? `além de ${horizon} dias` : shortDate(addDays(referenceDate, dOut), farOut),
      // Numa grade a dica diz QUEM, não quando entra na reserva: sem o SKU, a
      // data parece contradizer as 2.240 peças que o subtítulo acabou de
      // anunciar. Com ele, é uma frase que se confere na tela de Produtos.
      hint: multi
        ? `SKU ${outLabel ?? '—'} · 1 de ${items.length}, os outros faltam depois`
        : atSafety == null
          ? 'não entra na reserva no horizonte'
          : `entra na reserva ${atSafety === 0 ? 'hoje' : `em ${shortDate(addDays(referenceDate, atSafety), farOut)}`}`,
      // Sem selo: a urgência é uma coisa só e já está no par Cobertura/Pedir
      // até. Repeti-la aqui com outro limiar faria o cartão contradizer a si
      // mesmo sobre o mesmo fato.
      tone: 'ok' as const,
      danger: outIsLocked,
    },
    {
      key: 'pedir',
      icon: ShoppingCart,
      label: 'Pedir até',
      value: dOrderBy == null
        ? '—'
        : dOrderBy === 0 ? 'hoje' : shortDate(addDays(referenceDate, dOrderBy), farOut),
      hint: levels.suggested > 0
        ? `lote sugerido: ${formatValue(levels.suggested)}`
          + (multi ? ` · ${items.filter((i) => i.suggestedQty > 0).length} de ${items.length} tamanhos` : '')
        : 'motor não sugeriu compra',
      tone: severity,
      danger: false,
    },
    {
      key: 'chegada',
      icon: Truck,
      label: 'Chega se pedir hoje',
      value: shortDate(addDays(referenceDate, dArrival), farOut),
      // O lead time já está no selo do topo; aqui vale dizer o que a carga faz
      // quando chega, que é a informação que esta célula ainda não deu.
      hint: levels.maxStock > 0
        ? `repõe a posição até ${formatValue(levels.maxStock)}`
        : 'sem estoque máximo definido',
      tone: 'ok' as const,
      danger: false,
    },
  ]

  const footer = isSku
    ? [
        { key: 'lote', label: 'Lote sugerido', value: levels.suggested > 0 ? formatValue(levels.suggested) : '—' },
        { key: 'pp', label: 'Ponto de pedido', value: formatValue(levels.reorderPoint) },
        { key: 'es', label: 'Estoque de segurança', value: formatValue(levels.safetyStock) },
      ]
    : [
        { key: 'reorder', label: 'Abaixo do ponto de pedido', value: `${counts.reorder} de ${items.length} SKUs` },
        { key: 'safety', label: 'Dentro do estoque de segurança', value: `${counts.safety} de ${items.length} SKUs` },
        { key: 'out', label: 'Sem estoque nem trânsito', value: `${counts.out} de ${items.length} SKUs` },
      ]

  const tickStep = Math.max(1, Math.ceil(horizon / 8 / 7) * 7)

  const legend = [
    {
      key: 'stock',
      label: 'Sem repor',
      swatch: 'area' as const,
      color: SERIES_STOCK,
      title: 'A posição de hoje descendo pela venda média, sem nenhuma compra. Trava no zero.',
    },
    {
      key: 'policy',
      label: 'Seguindo a política',
      swatch: 'dash' as const,
      color: SERIES_POLICY,
      title: 'Ao cruzar o PP, pede o bastante para a posição voltar ao Emáx. A linha é o saldo em '
        + `mãos, que chega abaixo dele porque ${leadDays} dias de venda correm enquanto a carga vem.`,
    },
    ...LINES.filter((l) => l.value > 0).map((l) => ({
      key: l.key,
      label: l.label,
      swatch: 'dash' as const,
      color: l.color,
      title: `${l.label}: ${formatValue(l.value)}`,
    })),
  ]

  return (
    <div className="space-y-3">
      {isSku && (
        <div className="grid gap-px overflow-hidden rounded-md bg-border sm:grid-cols-2 lg:grid-cols-4">
          {headline.map((h) => (
            <div key={h.key} className="bg-surface-subtle px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <h.icon className="h-3.5 w-3.5 shrink-0" />
                  <p className="text-xs">{h.label}</p>
                </div>
                {h.tone !== 'ok' && (
                  <span className={`rounded-full px-1.5 py-px text-micro font-medium ${
                    h.tone === 'urgent'
                      ? 'bg-danger-soft text-destructive'
                      : 'bg-warning-soft text-warning-foreground'
                  }`}>
                    {h.tone === 'urgent' ? 'Urgente' : 'Atenção'}
                  </span>
                )}
              </div>
              <p className={`font-data text-xl font-semibold leading-tight tabular-nums ${
                h.danger ? 'text-destructive' : ''
              }`}>
                {h.value}
              </p>
              <p className="truncate text-micro text-muted-foreground" title={h.hint}>{h.hint}</p>
            </div>
          ))}
        </div>
      )}

      {/* A legenda subiu para cima do gráfico: quem olha precisa saber o que é
          cada traço ANTES de interpretar a inclinação, não depois de rolar até
          o fim do cartão. Os valores saíram daqui — agora ficam grudados na
          própria linha, que é onde se olha. */}
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 pt-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {legend.map((l) => (
            <div key={l.key} className="flex items-center gap-1.5 text-xs" title={l.title}>
              {l.swatch === 'area' ? (
                <span
                  className="h-2.5 w-4 shrink-0 rounded-[2px] border"
                  style={{ borderColor: l.color, background: 'hsl(var(--cyan-600) / 0.22)' }}
                />
              ) : (
                <svg width="18" height="6" className="shrink-0" aria-hidden>
                  <line x1="0" y1="3" x2="18" y2="3" stroke={l.color} strokeWidth={2} strokeDasharray="4 3" />
                </svg>
              )}
              <span className="text-muted-foreground">{l.label}</span>
            </div>
          ))}
        </div>
        {isSku && (
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-micro text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            Lead time {leadDays}d
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={360}>
        {/* `top: 34` abre a faixa dos rótulos dos marcos verticais — duas
            alturas de 13px mais a folga. Sem ela o recharts corta o rótulo
            do degrau de baixo pela metade. */}
        <ComposedChart data={data} margin={{ top: 34, right: 12, bottom: 0, left: 8 }}>
          <XAxis
            dataKey="day"
            type="number"
            domain={[0, horizon]}
            ticks={Array.from({ length: Math.floor(horizon / tickStep) + 1 }, (_, i) => i * tickStep)}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            className="fill-muted-foreground"
            tickFormatter={(d: number) => shortDate(addDays(referenceDate, d), farOut)}
          />
          <YAxis
            domain={[0, ceiling]}
            ticks={yTicks}
            width={72}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            className="fill-muted-foreground"
            tickFormatter={(v: number) => formatValue(v)}
          />

          {/* O preenchimento esvai para cima: sem o degradê, uma área de 200
              peças vira um bloco chapado que pesa mais na tela do que a linha,
              que é onde está a informação. */}
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--cyan-600))" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(var(--cyan-600))" stopOpacity={0.04} />
            </linearGradient>
          </defs>

          <Area
            type="linear"
            dataKey="stock"
            stroke={SERIES_STOCK}
            strokeWidth={2.5}
            fill={`url(#${fillId})`}
            dot={false}
            activeDot={{ r: 4, fill: SERIES_STOCK, stroke: 'hsl(var(--surface))', strokeWidth: 2 }}
            isAnimationActive={false}
          />

          <Line
            type="linear"
            dataKey="policy"
            stroke={SERIES_POLICY}
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            activeDot={{ r: 4, fill: SERIES_POLICY, stroke: 'hsl(var(--surface))', strokeWidth: 2 }}
            isAnimationActive={false}
          />

          {/* O valor vai colado na linha. Na legenda ele obrigava a ir e voltar
              com os olhos para saber a que altura o PP passa.
              À ESQUERDA, não à direita: o dente de serra da política mora
              sempre na ponta direita do horizonte, na mesma faixa de altura do
              PP e do ES — do outro lado, o rótulo caía em cima dele. */}
          {LINES.filter((l) => l.value > 0 && l.value <= ceiling).map((l) => (
            <ReferenceLine key={l.key} y={l.value} stroke={l.color} strokeWidth={1.5} strokeDasharray={l.dash}>
              <Label
                value={`${l.short} ${formatValue(l.value)}`}
                position="insideTopLeft"
                offset={5}
                style={{ fill: l.color, fontSize: 10, fontWeight: 600 }}
              />
            </ReferenceLine>
          ))}

          {MARKS.map((m) => (
            <ReferenceLine key={m.key} x={m.at} stroke={m.color} strokeWidth={1} strokeDasharray="3 3">
              <Label
                value={m.label}
                position="top"
                offset={6 + m.row * 13}
                style={{ fill: m.color, fontSize: 10, fontWeight: 500 }}
              />
            </ReferenceLine>
          ))}

          <Tooltip
            cursor={{ stroke: 'hsl(var(--border))', strokeDasharray: '3 3' }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as Point | undefined
              if (!active || !p) return null
              return (
                <div className="min-w-44 space-y-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-dropdown">
                  <p className="font-medium">
                    {longDate(addDays(referenceDate, p.day))}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {p.day === 0 ? 'hoje' : `+${p.day}d`}
                    </span>
                  </p>
                  {[
                    { label: 'Sem repor', v: p.stock, color: SERIES_STOCK },
                    { label: 'Seguindo a política', v: p.policy, color: SERIES_POLICY },
                  ].map((r) => (
                    <p key={r.label} className="flex items-center gap-1.5 tabular-nums">
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: r.color }}
                      />
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="ml-auto font-medium">{formatValue(r.v)}</span>
                    </p>
                  ))}
                </div>
              )
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* O rodapé é o produto do gráfico. Quem decide compra olha para ele,
          não para a inclinação da área — por isso o número vem grande e
          centrado, e não espremido num canto. */}
      <div className="grid gap-px overflow-hidden rounded-md bg-border sm:grid-cols-3">
        {footer.map((e) => (
          <div key={e.key} className="bg-surface-subtle px-3 py-2.5 text-center">
            <p className="text-xs text-muted-foreground">{e.label}</p>
            <p className="font-data text-lg font-semibold leading-tight tabular-nums">{e.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
