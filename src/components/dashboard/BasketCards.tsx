import { ArrowRight, Link2, Sparkles } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartNote, InfoHint } from '@/components/InfoHint'
import { formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import { useBasket } from '@/hooks/useSalesInsights'
import type { CensusFilters } from '@/hooks/useDashboardCensus'
import type { GlossaryKey } from '@/lib/glossary'

/**
 * Os dois cartões de cesta.
 *
 * Moram no mesmo arquivo porque leem o MESMO `useBasket` — a chave da consulta
 * é idêntica nos dois, então o React Query resolve uma vez e serve as duas.
 * Separá-los em dois RPCs faria o banco cruzar a cesta duas vezes para desenhar
 * dois quadros que ficam lado a lado.
 *
 * Os dois são de VENDA: obedecem a canal e período, não a depósito.
 */

function Head({ icon: Icon, tone, title, description, chip, hint, note, noteLabel }: {
  icon: typeof Link2
  tone: string
  title: string
  description: string
  chip?: string
  hint?: GlossaryKey
  note: React.ReactNode
  noteLabel: string
}) {
  return (
    <CardHeader className="pb-3">
      {/* O "i" fica FORA do grupo que quebra linha: nesses dois cartões o título
          é longo e o chip desce para a linha de baixo, levando o ícone junto —
          e aí ele não está mais no canto onde se procura por ele. */}
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2.5">
            <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm ${tone}`}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div>
              <CardTitle className="flex items-center gap-1.5 text-card-title">
                {title}
                {hint && <InfoHint term={hint} />}
              </CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
          {chip && (
            <span className="rounded-xs bg-surface-inset px-2 py-1 text-micro text-muted-foreground">
              {chip}
            </span>
          )}
        </div>
        <ChartNote label={noteLabel}>{note}</ChartNote>
      </div>
    </CardHeader>
  )
}

function Rank({ n }: { n: number }) {
  return (
    <span className="w-3 shrink-0 text-right font-data text-micro tabular-nums text-muted-foreground">
      {n}
    </span>
  )
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2, 3, 4].map((k) => (
        <div key={k} className="h-8 animate-pulse rounded-xs bg-surface-inset" />
      ))}
    </div>
  )
}

/**
 * Nada que passe do piso de pedidos. A frase diz o piso porque "nenhum par"
 * soa como "ninguém compra duas coisas juntas", e o que houve foi outra coisa:
 * houve pares, nenhum repetido o bastante para significar alguma coisa.
 */
function Empty({ min }: { min: number }) {
  return (
    <p className="py-6 text-center text-xs text-muted-foreground">
      Nenhum par se repetiu em {min} pedidos ou mais no período. Períodos curtos
      raramente têm repetição suficiente — experimente uma janela maior.
    </p>
  )
}

export function SoldTogetherCard({ filters }: { filters: CensusFilters }) {
  const { data, isLoading } = useBasket(filters)
  const pairs = data?.pairs ?? []

  return (
    <Card className="flex flex-col">
      <Head
        icon={Link2}
        tone="bg-brand-100 text-brand-700"
        title="Produtos vendidos em conjunto"
        description="Produtos que aparecem juntos no mesmo pedido"
        chip={data ? `${formatInt(data.pair_count)} ${data.pair_count === 1 ? 'par' : 'pares'}` : undefined}
        noteLabel="Como os pares são contados"
        note={
          <>
            <p>
              A contagem é por <strong className="text-ink">pedido</strong>, com tamanhos e cores
              somados no produto pai — sem isso, dois tamanhos da mesma peça no mesmo pedido
              viravam um "par" e o cartão ensinaria que calça vende junto com calça.
            </p>
            <p>
              Só entram pares repetidos em {data?.min_orders ?? 3} pedidos ou mais: abaixo disso,
              dois produtos raríssimos que caíram juntos uma vez encabeçariam a lista para sempre.
            </p>
          </>
        }
      />
      <CardContent className="flex-1 pt-0">
        {isLoading ? <Skeleton />
          : pairs.length === 0 ? <Empty min={data?.min_orders ?? 3} />
            : (
              <ul className="divide-y divide-border">
                {pairs.map((p, n) => (
                  <li key={`${p.a_name}|${p.b_name}`} className="flex items-center gap-2.5 py-2">
                    <Rank n={n + 1} />
                    <span className="min-w-0 flex-1 truncate text-xs" title={p.a_name}>
                      {p.a_name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs" title={p.b_name}>
                      <span className="text-muted-foreground">+ </span>{p.b_name}
                    </span>
                    <span className="shrink-0 whitespace-nowrap">
                      <span className="font-data text-xs font-bold tabular-nums">
                        {formatInt(num(p.orders))}
                      </span>
                      <span className="ml-1 text-micro uppercase text-muted-foreground">pedidos</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </CardContent>
    </Card>
  )
}

/** `23,6×` para afinidade forte, `1,8×` para as de perto do acaso. */
function liftLabel(v: number): string {
  return v >= 10
    ? `${Math.round(v).toLocaleString('pt-BR')}×`
    : `${v.toFixed(1).replace('.', ',')}×`
}

export function UpsellCard({ filters }: { filters: CensusFilters }) {
  const { data, isLoading } = useBasket(filters)
  const rows = data?.upsell ?? []

  return (
    <Card className="flex flex-col">
      <Head
        icon={Sparkles}
        tone="bg-violet-200 text-violet-800"
        title="Oportunidades de upsell"
        description="Quem compra X também leva Y"
        chip={rows.length > 0
          ? `${rows.length} ${rows.length === 1 ? 'oportunidade' : 'oportunidades'}`
          : undefined}
        hint="lift"
        noteLabel="Como a lista é ordenada"
        note={
          <>
            <p>
              Ordenado por <strong className="text-ink">lift</strong>, não por confiança:
              confiança sozinha só redescobre o mais vendido da loja, que aparece junto de tudo
              por ser o mais vendido.
            </p>
            <p>
              A confiança vem sempre com o denominador — 75% de 4 pedidos e 75% de 200 não valem
              a mesma decisão. Só entram pares repetidos em {data?.min_orders ?? 3} pedidos ou
              mais, senão o lift vira coincidência com número grande.
            </p>
          </>
        }
      />
      <CardContent className="flex-1 pt-0">
        {isLoading ? <Skeleton />
          : rows.length === 0 ? <Empty min={data?.min_orders ?? 3} />
            : (
              <ul className="divide-y divide-border">
                {rows.map((r, n) => (
                  <li key={`${r.from_name}|${r.to_name}`} className="flex items-start gap-2.5 py-2">
                    <Rank n={n + 1} />
                    <div className="min-w-0 flex-1">
                      {/* `flex-1 basis-0` nos dois: sem isso o flex dimensiona
                          cada nome pelo conteúdo e o sugerido — que é o lado
                          que interessa — sobra com quatro letras quando o
                          primeiro nome é longo. Metade da linha para cada um. */}
                      <p className="flex min-w-0 items-center gap-1.5 text-xs">
                        <span className="min-w-0 flex-1 basis-0 truncate" title={r.from_name}>
                          {r.from_name}
                        </span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span
                          className="min-w-0 flex-1 basis-0 truncate font-medium text-brand-600"
                          title={r.to_name}
                        >
                          {r.to_name}
                        </span>
                      </p>
                      {/* Confiança sem o denominador é propaganda: "75%" de
                          quatro pedidos e "75%" de duzentos não valem a mesma
                          decisão. Os dois números andam juntos. */}
                      <p className="mt-0.5 text-micro text-muted-foreground">
                        <span className="font-data font-medium text-ink tabular-nums">
                          {Math.round(num(r.confidence) * 100)}%
                        </span>
                        {' dos pedidos · '}
                        {formatInt(num(r.orders))} de {formatInt(num(r.from_orders))} pedidos
                      </p>
                    </div>
                    <span className="shrink-0 rounded-xs bg-brand-100 px-1.5 py-0.5 font-data text-micro font-medium tabular-nums text-brand-700">
                      {liftLabel(num(r.lift))} lift
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </CardContent>
    </Card>
  )
}
