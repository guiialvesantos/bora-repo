import { useMemo } from 'react'
import { useCurrentSnapshot, useSnapshotItems } from '@/hooks/useCurrentSnapshot'
import { useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { useProductImages } from '@/hooks/useProductImages'
import { ProductCell } from '@/components/ProductThumb'
import { ColLabel } from '@/components/InfoHint'
import { LoadingBlock } from '@/components/brand/Logo'
import { formatBRL, formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import type { AbcClass, SnapshotItem } from '@/lib/replenishment-types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/**
 * A/B/C é CATEGORIA, não status — um item C não está com problema, ele é só
 * cauda. Enquanto A era verde e B âmbar, a curva lia como semáforo e o C, em
 * cinza, lia como "quebrado". Agora as três saem da paleta categórica, na
 * ordem de intensidade que a própria curva tem: azul cheio no A, violeta no B,
 * lavagem fria no C.
 */
const TONE: Record<AbcClass, string> = {
  A: 'border-brand-300 bg-brand-100 text-brand-700',
  B: 'border-violet-300 bg-violet-200 text-violet-800',
  C: 'border-cyan-300 bg-cyan-100 text-cyan-1000',
}

function pct(v: number) {
  return `${v.toFixed(1).replace('.', ',')}%`
}

/**
 * Um `[]` escrito na linha do `??` nasce diferente a cada render, e os dois
 * `useMemo` abaixo — que ordenam e agrupam ~2 mil linhas — recomeçariam do zero
 * a cada toque de estado. Uma constante de módulo tem sempre a mesma
 * identidade, então "sem itens" é o mesmo "sem itens" da volta anterior.
 */
const NO_ITEMS: SnapshotItem[] = []

export default function AbcCurve() {
  const snap = useCurrentSnapshot()
  const snapshot = snap.data
  const itemsQuery = useSnapshotItems(snapshot?.id)
  const items = itemsQuery.data ?? NO_ITEMS

  // A espera é a das DUAS consultas, em série: a das linhas nasce desligada
  // (`enabled: !!snapshotId`) e só liga quando o snapshot chega. Perguntar só
  // por ela deixaria um vão — consulta desligada não está carregando — em que a
  // tela anunciaria "nenhum item com classe" antes de ter pedido os itens.
  const isLoading = snap.isLoading || itemsQuery.isLoading
  const { data: params } = useReplenishmentParams()
  const { data: images } = useProductImages()

  const level: Record<AbcClass, string> = {
    A: pct(num(params?.service_level_a) * 100),
    B: pct(num(params?.service_level_b) * 100),
    C: pct(num(params?.service_level_c) * 100),
  }

  // Só quem tem classe. A curva roda sobre os itens em coleção — item fora de
  // coleção não recebe nível de serviço porque não vai ser recomprado.
  //
  // Ordenar pelo acumulado, e não pelo faturamento, não é detalhe: o desempate
  // do motor é `source_row` (o SORTBY do Excel é estável), e refazer a ordem
  // aqui por faturamento trocaria de lugar dois itens de mesma receita — a
  // tela mostraria uma sequência que não é a que gerou as classes.
  const ranked = useMemo(
    () => items.filter((i) => i.abc_class != null)
      .sort((a, b) => num(a.abc_cum_pct) - num(b.abc_cum_pct)),
    [items])

  const annualTotal = ranked.reduce((s, i) => s + num(i.weekly_revenue) * 52, 0)

  const groups = useMemo(() => {
    const acc: Record<AbcClass, { count: number; revenue: number }> = {
      A: { count: 0, revenue: 0 },
      B: { count: 0, revenue: 0 },
      C: { count: 0, revenue: 0 },
    }
    for (const i of ranked) {
      const g = acc[i.abc_class as AbcClass]
      g.count += 1
      g.revenue += num(i.weekly_revenue) * 52
    }
    return acc
  }, [ranked])

  // A ordem aqui é a correção. Antes a tela testava só `!snapshot`, e
  // `undefined` durante a consulta cai no mesmo balde que `null` depois dela:
  // quem abria a curva via "nenhum cálculo ainda" por um instante, mesmo tendo
  // cálculo. Agora a espera aparece como espera, e o vazio só é anunciado
  // depois que o banco respondeu que realmente não há nada.
  // A espera cobre a tela inteira, e não só a tabela. Os três cartões de cima
  // são somados a partir das MESMAS linhas: enquanto elas não chegam, eles
  // mostram "0 itens · R$ 0,00 por ano" — que não se lê como espera, se lê como
  // resposta. Um zero com cara de número certo é pior que um vazio.
  if (isLoading) return <LoadingBlock className="min-h-[50vh]" />

  if (snap.error) {
    return (
      <p className="text-sm text-destructive">
        Não foi possível carregar o cálculo: {snap.error.message}
      </p>
    )
  }

  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">Nenhum cálculo ainda. Importe os dados e recalcule.</p>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Curva ABC</h1>
        <p className="text-sm text-muted-foreground">
          Os itens em coleção ordenados por faturamento. A classe decide o nível de serviço,
          e o nível de serviço decide quanto de estoque de segurança cada item carrega.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {(['A', 'B', 'C'] as AbcClass[]).map((c) => (
          <Card key={c}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge variant="outline" className={TONE[c]}>Classe {c}</Badge>
                <span className="text-sm font-normal text-muted-foreground">
                  nível {level[c]}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-semibold tabular-nums">
                {formatInt(groups[c].count)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">itens</span>
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {formatBRL(groups[c].revenue)} por ano
                {annualTotal > 0 && ` · ${pct((groups[c].revenue / annualTotal) * 100)}`}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {formatInt(ranked.length)} itens em coleção · {formatBRL(annualTotal)} ao ano
          </CardTitle>
          <CardDescription>
            O acumulado usa o faturamento da demanda ponderada anualizada, não a venda passada
            crua — é a mesma base que alimenta o ponto de pedido, então a classe e o pedido
            nunca contam histórias diferentes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ranked.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nenhum item em coleção com classe atribuída.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 text-right">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="fatSemanal">Fat. semanal</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="fatAnual">Fat. anual</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="cumPct">% acum.</ColLabel>
                  </TableHead>
                  <TableHead className="text-center">
                    <ColLabel term="classe">Classe</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="z">Z</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="es">ES</ColLabel>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ranked.map((i: SnapshotItem, idx) => (
                  <TableRow key={i.product_id}>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{i.sku}</TableCell>
                    <TableCell className="max-w-[320px]">
                      <ProductCell image={images?.get(i.product_id)} name={i.name} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(num(i.weekly_revenue))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(num(i.weekly_revenue) * 52)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(num(i.abc_cum_pct) * 100)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline" className={TONE[i.abc_class as AbcClass]}>
                        {i.abc_class}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {num(i.z).toFixed(4).replace('.', ',')}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatInt(num(i.safety_stock))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
