import { cn } from '@/lib/utils'

/**
 * A marca, em três peças.
 *
 * Os desenhos vêm dos SVGs entregues pela criação e estão aqui INLINE, não como
 * `<img src="/logo.svg">`. Três motivos, nesta ordem:
 *
 * 1. `fill="currentColor"`. O arquivo original crava `#052DF5`, e cravado ele
 *    não serve à barra fechada nem ao rodapé escuro — seria preciso um arquivo
 *    por cor. Herdando a cor do texto, a mesma marca vira azul, branca ou preta
 *    só mudando a classe de quem a contém.
 * 2. A tela de carregamento não pode depender de rede. Um `<img>` é uma segunda
 *    requisição, e a única hora em que o carregador aparece é justamente quando
 *    ainda não se sabe se a rede responde.
 * 3. As lâminas precisam ser animáveis uma a uma. Dentro de um `<img>` elas são
 *    um pixel só.
 */

/** Só as três lâminas. Proporção 758×428 — larga, não quadrada. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 758 428" fill="currentColor" aria-hidden className={className}>
      <path d="M0 206.707L252.709 0V206.707L0 427.092V206.707Z" />
      <path d="M251.963 206.707L504.672 0V206.707L251.963 427.092V206.707Z" />
      <path d="M504.672 206.707L757.381 0V206.707L504.672 427.092V206.707Z" />
    </svg>
  )
}

/**
 * O lockup inteiro: lâminas + "borarepô".
 *
 * A `viewBox` é o retângulo APERTADO em volta do desenho (x 428,8→1453,7 /
 * y 436→650,9 do arquivo de 1920×1080). O arquivo original é uma prancha com o
 * logo no meio de muito branco; usado como veio, ele apareceria minúsculo no
 * centro de uma caixa cinco vezes maior que ele.
 */
