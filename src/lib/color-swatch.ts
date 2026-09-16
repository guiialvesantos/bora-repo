/**
 * Traduz o nome da cor do catálogo em uma amostra de tinta.
 *
 * Existe porque o relatório de cores sem bolinha é uma lista de palavras: "AZUL
 * MARINHO 213" e "AZUL 70" ficam a um caractere de distância, e quem varre a
 * lista com o olho troca as duas. A bolinha é o que torna a lista lida em vez
 * de decifrada.
 *
 * Não é um dicionário fechado, é uma resolução em três passos, porque catálogo
 * de moda escreve cor como frase: "AZUL MARINHO", "CASTANHO CLARO", "VERDE
 * PETRÓLEO". Casar só nome inteiro deixaria fora quase tudo.
 *
 *   1. acha o nome de cor MAIS LONGO contido na frase — as chaves são varridas
 *      da mais longa para a mais curta, senão "AZUL MARINHO" resolveria como
 *      "AZUL" e marinho e celeste sairiam com a mesma bolinha;
 *   2. aplica o modificador ("CLARO" clareia, "ESCURO"/"ACINZENTADO" escurece);
 *   3. desiste. Cor desconhecida devolve `null` — e desconhecida é a resposta
 *      certa para "ESTAMPADO" ou para um nome de modelo que vazou da extração.
 *      Chutar um cinza qualquer transformaria "não sei" em "é cinza", que é
 *      pior: alguém leria uma bolinha e acreditaria nela.
 */

const BASE: Record<string, string> = {
  // neutros
  'PRETO': '#111827',
  'BRANCO': '#FFFFFF',
  'OFF WHITE': '#F3F0E9',
  'CREME': '#F0E9D8',
  'CRU': '#EDE5D4',
  'BEGE': '#D9C7A7',
  'NUDE': '#DCB89E',
  'AREIA': '#D7C4A3',
  'CINZA': '#9CA3AF',
  'MESCLA': '#B6BAC1',
  'GRAFITE': '#4B5563',
  'CHUMBO': '#3F4854',
  'PRATA': '#C0C4CC',
  'DOURADO': '#C9A227',

  // azuis
  'AZUL': '#2563EB',
  'AZUL MARINHO': '#1E2A5A',
  'MARINHO': '#1E2A5A',
  'AZUL JEANS': '#4A6FA5',
  'JEANS': '#4A6FA5',
  'AZUL CLARO': '#7EB3E8',
  'CELESTE': '#86C5E8',
  'TURQUESA': '#1BA8A0',
  'PETROLEO': '#0F5C63',
  'VERDE PETROLEO': '#0F5C63',

  // verdes
  'VERDE': '#16A34A',
  'VERDE MUSGO': '#5A6B3B',
  'MUSGO': '#5A6B3B',
  'OLIVA': '#6B7A3A',
  'MILITAR': '#4C5A34',
  'VERDE MILITAR': '#4C5A34',
  'LIMA': '#A8C93A',
  'MENTA': '#9BD8BE',

  // quentes
  'AMARELO': '#EAB308',
  'MANTEIGA': '#F2DFA0',
  'AMARELO MANTEIGA': '#F2DFA0',
  'MOSTARDA': '#C8A02A',
  'LARANJA': '#EA580C',
  'TERRACOTA': '#B85C38',
  'CORAL': '#F07167',
  'FERRUGEM': '#9C4A24',

  // vermelhos e rosas
  'VERMELHO': '#DC2626',
  'VINHO': '#6E1B2E',
  'BORDO': '#5E1526',
  'BORDÔ': '#5E1526',
  'ROSA': '#EC6FA0',
  'ROSA CLARO': '#F7B9CE',
  'ROSA ESCURO': '#C2407A',
  'PINK': '#DB2777',
  'SALMAO': '#F3A183',

  // roxos
  'LILAS': '#C4A9E8',
  'LAVANDA': '#BCA9DE',
  'ROXO': '#7C3AED',
  'MORADO': '#7C3AED',
  'VIOLETA': '#8B5CF6',
  'UVA': '#5B2A83',

  // marrons
  'MARROM': '#6B4423',
  'CASTANHO': '#7A5334',
  'CAFE': '#4A3226',
  'CARAMELO': '#B4793A',
  'CHOCOLATE': '#4E3226',
  'TABACO': '#8A5A2B',
}

/** Chaves da mais longa para a mais curta — a ordem É o algoritmo do passo 1. */
const KEYS = Object.keys(BASE).sort((a, b) => b.length - a.length)

/** Tira acento e pontuação para casar "PETRÓLEO" com a chave "PETROLEO". */
function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mistura com branco (`t > 0`) ou com preto (`t < 0`). */
function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => {
    const v = t > 0 ? c + (255 - c) * t : c * (1 + t)
    return Math.max(0, Math.min(255, Math.round(v)))
  }
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`
}

export function colorSwatch(name: string): string | null {
  const s = normalize(name)
  if (!s) return null

  const key = KEYS.find((k) => s.includes(normalize(k)))
  if (!key) return null

  const hex = BASE[key]
  // O modificador só vale se não fizer parte da própria chave — senão "ROSA
  // ESCURO", que já tem tom próprio, seria escurecido uma segunda vez.
  const rest = s.replace(normalize(key), ' ')
  if (/\bCLARO|\bCLARA/.test(rest)) return shade(hex, 0.38)
  if (/\bESCURO|\bESCURA|\bACINZENTAD/.test(rest)) return shade(hex, -0.3)
  return hex
}

/**
 * Se a tinta some no fundo branco do cartão.
 *
 * Branco, creme e manteiga desenhariam uma barra invisível — a linha ficaria
 * parecendo vazia, como se aquela cor não tivesse vendido nada. Quem pergunta
 * isso ganha um contorno.
 */
export function isPale(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16)
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return lum > 218
}

/** Título em caixa de frase: "AZUL MARINHO" grita numa lista de oito linhas. */
export function colorLabel(name: string): string {
  return name
    .toLocaleLowerCase('pt-BR')
    .replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toLocaleUpperCase('pt-BR'))
}
