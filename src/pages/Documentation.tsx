import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { num } from '@/lib/replenishment-types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * A documentação vive DENTRO do sistema e lê os parâmetros correntes da
 * empresa: se o lead time mudar de 80 para 60 dias, o texto muda junto. Doc
 * com número hardcoded é doc que mente depois da primeira edição.
 */

function Formula({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-muted/50 px-4 py-3 font-mono text-sm">
      {children}
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-3 text-base">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-600">
            {n}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pl-[52px] text-sm leading-relaxed text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  )
}

/** Verbete de glossário: a palavra e, do lado, o que ela quer dizer em português. */
function Term({ word, children }: { word: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-2.5 last:border-0 sm:grid-cols-[170px_1fr] sm:gap-4">
      <span className="text-sm font-medium text-foreground">{word}</span>
      <span className="text-sm leading-relaxed text-muted-foreground">{children}</span>
    </div>
  )
}

/** Pergunta do dia a dia, com a resposta logo abaixo. */
function Question({ q, children }: { q: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{q}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  )
}

function Param({ name, value, children }: { name: string; value: string; children: ReactNode }) {
  return (
    <div className="space-y-1 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">{name}</span>
        <span className="font-mono text-xs tabular-nums text-ink">{value}</span>
      </div>
      <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

const pct = (v: number) => `${(v * 100).toFixed(1).replace('.', ',').replace(',0', '')}%`

interface DocPage {
  slug: string
  title: string
  group: string
  description: string
  body: ReactNode
}

export default function Documentation() {
  const { slug } = useParams<{ slug: string }>()
  const { data: params } = useReplenishmentParams()

  const lead = params?.lead_time_days ?? 80
  const leadWeeks = (lead / 7).toFixed(1).replace('.', ',')
  const cycle = num(params?.order_cycle_weeks) || 16
  const recent = params?.recent_window_days ?? 28
  const levelA = pct(num(params?.service_level_a) || 0.975)
  const levelB = pct(num(params?.service_level_b) || 0.95)
  const levelC = pct(num(params?.service_level_c) || 0.9)
  const cmv = pct(num(params?.cmv_pct) || 0.2)
  const cutA = pct(num(params?.abc_cut_a) || 0.5)
  const cutB = pct(num(params?.abc_cut_b) || 0.8)

  // As flags do motor: o texto acompanha o modelo que está de fato ligado.
  const modern = (params?.demand_model ?? 'weighted_90_180') === 'weighted_90_180'
  const skuAnchored = (params?.sigma_anchor ?? 'sku_first_sale') === 'sku_first_sale'

  // Um único produto imaginário — o "Anel Aurora" — atravessa o guia inteiro, e
  // os números dele NÃO são escritos à mão: saem das mesmas contas do motor,
  // com os parâmetros da sua empresa. Se o prazo de entrega mudar, o exemplo
  // muda junto e continua sendo um exemplo verdadeiro. Exemplo com número
  // congelado é exemplo que contradiz a tela na primeira mudança de parâmetro.
  const ex = (() => {
    const weekly = 4 // peças vendidas por semana, em média
    const sigma = 3 // o quanto essa venda oscila de uma semana para outra
    const z = 1.96 // fator do nível de serviço da classe A
    const stock = 40 // peças na prateleira hoje
    const price = 290
    const waitWeeks = lead / 7
    const safety = Math.ceil(z * sigma * Math.sqrt(waitWeeks))
    // Multiplica antes de dividir, igual ao motor: (4 × 50) ÷ 7, não 4 × (50÷7).
    const duringWait = (weekly * lead) / 7
    const reorder = Math.ceil(safety + duringWait)
    const max = Math.round(reorder + weekly * cycle)
    return {
      weekly, sigma, stock, price, waitWeeks, safety, duringWait, reorder, max,
      leftAfterWait: stock - duringWait,
      order: max - stock,
      cost: Math.round((max - stock) * price * (num(params?.cmv_pct) || 0.2)),
    }
  })()

  const d1 = (v: number) => v.toFixed(1).replace('.', ',')
  const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`

  const pages: DocPage[] = [
    {
      slug: '',
      title: 'Como ler este sistema',
      group: 'Comece por aqui',
      description: 'O que ele decide, o que ele não decide e as duas linhas que existem em cada produto.',
      body: (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Prazo de entrega: {lead} dias (~{leadWeeks} semanas)</Badge>
            <Badge variant="outline">Ciclo de compras: {cycle} semanas</Badge>
            <Badge variant="outline">Nível de serviço: A {levelA} · B {levelB} · C {levelC}</Badge>
          </div>

          <Card className="soft-panel shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">O sistema responde duas perguntas. Só duas.</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed">
              <p>
                <strong>Quando</strong> preciso pedir este produto — e{' '}
                <strong>quantas peças</strong> preciso pedir.
              </p>
              <p className="text-muted-foreground">
                Tudo o que você vai ler aqui existe para chegar nessas duas respostas, produto
                por produto. Se em algum momento o texto parecer complicado, volte a esta
                frase: é só isso que está sendo calculado.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A comparação que resolve</CardTitle>
              <CardDescription>Pense no tanque de gasolina do carro.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Você não espera o tanque zerar para abastecer. Você abastece quando{' '}
                <strong className="text-foreground">a luz acende</strong> — e quando abastece,
                normalmente <strong className="text-foreground">enche o tanque</strong>.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>A luz acendendo é o <strong className="text-foreground">ponto de pedido</strong>.</li>
                <li>O tanque cheio é o <strong className="text-foreground">estoque máximo</strong>.</li>
              </ul>
              <p>
                A luz não acende na mesma marca para todo carro. Depende de quanto ele
                consome e de quão longe fica o próximo posto. É exatamente isso que o sistema
                faz: calcula, para cada produto, em que marca a luz deve acender — levando em
                conta o quanto ele vende e os {lead} dias que a reposição demora para chegar.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Todo produto tem três linhas</CardTitle>
              <CardDescription>
                Exemplo de um item que vende {ex.weekly} peças por semana, classe A.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                Estoque máximo ........ {ex.max} peças &nbsp;← até aqui o pedido enche
                <br />
                Ponto de pedido ....... {ex.reorder} peças &nbsp;← aqui a luz acende
                <br />
                Estoque de segurança .. {ex.safety} peças &nbsp;← daqui para baixo é emergência
              </Formula>
              <p>
                Estes três números são recalculados para cada produto do catálogo. Um item que
                vende 40 por semana tem linhas altas; um que vende 1 por mês tem linhas baixas.
                Nenhum deles é escolhido à mão.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O que ele precisa saber de cada produto</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-foreground">Quanto vende por semana.</strong> Sai do
                  histórico de vendas, não de opinião.
                </li>
                <li>
                  <strong className="text-foreground">O quanto essa venda oscila.</strong> Dois
                  produtos podem vender 4 por semana na média: um vendendo 4, 4, 4, 4 e outro
                  vendendo 0, 12, 1, 3. O segundo precisa de muito mais reserva.
                </li>
                <li>
                  <strong className="text-foreground">Quanto tempo demora para repor.</strong>{' '}
                  Hoje, {lead} dias. É o parâmetro que mais pesa no resultado.
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O que o sistema não decide</CardTitle>
              <CardDescription>
                Saber o limite é o que permite confiar no resto.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-foreground">Não conhece o futuro.</strong> Ele projeta
                  o passado para frente. Campanha, lançamento, ação de influenciador e Black
                  Friday são coisas que só você sabe que vão acontecer.
                </li>
                <li>
                  <strong className="text-foreground">Não sabe nada de produto sem venda.</strong>{' '}
                  Um lançamento de duas semanas não tem histórico para virar estatística — e o
                  sistema diz isso em vez de inventar um número.
                </li>
                <li>
                  <strong className="text-foreground">Não escolhe fornecedor nem negocia preço.</strong>{' '}
                  Ele diz quantas peças; com quem e por quanto é decisão sua.
                </li>
                <li>
                  <strong className="text-foreground">Não compra item fora de coleção.</strong>{' '}
                  Produto marcado como fora de coleção some do pedido, por mais que venda.
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card className="soft-panel shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Próximo passo</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed">
              A página seguinte pega um produto e percorre os oito passos do cálculo, um por
              vez, com os números aparecendo na sua frente. É a página mais importante deste
              guia — o resto são detalhes dela.
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'exemplo',
      title: 'Um produto do começo ao fim',
      group: 'Comece por aqui',
      description: 'Os oito passos que transformam histórico de venda em "compre 69 peças".',
      body: (
        <div className="space-y-4">
          <Card className="soft-panel shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">O produto deste exemplo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm leading-relaxed">
              <p>
                Um anel que vende bem: <strong>{ex.weekly} peças por semana</strong> na média,
                preço de {brl(ex.price)}, com <strong>{ex.stock} peças</strong> na prateleira
                hoje e nada em produção.
              </p>
              <p className="text-muted-foreground">
                Os números abaixo são calculados com os parâmetros da sua empresa — prazo de{' '}
                {lead} dias e ciclo de {cycle} semanas. Se alguém mudar esses parâmetros, este
                exemplo muda junto.
              </p>
            </CardContent>
          </Card>

          <Step n={1} title="Quanto ele vende por semana">
            <p>
              O sistema olha o histórico de vendas e chega a{' '}
              <strong className="text-foreground">{ex.weekly} peças por semana</strong>.
            </p>
            {modern ? (
              <p>
                Ele não usa uma média só: mistura os últimos 90 dias (peso 70%) com os últimos
                180 dias (peso 30%). O trimestre recente manda mais, mas o semestre impede que
                um mês fora da curva vire "o novo normal".
              </p>
            ) : (
              <p>
                Ele mistura duas médias em partes iguais: a de toda a vida do produto no
                catálogo e a dos últimos {recent} dias.
              </p>
            )}
            <p>
              Este é o número mais importante do cálculo inteiro. Todos os outros nascem dele.
            </p>
          </Step>

          <Step n={2} title="O quanto essa venda é irregular">
            <p>
              Vender {ex.weekly} por semana na média quase nunca significa vender {ex.weekly}{' '}
              toda semana. As semanas reais parecem mais com isto:
            </p>
            <Formula>
              sem 1: {ex.weekly} &nbsp; sem 2: 1 &nbsp; sem 3: 8 &nbsp; sem 4: 2 &nbsp; sem 5:
              6 &nbsp; sem 6: 3
            </Formula>
            <p>
              O sistema mede o tamanho típico desse zigue-zague e chama esse número de{' '}
              <strong className="text-foreground">σ (sigma)</strong>. Neste produto,{' '}
              <strong className="text-foreground">σ = {ex.sigma}</strong>.
            </p>
            <p>
              Traduzindo: σ é o nervosismo do produto. Quanto mais nervoso, maior a reserva
              que ele vai precisar — mesmo que a média seja idêntica à de um produto calmo.
            </p>
          </Step>

          <Step n={3} title="O quanto ele importa para o faturamento">
            <p>
              O sistema ordena todos os produtos pelo faturamento que cada um gera por semana
              e separa em três grupos: <strong className="text-foreground">A</strong> (os que
              concentram o começo do faturamento), <strong className="text-foreground">B</strong>{' '}
              e <strong className="text-foreground">C</strong>.
            </p>
            <p>
              Nosso anel é <strong className="text-foreground">classe A</strong>. Isso significa
              que ele recebe a proteção mais alta da casa: {levelA} de nível de serviço, ou
              seja, o sistema aceita ficar sem ele em menos de{' '}
              {pct(1 - (num(params?.service_level_a) || 0.975))} das reposições.
            </p>
            <p>
              Esse percentual vira um multiplicador chamado{' '}
              <strong className="text-foreground">Z</strong>. Para {levelA}, Z = 1,96. É, em
              uma palavra, o preço da tranquilidade: quanto mais você quer nunca faltar, maior
              o Z e mais peças paradas você banca.
            </p>
          </Step>

          <Step n={4} title="A reserva de emergência">
            <p>
              Agora o sistema junta o nervosismo (σ), a exigência de proteção (Z) e o tempo de
              espera ({ex.waitWeeks.toFixed(1).replace('.', ',')} semanas):
            </p>
            <Formula>
              reserva = 1,96 × {ex.sigma} × √{ex.waitWeeks.toFixed(1).replace('.', ',')} ={' '}
              {ex.safety} peças
            </Formula>
            <p>
              A raiz quadrada aparece porque o risco não cresce em linha reta: esperar o dobro
              do tempo não exige o dobro de reserva. Semanas fortes e fracas se compensam
              parcialmente ao longo da espera.
            </p>
            <p>
              Essas {ex.safety} peças não são para vender no ritmo normal. São para aguentar as
              semanas em que a venda vier acima da média enquanto a reposição não chega.
            </p>
          </Step>

          <Step n={5} title="A linha que acende a luz">
            <p>
              Durante os {lead} dias de espera, o produto vai continuar vendendo. Quanto?
            </p>
            <Formula>
              {ex.weekly} peças/semana × {ex.waitWeeks.toFixed(1).replace('.', ',')} semanas ={' '}
              {d1(ex.duringWait)} peças
            </Formula>
            <p>
              Então o pedido precisa ser feito enquanto ainda existem{' '}
              {d1(ex.duringWait)} peças para atravessar a espera —{' '}
              <em>mais</em> a reserva, que não deve ser consumida no caminho:
            </p>
            <Formula>
              ponto de pedido = {d1(ex.duringWait)} + {ex.safety} ={' '}
              <strong>{ex.reorder} peças</strong>
            </Formula>
            <p>
              É esta a marca em que a luz acende. Chegou a {ex.reorder} peças disponíveis, está
              na hora de comprar.
            </p>
          </Step>

          <Step n={6} title="Até onde encher">
            <p>
              Já que o pedido vai ser feito, ele não deve trazer só o suficiente para amanhã:
              precisa durar até a próxima rodada de compras, que acontece a cada{' '}
              {cycle} semanas.
            </p>
            <Formula>
              estoque máximo = {ex.reorder} + ({ex.weekly} × {cycle} semanas) ={' '}
              <strong>{ex.max} peças</strong>
            </Formula>
            <p>
              Repare onde o ciclo entra: <strong className="text-foreground">só aqui</strong>.
              Ele muda <em>quanto</em> você compra, nunca <em>quando</em>.
            </p>
          </Step>

          <Step n={7} title="A decisão">
            <p>O sistema compara o que você tem com a linha do passo 5:</p>
            <Formula>
              {ex.stock} na prateleira + 0 em produção = {ex.stock} peças
              <br />
              {ex.stock} ≤ {ex.reorder} → <strong>sim, é hora de pedir</strong>
              <br />
              quantidade = {ex.max} − {ex.stock} = <strong>{ex.order} peças</strong>
            </Formula>
            <p>
              A {brl(ex.price)} de venda e custo estimado, isso são aproximadamente{' '}
              <strong className="text-foreground">{brl(ex.cost)}</strong> nesta única linha do
              pedido.
            </p>
          </Step>

          <Step n={8} title='"Mas eu tenho estoque para dez semanas!"'>
            <p>
              Essa é a objeção certa, e vale entender a resposta — é ela que separa quem
              confia no sistema de quem briga com ele toda semana.
            </p>
            <p>
              Sim: {ex.stock} peças ÷ {ex.weekly} por semana ={' '}
              {d1(ex.stock / ex.weekly)} semanas de estoque. Parece muito. Mas a reposição
              demora {ex.waitWeeks.toFixed(1).replace('.', ',')} semanas para chegar. Então a
              pergunta certa não é "quanto eu tenho hoje", e sim{' '}
              <strong className="text-foreground">"quanto eu vou ter no dia em que a
              mercadoria chegar"</strong>:
            </p>
            <Formula>
              {ex.stock} − {d1(ex.duringWait)} = {d1(ex.leftAfterWait)} peças
              <br />
              {d1(ex.leftAfterWait)} está <strong>abaixo</strong> da reserva de {ex.safety}
            </Formula>
            <p>
              Ou seja: o produto não está em risco hoje. Ele está em risco daqui a{' '}
              {ex.waitWeeks.toFixed(1).replace('.', ',')} semanas — que é exatamente o tempo
              que você não tem mais, porque é o tempo que a produção leva.
            </p>
            <p>
              O sistema compra cedo não porque está com medo. Compra cedo porque{' '}
              <strong className="text-foreground">a decisão de hoje só produz efeito daqui a{' '}
              {lead} dias</strong>.
            </p>
          </Step>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Mude um número e o pedido inteiro muda</CardTitle>
              <CardDescription>
                Onde o dinheiro se move — e por que conferir o em trânsito importa tanto.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Suponha que {ex.max - ex.stock} peças deste mesmo anel já estivessem em
                produção, registradas no em trânsito. A conta do passo 7 vira:
              </p>
              <Formula>
                {ex.stock} na prateleira + {ex.max - ex.stock} em produção = {ex.max} peças
                <br />
                {ex.max} é maior que {ex.reorder} → <strong>não pede nada</strong>
              </Formula>
              <p>
                Mesmo produto, mesma prateleira, mesma venda — e{' '}
                <strong className="text-foreground">{brl(ex.cost)} de diferença</strong> no
                pedido, decididos por uma única linha de em trânsito. É por isso que essa base
                precisa estar correta antes de aprovar qualquer compra: ela vale tanto quanto o
                estoque.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'glossario',
      title: 'Glossário',
      group: 'Comece por aqui',
      description: 'Cada palavra difícil do sistema, dita em português.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">As palavras do cálculo</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <Term word="Demanda semanal">
                Quantas peças o produto vende por semana, em média, segundo o histórico. Base
                de tudo.
              </Term>
              <Term word="σ (sigma)">
                O tamanho típico da oscilação entre uma semana e outra. É o "nervosismo" do
                produto. Média igual + σ diferente = reserva bem diferente.
              </Term>
              <Term word="Nível de serviço">
                A chance de não faltar produto durante a espera. Hoje: A {levelA}, B {levelB},
                C {levelC}.
              </Term>
              <Term word="Z">
                O nível de serviço convertido em multiplicador. {levelA} vira 1,96. Quanto
                maior, maior a reserva — e mais capital parado.
              </Term>
              <Term word="Estoque de segurança">
                A reserva para as semanas em que a venda vier acima da média. Não é para vender
                no ritmo normal; é para não faltar quando sair do normal.
              </Term>
              <Term word="Ponto de pedido">
                A marca em que a luz acende. Abaixo dela, comprar deixa de ser opcional.
                Também aparece como "estoque mínimo".
              </Term>
              <Term word="Estoque máximo">
                O nível até onde o pedido enche. Cobre a espera, a reserva e as {cycle} semanas
                até a próxima compra.
              </Term>
              <Term word="Em trânsito">
                Peças já compradas ou em produção, que ainda não chegaram. Contam como se
                estivessem na prateleira — é o que evita comprar duas vezes a mesma coisa.
              </Term>
              <Term word="Prazo de entrega">
                Os {lead} dias entre fazer o pedido e a peça estar disponível para venda.
                Produção mais transporte, não só transporte.
              </Term>
              <Term word="Ciclo de pedido">
                De quanto em quanto tempo você compra: {cycle} semanas. Afeta só o tamanho do
                pedido, nunca a data dele.
              </Term>
              <Term word="Classe ABC">
                Separação dos produtos por peso no faturamento. Define quanta proteção cada um
                recebe.
              </Term>
              <Term word="CMV">
                O custo da mercadoria vendida. Quando o produto não tem custo cadastrado, o
                sistema estima como {cmv} do preço de venda.
              </Term>
              <Term word="Snapshot">
                A foto datada do cálculo inteiro. Todas as telas leem a mesma foto, por isso
                nunca discordam entre si.
              </Term>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'demanda-semanal',
      title: 'Demanda semanal',
      group: 'Como a conta é feita',
      description: 'Como o sistema estima quantas peças cada produto vende por semana.',
      body: modern ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A ideia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Tudo no sistema parte de uma pergunta: <strong className="text-foreground">
                quantas peças este produto vende por semana?</strong> Para responder, ele
                combina duas janelas de tempo:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong className="text-foreground">Os últimos 90 dias</strong> (peso 70%) —
                  o ritmo atual do produto.
                </li>
                <li>
                  <strong className="text-foreground">Os últimos 180 dias</strong> (peso 30%) —
                  a âncora estrutural, que impede um mês atípico de dominar a conta.
                </li>
              </ul>
              <p>
                Analogia: para adivinhar o trânsito de amanhã, o que aconteceu neste mês
                vale mais do que a média do semestre — mas ignorar o semestre faria um
                feriado atípico virar "o novo normal".
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O cálculo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                D90 &nbsp;= venda_90_dias ÷ 13 semanas
                <br />
                D180 = venda_180_dias ÷ 26 semanas
                <br />
                venda_semanal = 0,7 × D90 + 0,3 × D180
              </Formula>
              <p>
                Exemplo: um anel vendeu 130 peças nos últimos 90 dias e 208 nos últimos 180.
                D90 = 130 ÷ 13 = 10,0; D180 = 208 ÷ 26 = 8,0. Demanda = 0,7 × 10 + 0,3 × 8 ={' '}
                <strong className="text-foreground">9,4 peças/semana</strong>.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Por que 70/30 — e não outra receita</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Este modelo não foi escolhido por parecer bom: ele <strong className="text-foreground">
                venceu um teste às cegas contra o passado</strong> (backtest). O sistema
                voltou no tempo em várias datas, fingiu não conhecer o futuro, previu as
                semanas seguintes com cada modelo candidato e mediu quem errou menos contra
                o que realmente aconteceu — 2.264 comparações.
              </p>
              <p>
                O modelo da planilha antiga errava em média 53% nos itens classe A; o 70/30
                erra 32%. Variantes mais "sofisticadas" (fator de tendência, três janelas)
                foram testadas e <strong className="text-foreground">rejeitadas</strong> por
                não vencerem. Nada entra no motor porque parece inteligente — entra porque
                provou que erra menos.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A ideia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                O sistema combina duas médias, cada uma com peso de 50%: a média de vida
                inteira do produto e a média dos últimos {recent} dias.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O cálculo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                venda_semanal = (venda_total ÷ semanas_em_catálogo + venda_{recent}d ÷ {(recent / 7).toFixed(0)}) ÷ 2
              </Formula>
              <p>
                <code className="text-xs">semanas_em_catálogo</code> tem piso de 4 — um
                lançamento com 3 dias de vida dividiria a venda por 0,43 e projetaria uma
                demanda absurda.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'estoque-de-seguranca',
      title: 'Estoque de segurança',
      group: 'Como a conta é feita',
      description: 'A reserva contra semanas de venda acima do normal — e como o σ é medido.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A ideia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Se a venda fosse perfeitamente regular — {ex.weekly} peças toda semana, sem
                exceção — reserva nenhuma seria necessária: bastaria pedir na hora certa. A
                reserva existe porque a venda real{' '}
                <strong className="text-foreground">não é regular</strong>.
              </p>
              <p>
                Dois produtos vendem 4 por semana na média. O primeiro vende 4, 4, 3, 5. O
                segundo vende 0, 12, 1, 3. Na planilha os dois têm a mesma média — na
                prateleira, o segundo deixa cliente na mão. A reserva é o que separa os dois.
              </p>
              <p>
                Quanto mais irregular a venda, maior a reserva. E quanto mais longa a espera
                ({lead} dias hoje), maior também: é mais tempo exposto ao imprevisto.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Medindo a irregularidade (σ)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                σ = desvio_padrão( venda por semana, semanas sem venda contam como 0 )
              </Formula>
              {skuAnchored ? (
                <>
                  <p>
                    A história é dividida em semanas de 7 dias, e a régua de cada item{' '}
                    <strong className="text-foreground">começa na primeira venda dele
                    mesmo</strong>. A regra: semana anterior à primeira venda do item não é
                    "demanda zero" — é <strong className="text-foreground">ausência de
                    observação</strong>. Um colar lançado há 12 semanas não "vendeu zero"
                    nas 45 semanas anteriores; ele não existia.
                  </p>
                  <p>
                    Semanas em que o item existia e não vendeu <strong
                    className="text-foreground">entram como zero</strong> — sem isso, um
                    item que vendeu 3 peças em 3 semanas espalhadas teria σ = 0 e ficaria
                    sem colchão nenhum.
                  </p>
                  <p>
                    Por que a âncora importa: um lançamento de 4 semanas vendendo{' '}
                    <code className="text-xs">20, 0, 10, 0</code> tem σ ≈ 9,6 — venda
                    nervosa, colchão grande. Se a régua incluísse 50 semanas de antes do
                    lançamento (todas "zero"), o σ cairia para ≈ 3,0: o item mais errático
                    da casa seria tratado como o mais comportado, justamente onde há menos
                    histórico para confiar.
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      Menos de <strong className="text-foreground">4 semanas</strong> de
                      vida → o número aparece marcado como baixa confiança.
                    </li>
                    <li>
                      Menos de <strong className="text-foreground">2 semanas</strong> → não
                      existe desvio honesto de 1 observação: σ fica vazio e o colchão é 0,
                      de forma documentada, nunca silenciosa.
                    </li>
                  </ul>
                </>
              ) : (
                <p>
                  A grade de semanas é ancorada na primeira venda da empresa (a mesma régua
                  para todos os itens), e as semanas em que o item não vendeu <strong
                  className="text-foreground">entram como zero</strong> — sem isso, um item
                  que vendeu 3 peças em 3 semanas espalhadas teria σ = 0 e ficaria sem
                  colchão nenhum.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O cálculo do colchão</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                ES = TETO( Z × σ × √({lead} ÷ 7) )
              </Formula>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong className="text-foreground">Z</strong> vem do nível de serviço da
                  classe ABC: A {levelA} → 1,96 · B {levelB} → 1,64 · C {levelC} → 1,28.
                </li>
                <li>
                  <strong className="text-foreground">√({lead}÷7) ≈ {Math.sqrt(lead / 7).toFixed(2).replace('.', ',')}</strong> —
                  a incerteza cresce com a raiz do tempo de espera, não linearmente. Dobrar a
                  espera não dobra o colchão necessário.
                </li>
                <li>
                  <strong className="text-foreground">TETO</strong>, nunca arredondamento:
                  meia peça de segurança não existe, e arredondar para baixo é exatamente o
                  erro que o nível de serviço existe para evitar.
                </li>
              </ul>
              <p>
                No produto do exemplo (σ = {ex.sigma}, classe A): 1,96 × {ex.sigma} ×{' '}
                {Math.sqrt(lead / 7).toFixed(2).replace('.', ',')} ={' '}
                <strong className="text-foreground">{ex.safety} peças</strong> de reserva.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'ponto-de-pedido-e-estoque-maximo',
      title: 'Ponto de pedido e estoque máximo',
      group: 'Como a conta é feita',
      description: 'Quando o pedido é disparado, até quanto repor e como o em trânsito entra.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Ponto de pedido (Emín)</CardTitle>
              <CardDescription>
                O estoque que dispara a compra. É onde o tempo de produção pesa direto.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Em uma frase: <strong className="text-foreground">o que vai ser vendido
                durante a espera, mais a reserva que não pode ser consumida na espera</strong>.
              </p>
              <Formula>
                Emín = TETO( ES + venda_semanal × {lead} ÷ 7 )
              </Formula>
              <p>
                <code className="text-xs">venda_semanal × {lead}÷7</code> é o que será
                vendido <strong className="text-foreground">enquanto a produção está em
                andamento</strong> (~{leadWeeks} semanas). Pedir só quando o estoque acaba
                significaria {lead} dias de prateleira vazia.
              </p>
              <p>
                No produto do exemplo: {ex.weekly} peças/semana × {leadWeeks} semanas ={' '}
                {d1(ex.duringWait)} peças vendidas durante a espera, mais {ex.safety} de
                reserva ={' '}
                <strong className="text-foreground">{ex.reorder} peças</strong>. Ao chegar a{' '}
                {ex.reorder} disponíveis, já é hora de pedir.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Estoque máximo (Emáx)</CardTitle>
              <CardDescription>
                O nível a alcançar após o pedido: espera + ciclo até a próxima compra.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Já que o pedido vai ser feito, ele precisa durar até a próxima rodada de
                compras. É só isso que o ciclo significa.
              </p>
              <Formula>
                Emáx = ARRED( Emín + venda_semanal × {cycle} semanas )
              </Formula>
              <p>
                No produto do exemplo: reserva {ex.safety}, ponto de pedido {ex.reorder},
                máximo {ex.max}. Quando o estoque chega a {ex.reorder}, o sistema recomenda
                voltar para {ex.max} — pedido de {ex.max} − {ex.reorder} ={' '}
                <strong className="text-foreground">{ex.max - ex.reorder} peças</strong>.
              </p>
              <p>
                Note que o ciclo entra <strong className="text-foreground">só nesta linha</strong>.
                Ele decide o tamanho do pedido; nunca a data dele.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A decisão de pedir</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                pede quando:&nbsp; estoque + em_trânsito ≤ Emín
                <br />
                quantidade:&nbsp;&nbsp; Emáx − estoque − em_trânsito
              </Formula>
              <p>
                O <strong className="text-foreground">em trânsito</strong> (o que já está em
                produção ou a caminho) conta como se estivesse na prateleira. Com{' '}
                {ex.reorder} no estoque e 6 em produção, o sistema enxerga {ex.reorder + 6} —
                acima do ponto de pedido de {ex.reorder}, então não pede de novo. É isso que
                evita pedidos duplicados.
              </p>
              <p>
                O outro lado da moeda: em trânsito desatualizado{' '}
                <strong className="text-foreground">é dinheiro errado nos dois sentidos</strong>.
                Peça registrada que já chegou faz o sistema deixar de comprar; peça que chegou
                e continua marcada como em produção faz ele comprar de novo.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Regras ao redor do cálculo</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  Item <strong className="text-foreground">fora de coleção</strong> (tela
                  Produtos) não recebe ponto de pedido nem entra no pedido de compra.
                </li>
                <li>
                  As quatro telas (Painel, Pedido, Curva ABC, Produtos) leem o{' '}
                  <strong className="text-foreground">mesmo snapshot</strong> — nunca
                  recalculam por conta própria, então nunca discordam entre si.
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'politica-de-compra',
      title: 'Política de compra',
      group: 'Os ajustes',
      description: 'Prazo de entrega, ciclo de pedido e CMV padrão — o que cada um muda.',
      body: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Os dois primeiros campos dimensionam todo o estoque; o terceiro só afeta os
            valores em reais.
          </p>
          <Param name="Prazo de entrega" value={`${lead} dias`}>
            <p>
              O tempo entre fazer o pedido e a mercadoria chegar na prateleira — produção
              mais transporte. É o parâmetro mais importante do sistema: entra no ponto de
              pedido (quanto será vendido durante a espera) e no estoque de segurança
              (quanto mais longa a espera, maior o colchão, via √).
            </p>
            <p>
              <strong className="text-foreground">Aumentar</strong> faz o sistema pedir
              mais cedo e manter mais segurança. <strong className="text-foreground">
              Diminuir sem o fornecedor ter ficado mais rápido</strong> é a receita
              clássica de ruptura: o sistema passa a acreditar que dá tempo de esperar.
            </p>
          </Param>
          <Param name="Ciclo de pedido" value={`${cycle} semanas`}>
            <p>
              De quanto em quanto tempo você pretende fazer compras. Só afeta o estoque
              máximo: cada pedido precisa cobrir a venda até a próxima rodada de compra.
            </p>
            <p>
              <strong className="text-foreground">Aumentar</strong> = pedidos maiores e
              menos frequentes (mais capital parado); <strong className="text-foreground">
              diminuir</strong> = pedidos menores e mais frequentes (mais trabalho de
              compra, menos estoque médio).
            </p>
            <p>
              <strong className="text-foreground">Não é a alavanca de Black Friday.</strong> O
              ciclo é um só para o catálogo inteiro: aumentá-lo infla também o item que vende
              meia peça por semana, que passa a carregar meses de estoque de um produto que
              quase não gira. Para comprar mais em uma data específica, o lugar certo é editar
              a quantidade linha a linha na tela de Pedido de compra.
            </p>
          </Param>
          <Param name="CMV quando não informado" value={cmv}>
            <p>
              Quando o produto não tem custo cadastrado, o sistema estima:
              custo = preço de venda × {cmv}. Não muda <em>quando</em> nem <em>quantas
              peças</em> pedir — só os totais em reais do pedido e dos agregados do
              Painel.
            </p>
          </Param>
        </div>
      ),
    },
    {
      slug: 'niveis-de-servico',
      title: 'Níveis de serviço',
      group: 'Os ajustes',
      description: 'A probabilidade de não faltar produto — e por que subir o A custa caro.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O que significa</CardTitle>
              <CardDescription>
                Hoje: A {levelA} · B {levelB} · C {levelC}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                O nível de serviço é a probabilidade de <strong className="text-foreground">
                não faltar produto durante os {lead} dias de espera</strong>. Um item classe
                A com {levelA} significa: das vezes em que o estoque atinge o ponto de
                pedido, em {levelA} delas a reposição chega antes de acabar a última peça.
              </p>
              <p>
                Itens mais importantes (classe A) ganham proteção maior porque a falta deles
                custa mais caro — em venda perdida e em cliente frustrado.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Como entra no cálculo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                Z(A {levelA}) = 1,96&nbsp;&nbsp;·&nbsp;&nbsp;Z(B {levelB}) = 1,64&nbsp;&nbsp;·&nbsp;&nbsp;Z(C {levelC}) = 1,28
              </Formula>
              <p>
                Cada percentual vira um fator Z que multiplica o desvio-padrão no estoque de
                segurança: ES = TETO( Z × σ × √({lead} ÷ 7) ). Quanto maior o Z, maior o
                colchão.
              </p>
              <p>
                Atenção: essa alavanca é <strong className="text-foreground">cara e não
                linear</strong>. Subir o A de 95% para 99% quase dobra o Z — e o estoque de
                segurança de todos os itens A vai junto. 100% não existe: o Z tenderia ao
                infinito.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'curva-abc',
      title: 'Curva ABC',
      group: 'Os ajustes',
      description: 'Como os itens são classificados por importância — e o que a classe muda.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Como a classificação funciona</CardTitle>
              <CardDescription>
                Cortes atuais: A até {cutA} · B até {cutB} do faturamento acumulado.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Os itens em coleção são ordenados pelo <strong className="text-foreground">
                faturamento semanal projetado</strong> (venda semanal × preço), do maior para
                o menor, e o faturamento vai sendo acumulado:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Quem cabe nos primeiros {cutA} do acumulado é <strong className="text-foreground">classe A</strong>.</li>
                <li>Até {cutB}, <strong className="text-foreground">classe B</strong>.</li>
                <li>O resto, <strong className="text-foreground">classe C</strong>.</li>
              </ul>
              <p>
                Poucos itens costumam concentrar a maior parte do faturamento — é neles que
                vale investir proteção.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O que a classe muda</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                A classe define <strong className="text-foreground">só o nível de serviço</strong>{' '}
                do estoque de segurança (A {levelA} · B {levelB} · C {levelC}); não muda a
                demanda estimada. Item sem classe (fora de coleção ou sem faturamento) usa o
                nível da classe C.
              </p>
              <p>
                Mover um corte para cima coloca mais itens na classe de proteção alta — mais
                segurança, mais capital parado. A curva roda apenas sobre os itens{' '}
                <strong className="text-foreground">em coleção</strong>: item descontinuado
                não disputa classe.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'versoes-e-recalculo',
      title: 'Versões e recálculo',
      group: 'Os ajustes',
      description: 'Simulação, nota da versão e por que parâmetro não se edita — publica-se.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Parâmetro não se edita: publica-se uma versão</CardTitle>
              <CardDescription>
                {params ? `Versão atual: v${params.version}.` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-foreground">Simulação</strong> — enquanto você
                  digita em Configurações, o painel da direita mostra o que os novos valores
                  produziriam (linhas no pedido, peças, segurança em reais) sem gravar nada.
                  Sirva-se: simular é grátis, publicar é que é compromisso.
                </li>
                <li>
                  <strong className="text-foreground">Nota da versão</strong> — o motivo da
                  mudança, gravado junto com ela. Daqui a seis meses, quando alguém perguntar
                  por que o pedido dobrou numa semana, é a nota que responde.
                </li>
                <li>
                  <strong className="text-foreground">Publicar e recalcular</strong> — cria a
                  versão nova, recalcula o snapshot e as quatro telas mudam juntas. As versões
                  anteriores continuam no histórico: todo número antigo permanece explicável
                  pelos parâmetros que o geraram.
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Um snapshot é uma foto datada do cálculo inteiro: cada item com sua demanda,
                σ, segurança, ponto de pedido e sugestão. Painel, Pedido de compra, Curva ABC
                e Produtos leem <strong className="text-foreground">o mesmo snapshot</strong>,
                por isso nunca discordam entre si. Importar dados não recalcula sozinho — você
                importa tudo, confere na Saúde dos dados e então recalcula, para as telas
                mudarem juntas.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'antes-de-aprovar',
      title: 'Antes de aprovar o pedido',
      group: 'No dia a dia',
      description: 'A conferência de cinco minutos que evita o erro de milhares de reais.',
      body: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            O sistema calcula; a decisão continua sendo sua. Esta é a sequência que vale a pena
            repetir toda vez, na ordem.
          </p>

          <Step n={1} title="A Saúde dos dados está verde?">
            <p>
              Se alguma fonte está desatualizada, o pedido foi calculado sobre uma foto velha.
              A tela nomeia o que está faltando — resolva antes, não depois.
            </p>
          </Step>

          <Step n={2} title="O em trânsito está atualizado?">
            <p>
              É o item que mais move dinheiro sozinho. Peça que já chegou e continua marcada
              como em produção faz o sistema comprar de novo; peça em produção que não foi
              registrada faz ele parar de comprar um item que vai faltar.
            </p>
          </Step>

          <Step n={3} title="Os custos estão cadastrados?">
            <p>
              Produto sem custo entra com a estimativa de {cmv} do preço de venda. Isso não
              muda quantas peças pedir, mas muda o total em reais que você vai olhar para
              decidir se cabe no caixa. Se a maior parte do pedido está sem custo real, trate o
              total como ordem de grandeza, não como número fechado.
            </p>
          </Step>

          <Step n={4} title="Os itens marcados como imprevisíveis foram conferidos?">
            <p>
              Os itens <strong className="text-foreground">AZ</strong> — importantes e
              erráticos — são onde o cálculo mais erra e onde o erro custa mais caro. A lista de
              prioridade de atenção no Painel já os coloca primeiro. São poucos; vale olhar um
              por um.
            </p>
          </Step>

          <Step n={5} title="Existe alguma coisa que só você sabe?">
            <p>
              Campanha marcada, coleção saindo de linha, fornecedor que avisou que vai atrasar,
              peça que vai aparecer em vídeo. Nada disso está no histórico. Ajuste a quantidade
              da linha na mão — o campo existe exatamente para isso.
            </p>
          </Step>

          <Card className="soft-panel shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Regra de bolso para datas de pico</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm leading-relaxed">
              <p>
                Se você espera vender o dobro durante 3 semanas, precisa de 3 semanas extras de
                estoque naquele item:
              </p>
              <Formula>semanas extras = (fator esperado − 1) × duração do pico</Formula>
              <p className="text-muted-foreground">
                Dobro por 3 semanas → (2 − 1) × 3 = 3 semanas extras. No produto do exemplo,
                isso são {ex.weekly} × 3 = {ex.weekly * 3} peças a mais naquela linha — e em
                nenhuma outra.
              </p>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'perguntas',
      title: 'Perguntas frequentes',
      group: 'No dia a dia',
      description: 'As dúvidas que aparecem toda semana, respondidas direto.',
      body: (
        <div className="space-y-4">
          <Question q="Tenho estoque para dois meses. Por que ele manda comprar agora?">
            <p>
              Porque a compra de hoje só chega daqui a {lead} dias. A pergunta que o sistema faz
              não é "quanto eu tenho", e sim "quanto vai sobrar no dia em que a mercadoria
              chegar". No produto do exemplo, {ex.stock} peças viram {d1(ex.leftAfterWait)} até
              lá — abaixo da reserva de {ex.safety}.
            </p>
            <p>
              O item não está em risco hoje. Está em risco no prazo que você não tem mais como
              recuperar.
            </p>
          </Question>

          <Question q="Quero comprar mais para a Black Friday. Aumento o ciclo de pedido?">
            <p>
              Não. O ciclo vale para o catálogo inteiro: subi-lo infla também o item que vende
              meia peça por semana e que passaria a carregar meses de estoque parado.
            </p>
            <p>
              O lugar certo é a tela de Pedido de compra, editando a quantidade dos itens que
              você espera que vendam mais. Use a regra de bolso:{' '}
              <strong className="text-foreground">(fator − 1) × semanas de pico</strong> ={' '}
              semanas extras de estoque naquele item.
            </p>
          </Question>

          <Question q="Por que este produto não aparece no pedido?">
            <p>Existem três motivos possíveis, nesta ordem de frequência:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Estoque mais em trânsito ainda está{' '}
                <strong className="text-foreground">acima do ponto de pedido</strong> — a luz
                não acendeu.
              </li>
              <li>
                O item está marcado como <strong className="text-foreground">fora de coleção</strong>{' '}
                na tela Produtos. Fora de coleção não entra no pedido, por mais que venda.
              </li>
              <li>
                O item <strong className="text-foreground">não tem venda no histórico</strong>.
                Sem venda não há demanda estimada, e sem demanda não há ponto de pedido.
              </li>
            </ul>
          </Question>

          <Question q="Mudei um parâmetro e a tela continua igual.">
            <p>
              Mudar o campo não muda nada sozinho: é preciso{' '}
              <strong className="text-foreground">publicar e recalcular</strong>. Enquanto
              você só digita, o que aparece é a simulação — de propósito, para você poder
              experimentar sem consequência.
            </p>
          </Question>

          <Question q="Refiz a conta no papel e deu diferente por uma peça.">
            <p>
              Provavelmente arredondamento. A reserva e o ponto de pedido usam{' '}
              <strong className="text-foreground">teto</strong> (sempre para cima — meia peça de
              proteção não protege ninguém), e o estoque máximo usa arredondamento normal.
            </p>
          </Question>

          <Question q="Um produto novo entrou e não recebeu reserva nenhuma.">
            <p>
              Com menos de 2 semanas de vida não existe como medir oscilação honestamente — uma
              única observação não tem desvio. O sistema prefere deixar o campo vazio e dizer
              que não sabe, em vez de inventar um número que pareceria confiável.
            </p>
            <p>
              Entre 2 e 4 semanas, o número aparece marcado como{' '}
              <strong className="text-foreground">baixa confiança</strong>. Nesses itens, o
              julgamento humano ainda vale mais que o cálculo.
            </p>
          </Question>

          <Question q="Dois produtos vendem igual e têm pedidos bem diferentes. Está errado?">
            <p>
              Quase sempre está certo — e a causa é a irregularidade. Média igual com oscilação
              diferente dá reserva diferente, e reserva diferente sobe por toda a cadeia: ponto
              de pedido, estoque máximo e quantidade sugerida.
            </p>
            <p>
              A outra causa possível é a classe ABC: o mesmo volume em produtos de preços
              diferentes gera faturamentos diferentes, e faturamento é o que decide quanta
              proteção cada um recebe.
            </p>
          </Question>

          <Question q="O total do pedido em reais parece estranho.">
            <p>
              Verifique quantos itens do pedido têm custo cadastrado. Os que não têm entram com{' '}
              {cmv} do preço de venda — uma estimativa razoável para olhar de longe, e ruim para
              fechar caixa. O número de peças, esse, não depende do custo.
            </p>
          </Question>
        </div>
      ),
    },
  ]

  const current = pages.find((p) => p.slug === (slug ?? '')) ?? pages[0]
  const idx = pages.indexOf(current)
  const prev = idx > 0 ? pages[idx - 1] : null
  const next = idx < pages.length - 1 ? pages[idx + 1] : null
  const groups = [...new Set(pages.map((p) => p.group))]
  const href = (p: DocPage) => (p.slug ? `/documentacao/${p.slug}` : '/documentacao')

  return (
    <div className="mx-auto flex max-w-5xl gap-8">
      <nav className="hidden w-52 shrink-0 space-y-5 lg:sticky lg:top-6 lg:block lg:self-start">
        {groups.map((g) => (
          <div key={g} className="space-y-1">
            <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g}
            </p>
            {pages.filter((p) => p.group === g).map((p) => (
              <Link
                key={p.slug}
                to={href(p)}
                className={cn(
                  'block rounded-md px-2 py-1.5 text-sm transition-colors',
                  p === current
                    ? 'bg-surface font-semibold text-ink shadow-xs'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {p.title}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Documentação · {current.group}
          </p>
          <h1 className="text-page-title">{current.title}</h1>
          <p className="text-sm text-muted-foreground">{current.description}</p>
        </div>

        {/* Índice para telas estreitas, onde a navegação lateral some. */}
        <div className="flex flex-wrap gap-2 lg:hidden">
          {pages.map((p) => (
            <Link key={p.slug} to={href(p)}>
              <Badge variant={p === current ? 'default' : 'outline'} className="font-normal">
                {p.title}
              </Badge>
            </Link>
          ))}
        </div>

        {current.body}

        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          {prev ? (
            <Link
              to={href(prev)}
              className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" /> {prev.title}
            </Link>
          ) : <span />}
          {next && (
            <Link
              to={href(next)}
              className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-ink"
            >
              {next.title} <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Os valores desta documentação são os parâmetros atuais da sua empresa
          {params ? ` (versão ${params.version})` : ''} — se mudarem em Configurações, o
          texto muda junto.
        </p>
      </div>
    </div>
  )
}