export function LogoWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="428.8 436 1024.9 214.9"
      fill="currentColor"
      role="img"
      aria-label="BoraRepô"
      className={className}
    >
      <path d="M428.826 540L555.959 436.01V540L428.826 650.871V540Z" />
      <path d="M555.584 540L682.717 436.01V540L555.584 650.871V540Z" />
      <path d="M682.717 540L809.85 436.01V540L682.717 650.871V540Z" />
      <path d="M905.001 517.244C915.743 517.244 924.305 520.943 930.689 528.34C936.972 535.839 940.113 545.82 940.113 558.284C940.113 570.647 936.972 580.577 930.689 588.076C924.305 595.575 915.743 599.324 905.001 599.324C893.956 599.324 885.596 594.967 879.921 586.252V597.5H861.529V502.04L880.681 489.276V529.252C886.255 521.247 894.361 517.244 905.001 517.244ZM885.697 576.98C889.143 581.337 894.057 583.516 900.441 583.516C906.724 583.516 911.689 581.236 915.337 576.676C918.884 572.217 920.657 565.884 920.657 557.676C920.657 549.671 918.884 543.591 915.337 539.436C911.892 535.18 906.927 533.052 900.441 533.052C894.057 533.052 889.092 535.231 885.545 539.588C881.999 543.945 880.225 550.177 880.225 558.284C880.225 566.492 882.049 572.724 885.697 576.98Z" />
      <path d="M1025.34 558.284C1025.34 570.647 1021.69 580.577 1014.4 588.076C1007.1 595.575 997.474 599.324 985.516 599.324C973.559 599.324 963.932 595.575 956.636 588.076C949.239 580.679 945.54 570.748 945.54 558.284C945.54 545.82 949.239 535.889 956.636 528.492C963.932 520.993 973.559 517.244 985.516 517.244C997.474 517.244 1007.1 520.943 1014.4 528.34C1021.69 535.737 1025.34 545.719 1025.34 558.284ZM970.468 576.98C974.116 581.337 979.132 583.516 985.516 583.516C991.9 583.516 996.866 581.337 1000.41 576.98C1004.06 572.521 1005.88 566.289 1005.88 558.284C1005.88 550.279 1004.06 544.097 1000.41 539.74C996.866 535.281 991.9 533.052 985.516 533.052C979.132 533.052 974.116 535.231 970.468 539.588C966.922 543.945 965.148 550.177 965.148 558.284C965.148 566.391 966.922 572.623 970.468 576.98Z" />
      <path d="M1076.27 517.852C1077.99 517.852 1079.56 517.953 1080.98 518.156V535.788H1076.12C1068.82 535.788 1063.2 537.663 1059.24 541.412C1055.39 545.06 1053.47 550.481 1053.47 557.676V597.5H1034.32V519.068H1052.86V533.052C1057.22 522.919 1065.02 517.852 1076.27 517.852Z" />
      <path d="M1161.12 597.5H1135.05C1134.14 595.879 1133.43 592.687 1132.92 587.924C1127.65 595.524 1119.24 599.324 1107.69 599.324C1099.08 599.324 1092.19 597.247 1087.02 593.092C1081.95 588.937 1079.42 583.161 1079.42 575.764C1079.42 561.476 1089.45 553.319 1109.51 551.292L1121.37 550.228C1125.32 549.721 1128.16 548.809 1129.88 547.492C1131.61 546.073 1132.47 543.996 1132.47 541.26C1132.47 537.916 1131.35 535.484 1129.12 533.964C1126.99 532.343 1123.35 531.532 1118.18 531.532C1112.61 531.532 1108.6 532.495 1106.17 534.42C1103.74 536.244 1102.32 539.436 1101.91 543.996H1083.07C1084.18 526.161 1095.94 517.244 1118.33 517.244C1140.12 517.244 1151.01 525.097 1151.01 540.804V582.604C1151.01 589.495 1159 594.46 1161.12 597.5ZM1112.25 585.644C1118.23 585.644 1123.09 584.023 1126.84 580.78C1130.59 577.436 1132.47 572.673 1132.47 566.492V559.348C1130.64 560.969 1127.65 562.033 1123.5 562.54L1113.16 563.756C1108.1 564.364 1104.45 565.58 1102.22 567.404C1100.09 569.127 1099.03 571.66 1099.03 575.004C1099.03 578.348 1100.14 580.983 1102.37 582.908C1104.7 584.732 1107.99 585.644 1112.25 585.644Z" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1160.98 590.508H1160.83V519.068H1179.37V535.788C1183.73 525.655 1191.53 517.852 1202.78 517.852C1204.5 517.852 1212.15 517.953 1213.57 518.156V526.972V534.808C1213.38 535.132 1213.19 535.458 1213.01 535.788H1202.63C1195.33 535.788 1189.71 537.663 1185.76 541.412C1181.91 545.06 1179.98 550.481 1179.98 557.676V597.5H1160.98V590.508Z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1285.25 559.652V564.212H1226.58C1227.29 570.9 1229.37 575.967 1232.81 579.412C1236.36 582.756 1241.07 584.428 1246.95 584.428C1255.66 584.428 1261.64 580.679 1264.88 573.18H1283.28C1281.25 581.185 1276.99 587.569 1270.51 592.332C1264.02 596.993 1256.12 599.324 1246.8 599.324C1235.14 599.324 1225.72 595.575 1218.52 588.076C1211.33 580.577 1207.73 570.647 1207.73 558.284C1207.73 549.58 1209.49 542.081 1213.01 535.788H1213.57V534.808C1214.93 532.54 1216.53 530.434 1218.37 528.492C1225.57 520.993 1234.94 517.244 1246.49 517.244C1258.35 517.244 1267.77 521.145 1274.76 528.948C1281.76 536.751 1285.25 546.985 1285.25 559.652ZM1246.34 532.14C1235.09 532.14 1228.56 538.372 1226.73 550.836H1266.1C1265.29 545.06 1263.16 540.5 1259.72 537.156C1256.27 533.812 1251.81 532.14 1246.34 532.14Z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1359.98 528.34C1353.6 520.943 1345.04 517.244 1334.29 517.244C1323.25 517.244 1314.89 521.601 1309.21 530.316V519.068H1290.82V627.292L1309.97 615.909V587.316C1315.55 595.321 1323.65 599.324 1334.29 599.324C1345.04 599.324 1353.6 595.575 1359.98 588.076C1366.27 580.577 1369.41 570.647 1369.41 558.284C1369.41 545.82 1366.27 535.839 1359.98 528.34ZM1314.99 576.98C1318.44 581.337 1323.35 583.516 1329.73 583.516C1336.02 583.516 1340.98 581.236 1344.63 576.676C1348.18 572.217 1349.95 565.884 1349.95 557.676C1349.95 549.671 1348.18 543.591 1344.63 539.436C1341.19 535.18 1336.22 533.052 1329.73 533.052C1323.35 533.052 1318.39 535.231 1314.84 539.588C1311.29 543.945 1309.52 550.177 1309.52 558.284C1309.52 566.492 1311.34 572.724 1314.99 576.98Z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1413.89 517.28C1401.93 517.28 1392.31 521.029 1385.01 528.528C1377.62 535.925 1373.92 545.856 1373.92 558.32C1373.92 570.784 1377.61 580.714 1385.01 588.112C1392.31 595.61 1401.94 599.36 1413.89 599.36C1425.85 599.36 1435.48 595.61 1442.77 588.112C1450.07 580.613 1453.72 570.682 1453.72 558.32C1453.72 545.754 1450.07 535.773 1442.77 528.376C1435.48 520.978 1425.85 517.28 1413.89 517.28ZM1398.84 577.016C1402.49 581.373 1407.51 583.552 1413.89 583.552C1420.28 583.552 1425.24 581.373 1428.79 577.016C1432.44 572.557 1434.26 566.325 1434.26 558.32C1434.26 550.314 1432.44 544.133 1428.79 539.776C1425.24 535.317 1420.28 533.088 1413.89 533.088C1407.51 533.088 1402.49 535.266 1398.84 539.624C1395.3 543.981 1393.52 550.213 1393.52 558.32C1393.52 566.426 1395.3 572.658 1398.84 577.016Z"
      />
      <path d="M1413.96 496.876L1425.67 508.884H1443.15L1425.36 486.996H1402.41L1384.78 508.884H1402.26L1413.96 496.876Z" />
    </svg>
  )
}

