import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      // Uma família para tudo. `display` e `data` continuam existindo como
      // apelidos para não reescrever os call sites, mas apontam para a mesma
      // Inter — no Infinify a hierarquia vem de tamanho e peso, nunca de
      // trocar de fonte. `mono` é a única exceção e serve SKU e código.
      fontFamily: {
        sans: ['Inter', '"Helvetica Neue"', 'Arial', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Inter', '"Helvetica Neue"', 'Arial', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        data: ['Inter', '"Helvetica Neue"', 'Arial', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // Papéis de texto do Infinify (Large 18/26 · Normal 16/24 · Small 14/20 ·
      // XSmall 12/18 · XXSmall 11/16, todos com tracking 0) e os títulos, que
      // carregam −2%. Os apelidos antigos apontam para os papéis novos.
      fontSize: {
        // Os papéis do Infinify caem quase em cima do padrão do Tailwind
        // (sm 14/20 e base 16/24 são idênticos). Só `lg` e `xs` precisam de
        // ajuste de entrelinha para bater com Large 18/26 e XSmall 12/18.
        lg: ['18px', { lineHeight: '26px' }],
        xs: ['12px', { lineHeight: '18px' }],
        'page-title': ['24px', { lineHeight: '32px', fontWeight: '700', letterSpacing: '-0.02em' }],
        'panel-title': ['18px', { lineHeight: '26px', fontWeight: '600', letterSpacing: '-0.02em' }],
        'card-title': ['14px', { lineHeight: '20px', fontWeight: '600' }],
        body: ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '18px', fontWeight: '400' }],
        label: ['12px', { lineHeight: '16px', fontWeight: '500' }],
        micro: ['11px', { lineHeight: '16px', fontWeight: '500' }],
        // Rótulo de grupo em caixa alta com tracking — o ÚNICO uso de
        // maiúscula no sistema, dentro de navegação e cabeçalho de tabela.
        eyebrow: ['12px', { lineHeight: '16px', fontWeight: '600', letterSpacing: '0.06em' }],
      },
      // Escala de fator 4 do Infinify, com os sub-passos finos que os
      // interiores de controle usam (3px, 5px, 6px, 10px, 14px).
      spacing: {
        0.75: '3px',
        1.25: '5px',
        4.5: '18px',
        13: '52px',
        15: '60px',
        18: '72px',
      },
      // Alturas de controle compartilhadas por Button, Input e Select. `width`
      // espelha `height` porque botão de ícone é quadrado: `h-control-sm
      // w-control-sm` dá o mesmo 32px nos dois eixos sem número solto.
      height: {
        'control-lg': 'var(--size-lg)',
        control: 'var(--size-default)',
        'control-sm': 'var(--size-sm)',
        'control-xs': 'var(--size-xs)',
      },
      width: {
        'control-lg': 'var(--size-lg)',
        control: 'var(--size-default)',
        'control-sm': 'var(--size-sm)',
        'control-xs': 'var(--size-xs)',
      },
      colors: {
        border: {
          DEFAULT: 'hsl(var(--border))',
          strong: 'hsl(var(--border-strong))',
        },
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          subtle: 'hsl(var(--surface-subtle))',
          inset: 'hsl(var(--surface-inset))',
          hover: 'hsl(var(--surface-hover))',
          selected: 'hsl(var(--surface-selected))',
        },
        // O ramp da marca em 11 passos. 600 é a âncora: é ele que preenche
        // botão, item ativo e série primária de gráfico, sempre com texto
        // branco. Hover desce para 700, active para 900, disabled para 300.
        brand: {
          DEFAULT: 'hsl(var(--brand-600))',
          100: 'hsl(var(--brand-100))',
          200: 'hsl(var(--brand-200))',
          300: 'hsl(var(--brand-300))',
          400: 'hsl(var(--brand-400))',
          500: 'hsl(var(--brand-500))',
          600: 'hsl(var(--brand-600))',
          700: 'hsl(var(--brand-700))',
          800: 'hsl(var(--brand-800))',
          900: 'hsl(var(--brand-900))',
          1000: 'hsl(var(--brand-1000))',
          1100: 'hsl(var(--brand-1100))',
          hover: 'hsl(var(--brand-primary-hover))',
          soft: 'hsl(var(--brand-soft))',
          navy: 'hsl(var(--brand-navy))',
        },
        // Mono — ramp frio de 14 passos. É de onde sai quase toda superfície
        // e todo texto; a tela é branco-e-cinza com exatamente um verde.
        mono: {
          100: 'hsl(var(--mono-100))',
          200: 'hsl(var(--mono-200))',
          300: 'hsl(var(--mono-300))',
          400: 'hsl(var(--mono-400))',
          500: 'hsl(var(--mono-500))',
          600: 'hsl(var(--mono-600))',
          700: 'hsl(var(--mono-700))',
          800: 'hsl(var(--mono-800))',
          900: 'hsl(var(--mono-900))',
          1000: 'hsl(var(--mono-1000))',
          1100: 'hsl(var(--mono-1100))',
          1150: 'hsl(var(--mono-1150))',
        },
        // `ink` sobrevive como apelido do topo do ramp da marca: era a cor de
        // título e de link, e continua sendo. Os call sites não mudam.
        ink: {
          DEFAULT: 'hsl(var(--ink-900))',
          700: 'hsl(var(--ink-700))',
          600: 'hsl(var(--ink-600))',
          500: 'hsl(var(--ink-500))',
        },
        // Categóricos do Infinify. A fonte é explícita que eles não carregam
        // significado: existem para série de gráfico e tag, nada mais.
        chart: {
          blue: 'hsl(var(--brand-600))',
          violet: 'hsl(var(--violet-600))',
          orange: 'hsl(var(--orange-600))',
          cyan: 'hsl(var(--cyan-600))',
          teal: 'hsl(var(--teal-600))',
          mint: 'hsl(var(--mint-600))',
        },
        orange: {
          DEFAULT: 'hsl(var(--orange-600))',
          100: 'hsl(var(--orange-100))',
          200: 'hsl(var(--orange-200))',
          300: 'hsl(var(--orange-300))',
          600: 'hsl(var(--orange-600))',
          700: 'hsl(var(--orange-700))',
          800: 'hsl(var(--orange-800))',
          900: 'hsl(var(--orange-900))',
        },
        violet: {
          DEFAULT: 'hsl(var(--violet-600))',
          100: 'hsl(var(--violet-100))',
          200: 'hsl(var(--violet-200))',
          300: 'hsl(var(--violet-300))',
          600: 'hsl(var(--violet-600))',
          700: 'hsl(var(--violet-700))',
          800: 'hsl(var(--violet-800))',
          900: 'hsl(var(--violet-900))',
        },
        // O único categórico com a rampa inteira: badge de estado neutro (que
        // não é sucesso, nem aviso, nem erro) e a série dos gráficos.
        cyan: {
          DEFAULT: 'hsl(var(--cyan-600))',
          100: 'hsl(var(--cyan-100))',
          200: 'hsl(var(--cyan-200))',
          300: 'hsl(var(--cyan-300))',
          400: 'hsl(var(--cyan-400))',
          500: 'hsl(var(--cyan-500))',
          600: 'hsl(var(--cyan-600))',
          700: 'hsl(var(--cyan-700))',
          800: 'hsl(var(--cyan-800))',
          900: 'hsl(var(--cyan-900))',
          1000: 'hsl(var(--cyan-1000))',
          1100: 'hsl(var(--cyan-1100))',
        },
        // Os dois verdes da logo. Só o componente `Logo` consome — verde é
        // assinatura de marca, não vocabulário de interface.
        logo: {
          pine: 'hsl(var(--logo-pine))',
          lime: 'hsl(var(--logo-lime))',
        },
        interactive: 'hsl(var(--interactive))',
        info: {
          DEFAULT: 'hsl(var(--info))',
          soft: 'hsl(var(--info-soft))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          soft: 'hsl(var(--danger-soft))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        // Os três ramps de estado, com os mesmos passos do da marca: 600 é o
        // preenchido, 700 o hover, 900 o pressionado, 300 o desabilitado,
        // 100/200 as lavagens de fundo. Só assim `destructive` no botão segue
        // a mesma escada que `default` em vez de virar um caso à parte.
        error: {
          DEFAULT: 'hsl(var(--error-600))',
          100: 'hsl(var(--error-100))',
          200: 'hsl(var(--error-200))',
          300: 'hsl(var(--error-300))',
          600: 'hsl(var(--error-600))',
          700: 'hsl(var(--error-700))',
          800: 'hsl(var(--error-800))',
          900: 'hsl(var(--error-900))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          soft: 'hsl(var(--success-soft))',
          100: 'hsl(var(--success-100))',
          200: 'hsl(var(--success-200))',
          300: 'hsl(var(--success-300))',
          600: 'hsl(var(--success-600))',
          700: 'hsl(var(--success-700))',
          800: 'hsl(var(--success-800))',
          900: 'hsl(var(--success-900))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          soft: 'hsl(var(--warning-soft))',
          100: 'hsl(var(--warning-100))',
          200: 'hsl(var(--warning-200))',
          300: 'hsl(var(--warning-300))',
          600: 'hsl(var(--warning-600))',
          700: 'hsl(var(--warning-700))',
          800: 'hsl(var(--warning-800))',
          900: 'hsl(var(--warning-900))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
        rail: {
          DEFAULT: 'hsl(var(--rail-background))',
          foreground: 'hsl(var(--rail-foreground))',
          accent: 'hsl(var(--rail-accent))',
          'accent-foreground': 'hsl(var(--rail-accent-foreground))',
          border: 'hsl(var(--rail-border))',
        },
      },
      // A escala do Infinify atribui propósito a cada passo: 0 para barra de
      // navegação e de abas, 4–8 para botão pequeno e campo, 10–12 para
      // popover, 14–24 para card. Pílula (`full`) é para controle.
      borderRadius: {
        none: 'var(--radius-0)',
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        nav: 'var(--radius-nav)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        xxl: 'var(--shadow-xxl)',
        soft: 'var(--shadow-sm)',
        // Card é fio de 1px MAIS a `sm` — é literalmente o que o kit de
        // dashboard do Infinify faz em `.panel` e `.rail`. A sombra é rasa
        // (3px de raio, 6% de preto) e serve só para descolar o branco do
        // fundo cinza; a elevação de verdade continua sendo md/lg/xl.
        card: 'var(--shadow-sm)',
        'card-hover': 'var(--shadow-md)',
        button: 'var(--shadow-button)',
        focus: 'var(--shadow-button-focus)',
        'input-active': 'var(--shadow-input-active)',
        modal: 'var(--shadow-modal)',
        dropdown: 'var(--shadow-dropdown)',
      },
      transitionDuration: {
        fast: '120ms',
        normal: '180ms',
        slow: '280ms',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // Uma lâmina da marca entrando. O ciclo tem folga no fim (de 70% a
        // 100% a peça já está no lugar) porque as três compartilham a mesma
        // volta e a última só começa 300ms depois da primeira: sem a folga,
        // a primeira já estaria saindo quando a terceira entrasse, e o
        // desenho nunca apareceria inteiro.
        slab: {
          '0%, 100%': { opacity: '0', transform: 'translate(-110px, 90px)' },
          '18%, 70%': { opacity: '1', transform: 'translate(0, 0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.16s ease-out',
        'accordion-up': 'accordion-up 0.16s ease-out',
        slab: 'slab 1.6s var(--ease-standard) infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
