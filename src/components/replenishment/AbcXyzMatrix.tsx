import type { AbcClass } from '@/lib/replenishment-types'
import { XYZ_LABEL } from '@/lib/xyz'
import type { XyzClass } from '@/lib/xyz'

const ABC: AbcClass[] = ['A', 'B', 'C']
const XYZ: XyzClass[] = ['X', 'Y', 'Z']

export interface MatrixCounts {
  counts: Record<AbcClass, Record<XyzClass, number>>
  unclassified: number
}

/**
 * A matriz 3×3 ABC × XYZ. As linhas dizem o que importa (fatia do
 * faturamento); as colunas, o quanto a previsão é confiável. O canto
 * superior-direito (AZ) é onde mora o risco: importante E errático — o modelo
 * erra mais justamente onde o erro custa mais, então é ali que o olho humano
 * deve começar.
 */
export function AbcXyzMatrix({ counts, unclassified, cutX, cutY }: MatrixCounts & {
  cutX: number
  cutY: number
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-1 text-sm">
        <div />
        {XYZ.map((x) => (
          <div key={x} className="px-2 py-1 text-center">
            <span className="font-medium">{x}</span>
            <span className="ml-1 text-xs text-muted-foreground">{XYZ_LABEL[x]}</span>
          </div>
        ))}
        {ABC.map((a) => (
          <MatrixRow key={a} abc={a} row={counts[a]} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        X: CV ≤ {fmt(cutX)} · Y: CV ≤ {fmt(cutY)} · Z: CV &gt; {fmt(cutY)} — cortes calibrados
        nos tercis da própria base, não em limites genéricos.
        {unclassified > 0 && (
          <> {unclassified} {unclassified === 1 ? 'item' : 'itens'} em coleção ainda sem
          classificação (menos de 4 semanas de histórico).</>
        )}
      </p>
    </div>
  )
}

function MatrixRow({ abc, row }: { abc: AbcClass; row: Record<XyzClass, number> }) {
  return (
    <>
      <div className="flex items-center px-2 py-1 font-medium">{abc}</div>
      {XYZ.map((x) => {
        // AZ é o alerta; AY e BZ são a segunda fila de atenção.
        const hot = abc === 'A' && x === 'Z'
        const warm = (abc === 'A' && x === 'Y') || (abc === 'B' && x === 'Z')
        const n = row[x]
        return (
          <div
            key={x}
            className={[
              'rounded border px-2 py-2 text-center tabular-nums',
              n === 0 ? 'text-mono-400' : '',
              hot && n > 0 ? 'border-warning-600 bg-warning-100 font-semibold text-warning-900'
                : warm && n > 0 ? 'border-warning-300 bg-warning-100'
                : 'bg-muted/30',
            ].join(' ')}
            title={`${abc}${x} — ${XYZ_LABEL[x]}`}
          >
            {n}
          </div>
        )
      })}
    </>
  )
}

function fmt(v: number) {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
}
