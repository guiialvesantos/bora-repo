/**
 * Definição única de cada termo técnico da interface.
 *
 * Existe porque a mesma coluna aparece em três telas, e escrever a explicação
 * no lugar onde ela é usada garante que um dia as três divirjam. Quando a
 * política mudar, muda aqui e muda em todo lugar.
 *
 * Regra do texto: uma frase dizendo o que o número É e o que se faz com ele —
 * não o que ele se chama. "Ponto de pedido é o ponto em que se pede" não
 * ajuda ninguém. A fórmula vai separada, para quem quiser conferir a conta.
 */

export interface GlossaryEntry {
  term: string
  short: string
  /** Só quando é conta. Campo de dado bruto não tem fórmula. */
  formula?: string
}

export const GLOSSARY = {
  estoque: {
    term: 'Estoque',
    short: 'Peças em mãos, somando só os depósitos marcados como disponíveis para venda.',
  },
  transito: {
    term: 'Em trânsito',
    short: 'Peças já compradas e ainda não recebidas. Contam na decisão — sem elas o motor '
      + 'pediria de novo o que já está a caminho.',
  },
  pp: {
    term: 'PP · Ponto de pedido',
    short: 'Quando estoque + trânsito cai até aqui, é hora de pedir. É o que se vende durante '
      + 'o lead time mais o colchão de segurança.',
    formula: 'ES + demanda semanal × lead time ÷ 7',
  },
  emax: {
    term: 'Emáx · Estoque máximo',
    short: 'O teto do item. A compra repõe até este nível: o ponto de pedido mais o que se '
      + 'vende até a próxima rodada de compra.',
    formula: 'PP + demanda semanal × ciclo de pedido',
  },
  es: {
    term: 'ES · Estoque de segurança',
    short: 'Colchão para a demanda vir acima da média durante o lead time. Cresce com a '
      + 'irregularidade da venda e com o nível de serviço da classe.',
    formula: 'Z × desvio-padrão semanal × √(lead time ÷ 7)',
  },
  demanda: {
    term: 'Demanda semanal',
    short: 'Quantas peças por semana o motor espera vender daqui para frente. É ela que dita '
      + 'ponto de pedido e estoque máximo — não a venda crua do mês passado.',
    formula: 'mistura da venda de todo o histórico com a da janela recente',
  },
  demandaGrade: {
    term: 'Demanda da grade',
    short: 'A soma da demanda de todas as variações do mesmo produto pai. É o número no nível '
      + 'em que se decide comprar: a cor e o tamanho vêm depois.',
    formula: 'soma da demanda semanal das variações (mais a do SKU do pai, se ele vender)',
  },
  sugerido: {
    term: 'Sugerido',
    short: 'Quanto o motor compraria para levar o item ao estoque máximo.',
    formula: 'Emáx − estoque − trânsito',
  },
  pedir: {
    term: 'Pedir',
    short: 'A quantidade que vai no pedido. Editável de propósito: caixa fechada e pedido '
      + 'mínimo o motor não tem como saber. Zerar tira a linha do pedido.',
  },
  cmv: {
    term: 'CMV · Custo unitário',
    short: 'O que a peça custou, não o que ela vende. É a base de tudo que esta tela chama '
      + 'de custo.',
  },
  custoLinha: {
    term: 'Custo da linha',
    short: 'O desembolso desta linha do pedido.',
    formula: 'quantidade a pedir × custo unitário',
  },
  preco: {
    term: 'Preço',
    short: 'Preço de venda por peça.',
  },
  z: {
    term: 'Z · Fator do nível de serviço',
    short: 'Quantos desvios-padrão de folga o item carrega. Z = 1,96 cobre 97,5% das semanas; '
      + 'vem da classe ABC.',
  },
  classe: {
    term: 'Classe ABC',
    short: 'A fatia do faturamento em que o item cai. A classe decide o nível de serviço, e o '
      + 'nível de serviço decide o estoque de segurança.',
  },
  cumPct: {
    term: '% acumulado',
    short: 'Participação acumulada no faturamento anual, do maior para o menor. É o corte que '
      + 'separa A, B e C.',
  },
  fatSemanal: {
    term: 'Faturamento semanal',
    short: 'Previsão, não venda passada crua: é a mesma demanda ponderada que alimenta o ponto '
      + 'de pedido, a preço de venda.',
    formula: 'demanda semanal ponderada × preço de venda',
  },
  fatAnual: {
    term: 'Faturamento anual',
    short: 'O semanal projetado para o ano. Serve para ordenar a curva, não para prever o ano.',
    formula: 'faturamento semanal × 52',
  },
  estoqueMedio: {
    term: 'Estoque médio',
    short: 'O nível em que a política faz o estoque oscilar ao longo do tempo — entre a reserva '
      + 'e o teto. É o capital que a política pede em regime.',
    formula: '(Emáx + ES) ÷ 2',
  },
  lift: {
    term: 'Lift · Afinidade',
    short: 'Quantas vezes mais o segundo produto sai junto do primeiro do que sairia por acaso. '
      + '1× é o acaso. Sem dividir pelo acaso, a lista só redescobriria o mais vendido da loja, '
      + 'que aparece junto de tudo justamente por ser o mais vendido.',
    formula: 'confiança ÷ (pedidos com o sugerido ÷ pedidos totais)',
  },
  foraDeColecao: {
    term: 'Fora de coleção',
    short: 'Item que não será recomprado. Não recebe ponto de pedido nem entra no pedido de '
      + 'compra, mas o estoque dele continua contando no capital parado.',
  },
} as const satisfies Record<string, GlossaryEntry>

export type GlossaryKey = keyof typeof GLOSSARY