/**
 * O carregador: a mesma marca, montando-se lâmina a lâmina.
 *
 * É o motion entregue pela criação, refeito em CSS em vez de embutido como GIF
 * ou MP4. A troca não é preciosismo:
 *
 * - o GIF tem fundo CHAPADO (um branco, um azul) e a tela de carregamento não é
 *   nem uma coisa nem outra; recortá-lo deixaria uma ilha de cor no meio dela;
 * - GIF não tem meio-tom — a diagonal das lâminas sairia serrilhada em qualquer
 *   tamanho que não fosse o original de 1200px;
 * - são 83 kB de rede pedidos no exato instante em que ainda não se sabe se a
 *   rede responde. Aqui não há requisição nenhuma.
 *
 * O deslocamento inicial é `-110 90` em unidades de usuário, e não em píxel:
 * dentro de um SVG o `transform` do CSS trabalha na malha da `viewBox`, então a
 * entrada mantém a mesma proporção com 24px ou com 200px. A direção acompanha a
 * inclinação da lâmina (sobe para a direita), então cada peça entra deslizando
 * SOBRE o próprio eixo em vez de atravessar o desenho.
 */
export function LogoLoader({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 758 428"
      fill="currentColor"
      role="status"
      aria-label="Carregando"
      className={cn('overflow-visible', className)}
    >
      <path
        className="animate-slab"
        d="M0 206.707L252.709 0V206.707L0 427.092V206.707Z"
      />
      <path
        className="animate-slab [animation-delay:150ms]"
        d="M251.963 206.707L504.672 0V206.707L251.963 427.092V206.707Z"
      />
      <path
        className="animate-slab [animation-delay:300ms]"
        d="M504.672 206.707L757.381 0V206.707L504.672 427.092V206.707Z"
      />
    </svg>
  )
}

/**
 * O lugar onde a espera acontece, centralizado e com altura própria.
 *
 * Substitui o "Carregando…" escrito que estava espalhado pelas telas. Texto de
 * espera tem dois defeitos concretos aqui: ocupa uma linha só, então a área que
 * vai receber uma tabela de seiscentas linhas colapsa e a página inteira pula
 * quando o dado chega; e some rápido demais para ser lido, de modo que a
 * palavra nunca chega a informar nada.
 *
 * `min-height` em vez de altura fixa porque quem chama já tem noção do buraco
 * que vai preencher — a tabela pede mais, um cartão pede menos.
 */
export function LoadingBlock({
  className,
  size = 'md',
}: {
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div
      className={cn(
        'flex w-full items-center justify-center',
        size === 'sm' ? 'min-h-[80px]' : 'min-h-[180px]',
        className,
      )}
    >
      <LogoLoader
        className={cn('text-brand-600', size === 'sm' ? 'w-[40px]' : 'w-[56px]')}
      />
    </div>
  )
}
