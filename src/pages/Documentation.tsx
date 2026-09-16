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
  const fmtCut = (v: number) =>
    v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
  const xyzX = fmtCut(num(params?.xyz_cut_x) || 1)
  const xyzY = fmtCut(num(params?.xyz_cut_y) || 1.6)

  const pages: DocPage[] = [
    {
      slug: '',
      title: 'Visão geral',
      group: 'O cálculo',
      description: 'Os cinco passos que o sistema segue para decidir quando e quanto pedir.',
      body: (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Tempo de reposição: {lead} dias (~{leadWeeks} semanas)</Badge>
            <Badge variant="outline">Ciclo de compras: {cycle} semanas</Badge>
            <Badge variant="outline">Janela recente: {recent} dias</Badge>
            <Badge variant="outline">Nível de serviço: A {levelA} · B {levelB} · C {levelC}</Badge>
          </div>

          <Step n={1} title="O sistema estima quanto o produto vende">
            {modern ? (
              <>
                <p>Ele combina duas médias:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>A média dos últimos <strong className="text-foreground">90 dias</strong>, com peso de 70%.</li>
                  <li>A média dos últimos <strong className="text-foreground">180 dias</strong>, com peso de 30%.</li>
                </ul>
                <p>
                  É como estimar o trânsito de amanhã: o que aconteceu neste trimestre vale
                  mais do que a média do semestre — mas a média do semestre evita que um
                  mês atípico engane a conta.
                </p>
              </>
            ) : (
              <>
                <p>Ele combina duas médias, cada uma com peso de 50%:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>A média de vendas desde que o produto entrou no catálogo.</li>
                  <li>A média dos últimos {recent} dias.</li>
                </ul>
              </>
            )}
            <p>
              O resultado é uma estimativa de <strong className="text-foreground">quantas
              peças serão vendidas por semana</strong>.
            </p>
          </Step>

          <Step n={2} title="Ele cria um estoque de segurança">
            <p>
              O estoque de segurança é uma reserva para imprevistos. Por exemplo: normalmente
              o produto vende 5 peças por semana, mas algumas semanas vende 3 e, em outras, 9.
              Como a reposição demora {lead} dias, o sistema mantém peças extras para
              suportar as semanas com venda acima do normal.
            </p>
            <p>Produtos mais importantes recebem uma proteção maior:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong className="text-foreground">Classe A</strong> — maior proteção ({levelA} de nível de serviço).</li>
              <li><strong className="text-foreground">Classe B</strong> — proteção intermediária ({levelB}).</li>
              <li><strong className="text-foreground">Classe C</strong> — menor proteção ({levelC}).</li>
            </ul>
            <p>
              O cálculo usa uma raiz quadrada, que de forma simples significa: aumentar o
              prazo de entrega aumenta o risco, mas esse risco não cresce na mesma proporção
              — dobrar a espera não dobra o colchão necessário.
            </p>
          </Step>

          <Step n={3} title="Ele define quando fazer o pedido">
            <p>
              O <strong className="text-foreground">ponto de pedido</strong> (estoque mínimo)
              é o nível que dispara uma nova compra. A lógica:
            </p>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-foreground">
              Peças que provavelmente serão vendidas durante os {lead} dias de espera
              + estoque de segurança.
            </p>
            <p>
              Se durante os próximos {lead} dias você espera vender 8 peças e quer manter
              10 de segurança: ponto de pedido = 8 + 10 = <strong className="text-foreground">18 peças</strong>.
            </p>
            <p>
              Ao chegar a 18 peças disponíveis, já é hora de pedir — essas 18 peças precisam
              sustentar a operação enquanto a nova mercadoria é produzida e transportada.
            </p>
          </Step>

          <Step n={4} title="Ele calcula até quanto repor">
            <p>
              O <strong className="text-foreground">estoque máximo</strong> é o nível que o
              sistema tenta alcançar após o pedido. Além de proteger os {lead} dias de
              espera, ele adiciona mercadoria suficiente para cobrir o ciclo de compras
              de {cycle} semanas.
            </p>
            <p>No exemplo:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Estoque de segurança: 10 peças.</li>
              <li>Ponto de pedido: 18 peças.</li>
              <li>Estoque máximo: 28 peças.</li>
            </ul>
            <p>
              Quando o estoque chega a 18, o sistema recomenda voltar para 28. Se não houver
              nada em produção: pedido recomendado = 28 − 18 = <strong className="text-foreground">10 peças</strong>.
            </p>
          </Step>

          <Step n={5} title="Ele considera o que já foi comprado">
            <p>
              Se você possui 18 peças no estoque e outras 6 já estão sendo produzidas, o
              sistema considera que você tem 24:
            </p>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-foreground">
              18 no estoque + 6 em trânsito = 24 peças
            </p>
            <p>
              Como 24 ainda está acima do ponto de pedido de 18, não é preciso comprar de
              novo. Isso evita pedidos duplicados.
            </p>
          </Step>

          <Card className="soft-panel shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Em uma frase</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed">
              O sistema responde: <em>"quando preciso pedir para não ficar sem produto
              durante os {lead} dias de espera — e quantas peças preciso comprar para operar
              com segurança até o próximo ciclo?"</em>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'demanda-semanal',
      title: 'Demanda semanal',
      group: 'O cálculo',
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
      group: 'O cálculo',
      description: 'A reserva contra semanas de venda acima do normal — e como o σ é medido.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A ideia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                O estoque de segurança é uma reserva para imprevistos. Normalmente o produto
                vende 5 peças por semana, mas algumas semanas vende 3 e, em outras, 9. Como a
                reposição demora {lead} dias, o sistema mantém peças extras para suportar as
                semanas com venda acima do normal.
              </p>
              <p>
                Quanto mais irregular a venda de um item, maior a reserva que ele precisa. É
                por isso que dois produtos com a mesma média podem ter colchões bem
                diferentes.
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
                      vida → o número aparece marcado como baixa confiança (e o item fica
                      "não classificado" na camada de previsibilidade).
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
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'ponto-de-pedido-e-estoque-maximo',
      title: 'Ponto de pedido e estoque máximo',
      group: 'O cálculo',
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
              <Formula>
                Emín = TETO( ES + venda_semanal × {lead} ÷ 7 )
              </Formula>
              <p>
                <code className="text-xs">venda_semanal × {lead}÷7</code> é o que será
                vendido <strong className="text-foreground">enquanto a produção está em
                andamento</strong> (~{leadWeeks} semanas). Pedir só quando o estoque acaba
                significaria {lead} dias de ruptura.
              </p>
              <p>
                Exemplo: se durante os próximos {lead} dias você espera vender 8 peças e quer
                manter 10 de segurança, o ponto de pedido é 8 + 10 ={' '}
                <strong className="text-foreground">18 peças</strong>. Ao chegar a 18
                disponíveis, já é hora de pedir.
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
              <Formula>
                Emáx = ARRED( Emín + venda_semanal × {cycle} semanas )
              </Formula>
              <p>
                As {cycle} semanas são o ciclo de compras: o Emáx precisa cobrir o intervalo
                até o próximo pedido, mais o lead time do pedido seguinte, mais a segurança.
                No exemplo: segurança 10, ponto de pedido 18, máximo 28. Quando o estoque
                chega a 18, o sistema recomenda voltar para 28 — pedido de 28 − 18 ={' '}
                <strong className="text-foreground">10 peças</strong>.
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
                produção ou a caminho) conta como se estivesse na prateleira. Com 18 no
                estoque e 6 em produção, o sistema enxerga 24 — acima do ponto de pedido de
                18, então não pede de novo. É isso que evita pedidos duplicados.
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
      group: 'Parâmetros',
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
      group: 'Parâmetros',
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
      group: 'Parâmetros',
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
      slug: 'previsibilidade',
      title: 'Previsibilidade (XYZ)',
      group: 'Parâmetros',
      description: 'O quanto dá para confiar na previsão de cada item — e onde o olho humano vale mais.',
      body: (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">A ideia</CardTitle>
              <CardDescription>
                O ABC diz o que importa; o XYZ diz o quanto a previsão daquele item é confiável.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Analogia: previsão do tempo. Para o deserto, a previsão de amanhã quase
                nunca erra; para a serra, o mesmo meteorologista com os mesmos dados erra o
                tempo todo. O problema não é o meteorologista — é a natureza da série. A
                letra XYZ classifica cada item pelo "clima" da sua demanda:{' '}
                <strong className="text-foreground">X</strong> previsível,{' '}
                <strong className="text-foreground">Y</strong> intermediário,{' '}
                <strong className="text-foreground">Z</strong> errático.
              </p>
              <p>
                Um item <strong className="text-foreground">AZ</strong> — importante E
                errático — é onde o modelo mais erra e onde o erro custa mais. É ele que
                merece conferência humana antes de aprovar o pedido; o resto pode rodar no
                automático.
              </p>
              <p>
                Importante: a camada XYZ <strong className="text-foreground">não muda
                nenhum número do cálculo</strong>. Segurança, ponto de pedido e máximo
                continuam exatamente iguais — XYZ é lente, não alavanca.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Como a letra é decidida</CardTitle>
              <CardDescription>
                Cortes atuais: X até CV {xyzX} · Y até CV {xyzY} · Z acima disso.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Formula>
                CV = σ ÷ venda_semanal
              </Formula>
              <p>
                O CV (coeficiente de variação) é o "nervosismo relativo": um σ de 8 é
                enorme para quem vende 2 por semana (CV 4,0) e irrisório para quem vende 80
                (CV 0,1). Dividir pelo volume é o que permite comparar um carro-chefe com
                um item de nicho na mesma régua.
              </p>
              <p>
                Exemplo: σ = 8 e venda de 9,4/semana → CV = 8 ÷ 9,4 ={' '}
                <strong className="text-foreground">0,85</strong> → classe X.
              </p>
              <p>
                Os cortes ({xyzX} e {xyzY}) não vieram de manual: são os terços da
                distribuição de CV da própria base. Manuais sugerem cortes tipo 0,5/1,0,
                calibrados para bens de giro rápido — com eles quase toda semijoia cairia
                em Z e a classe não separaria nada (alarme que toca sempre não avisa nada).
                Como todo parâmetro, os cortes são versionados e podem ser recalibrados.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">O erro histórico do modelo</CardTitle>
              <CardDescription>
                Quanto o modelo de previsão de fato errou naquele item, no passado.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Para cada item, o sistema volta no tempo, finge não conhecer o futuro,
                prevê 8/12/16 semanas à frente e compara com o que realmente aconteceu.
                O resultado aparece no formato:
              </p>
              <Formula>
                AZ · erro histórico típico ±38% · 6 origens
              </Formula>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong className="text-foreground">±38%</strong> — o desvio típico entre
                  previsto e realizado nas janelas testadas daquele item.
                </li>
                <li>
                  <strong className="text-foreground">6 origens</strong> — em quantas datas
                  de corte o item já existia para ser testado. Mais origens = medida mais
                  sólida.
                </li>
              </ul>
              <p>
                O erro <strong className="text-foreground">nunca decide a letra</strong> —
                só o CV decide. Motivo: um item que vende 1 peça/semana tem erro percentual
                enorme por construção (errar 1 peça = errar 100%), e rebaixá-lo por isso
                puniria o item por ser pequeno, não por ser imprevisível. O erro entra como
                contexto, no tooltip.
              </p>
              <p>
                E nunca aparece "confiança: 89%" — uma porcentagem única de confiança seria
                pseudo-precisão que a base não sustenta.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Estados especiais</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-foreground">n/c — não classificada</strong> —
                  menos de 4 semanas de histórico ou demanda zero. Classificar um
                  lançamento de 2 semanas como Z transmitiria certeza falsa; "ainda não
                  sei" é a resposta honesta.
                </li>
                <li>
                  <strong className="text-foreground">sem erro medido</strong> — o
                  realizado somou zero em todas as janelas avaliadas. Não é erro zero nem
                  erro infinito: é ausência de métrica honesta, e é o motivo que aparece.
                </li>
                <li>
                  <strong className="text-foreground">sem histórico de backtest</strong> —
                  item lançado depois do último corte elegível; o teste ainda não teve
                  chance de avaliá-lo.
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Onde aparece no Painel</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-foreground">Chip ao lado da classe ABC</strong> na
                  tabela por SKU — Z em âmbar; o tooltip traz o CV e a linha de erro.
                </li>
                <li>
                  <strong className="text-foreground">Filtro de previsibilidade</strong> —
                  X / Y / Z / baixa amostra.
                </li>
                <li>
                  <strong className="text-foreground">Prioridade de atenção</strong> — AZ
                  primeiro, depois AY e BZ, por faturamento: os itens para conferir à mão
                  antes de aprovar o pedido.
                </li>
                <li>
                  <strong className="text-foreground">Matriz ABC × XYZ</strong> — o mapa da
                  base inteira; o canto AZ acende quando habitado.
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      slug: 'versoes-e-recalculo',
      title: 'Versões e recálculo',
      group: 'Parâmetros',
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
