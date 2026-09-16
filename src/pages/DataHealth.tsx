import { AlertTriangle, CheckCircle2, CircleSlash, Clock } from 'lucide-react'
import { useDataHealth } from '@/hooks/useDataHealth'
import { KIND_LABEL } from '@/lib/replenishment-types'
import { formatInt } from '@/lib/money'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

function dt(v: string | null) {
  if (!v) return '—'
  return new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function d(v: string | null) {
  if (!v) return '—'
  return new Date(`${v}T12:00:00`).toLocaleDateString('pt-BR')
}

export default function DataHealth() {
  const { data, isLoading } = useDataHealth()

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>
  if (!data) return <p className="text-sm text-muted-foreground">Sem dados.</p>

  const { checks, params } = data

  // Cada achado vira uma linha só quando ele existe DE FATO no dado que está no
  // banco agora. Listar os cinco sempre, com zero ao lado, seria ruído.
  const findings: { title: string; body: string; tone: 'warn' | 'info' }[] = []

  if (checks.recent_window_dead) {
    findings.push({
      tone: 'warn',
      title: 'A demanda estimada está pela metade',
      body: 'A janela de 28 dias está ancorada em hoje, e a base de vendas termina antes disso — '
        + 'nenhum SKU tem venda recente, então a demanda ponderada é metade da de longo prazo. '
        + 'Ponto de pedido e estoque máximo saem subdimensionados. '
        + 'Corrige-se em Configurações, virando a âncora para a data de referência.',
    })
  }

  if (checks.transit_qty_lost_to_whitespace > 0) {
    findings.push({
      tone: 'warn',
      title: `${formatInt(checks.transit_qty_lost_to_whitespace)} peças em trânsito invisíveis`,
      body: 'Há referências de fornecedor com espaço sobrando no código. Em modo de paridade com a '
        + 'planilha o casamento é feito sem aparar espaço, exatamente como o SUMIF do Excel, '
        + 'e essas peças não abatem a sugestão de compra — o que faz comprar de novo o que já '
        + 'está a caminho.',
    })
  }

  if (checks.sales_overlapping_qty > 0) {
    findings.push({
      tone: 'warn',
      title: `${formatInt(checks.sales_overlapping_qty)} peças vendidas em mais de um canal no mesmo dia`,
      body: `São ${formatInt(checks.sales_overlapping_pairs)} combinações de data e SKU que aparecem `
        + 'em dois canais. Pode ser venda legítima — a loja física e o Olist vendendo a mesma peça '
        + 'no mesmo dia — ou pode ser a mesma carga contada duas vezes, porque reimportar um '
        + 'arquivo substitui só as vendas manuais e deixa as de outro canal embaixo. '
        + 'O dado não distingue os dois casos; quem sabe se a loja vendeu é você. '
        + 'Se for duplicata, toda a demanda está dobrada.',
    })
  }

  if (checks.sales_skus_without_product > 0) {
    findings.push({
      tone: 'info',
      title: `${formatInt(checks.sales_skus_without_product)} SKUs vendidos sem produto no catálogo`,
      body: 'A venda continua contando como demanda, mas esses SKUs não recebem sugestão de compra '
        + 'porque não existem no catálogo importado. Normal para item descontinuado; suspeito '
        + 'se for lançamento.',
    })
  }

  if (checks.transit_items_without_product > 0) {
    findings.push({
      tone: 'info',
      title: `${formatInt(checks.transit_items_without_product)} itens em trânsito sem produto casado`,
      body: `${formatInt(checks.transit_qty_without_product)} peças a caminho de códigos que não `
        + 'estão no catálogo.',
    })
  }

  if (checks.products_without_price > 0) {
    findings.push({
      tone: 'info',
      title: `${formatInt(checks.products_without_price)} produtos sem preço de venda`,
      body: 'Entram no cálculo com faturamento zero, o que os joga para o fim da curva ABC e lhes '
        + 'dá o nível de serviço mais frouxo.',
    })
  }

  if (checks.orders_pending_items > 0) {
    findings.push({
      tone: 'warn',
      title: `${formatInt(checks.orders_pending_items)} pedidos de venda sem itens buscados`,
      body: 'A API v2 não traz itens na listagem de pedidos: é uma chamada por pedido. Enquanto '
        + 'esses pedidos não forem detalhados, a venda deles não conta em lugar nenhum.',
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Saúde dos dados</h1>
        <p className="text-sm text-muted-foreground">
          De onde veio cada número e o que está faltando para o pedido sair certo.
        </p>
      </div>

      {data.blocking.length > 0 && (
        <Card className="border-error-300 bg-error-100">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <CircleSlash className="h-4 w-4" />
              Pedido de compra bloqueado
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-1 text-sm">
              {data.blocking.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fontes</CardTitle>
          <CardDescription>
            Sete dias é o limite: a compra é semanal, então dado de duas semanas atrás já não decide.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fonte</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead>Cobre até</TableHead>
                <TableHead>Atualizado em</TableHead>
                <TableHead>Origem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sources.map((s) => (
                <TableRow key={s.kind}>
                  <TableCell className="font-medium">{KIND_LABEL[s.kind]}</TableCell>
                  <TableCell>
                    {s.missing ? (
                      <Badge variant="destructive" className="gap-1">
                        <CircleSlash className="h-3 w-3" /> Nunca importado
                      </Badge>
                    ) : s.stale ? (
                      <Badge variant="secondary" className="gap-1">
                        <Clock className="h-3 w-3" /> Desatualizado
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 text-success-700">
                        <CheckCircle2 className="h-3 w-3" /> OK
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.missing ? '—' : formatInt(s.row_count)}
                  </TableCell>
                  <TableCell className="tabular-nums">{d(s.covers_until)}</TableCell>
                  <TableCell className="tabular-nums">{dt(s.refreshed_at)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.filename ?? s.provider ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Achados</CardTitle>
          <CardDescription>
            Parâmetros na versão {params.version}, demanda por{' '}
            {params.demand_model === 'weighted_90_180'
              ? '0,7 × 90 dias + 0,3 × 180 dias'
              : 'longo prazo + janela recente'}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {findings.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-success-700">
              <CheckCircle2 className="h-4 w-4" /> Nada a apontar.
            </p>
          ) : (
            findings.map((f) => (
              <div
                key={f.title}
                className={`rounded-md border p-3 ${
                  f.tone === 'warn'
                    ? 'border-warning-300 bg-warning-200'
                    : 'border-border bg-muted/30'
                }`}
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  {f.tone === 'warn' && <AlertTriangle className="h-4 w-4 text-warning-700" />}
                  {f.title}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
