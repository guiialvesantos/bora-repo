// A camada XYZ: previsibilidade da demanda, calculada NA LEITURA.
//
// ABC diz o que importa (fatia do faturamento); XYZ diz o quanto dá para
// confiar na previsão. O motor (`replenishment_calc`) não sabe que XYZ existe —
// a classe é derivada aqui, dos campos do snapshot (σ e demanda ponderada) com
// os cortes dos parâmetros versionados. Núcleo congelado: XYZ é lente, não
// alavanca.
//
// Eixo principal: CV = σ / demanda semanal ponderada. Os cortes (1,0 / 1,6 na
// Triana) foram calibrados nos tercis da própria base — os "0,5 / 1,0" da
// literatura jogariam quase toda semijoia em Z e a classe não separaria nada.
//
// O erro histórico do forecast (`forecast_accuracy`) REFINA a leitura, nunca
// decide a classe: um slow mover que vende 1/semana tem wMAPE enorme por
// construção. Por isso o formato honesto é
//   "AZ · erro histórico típico ±38% · 6 origens"
// e nunca "confiança: 89%".
//
// Item com menos de 4 semanas de histórico NÃO vira Z: vira "previsibilidade
// ainda não classificada". Chamar lançamento de errático seria certeza falsa.

import { maybeNum, num } from './replenishment-types'
import type { ForecastAccuracy, SnapshotItem } from './replenishment-types'

export type XyzClass = 'X' | 'Y' | 'Z'

export type Xyz =
  | { cls: XyzClass; cv: number }
  | { cls: 'nc'; reason: string } // em coleção, mas ainda não classificável
  | null                          // fora de coleção — previsibilidade não se aplica

export const XYZ_LABEL: Record<XyzClass, string> = {
  X: 'previsível',
  Y: 'intermediário',
  Z: 'errático',
}

export function classifyXyz(item: SnapshotItem, cutX: number, cutY: number): Xyz {
  if (!item.in_collection) return null
  if (item.low_confidence) return { cls: 'nc', reason: 'Menos de 4 semanas de histórico' }
  const blended = num(item.weekly_blended)
  if (blended <= 0) return { cls: 'nc', reason: 'Sem demanda registrada' }
  const cv = num(item.sigma) / blended
  if (cv <= cutX) return { cls: 'X', cv }
  if (cv <= cutY) return { cls: 'Y', cv }
  return { cls: 'Z', cv }
}

/** `erro histórico típico ±38% · 6 origens`, ou o motivo de não haver número. */
export function accuracyLine(acc: ForecastAccuracy | undefined): string {
  if (!acc) return 'sem histórico de backtest ainda'
  const wmape = maybeNum(acc.wmape)
  if (wmape == null) return `sem erro medido (realizado zerou) · ${acc.origins_n} origens`
  return `erro histórico típico ±${Math.round(wmape * 100)}% · ${acc.origins_n} origens`
}
