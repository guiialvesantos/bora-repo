import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Package } from 'lucide-react'

const PREVIEW = 224 // lado do preview expandido (px)

/**
 * Miniatura do produto nas listas (Produtos, Pedido de compra, Curva ABC).
 * Sem foto — ou com foto quebrada, que o Tiny devolve URL morta às vezes —
 * cai no ícone neutro, sem buraco no layout.
 *
 * No hover, a foto expande num preview flutuante. Portal + position:fixed
 * porque a célula vive dentro de tabela com overflow — um absolute ali seria
 * cortado pela borda do Card.
 */
export function ProductThumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  const [broken, setBroken] = useState(false)
  const [preview, setPreview] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLImageElement>(null)

  if (!src || broken) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
        <Package className="h-4 w-4 text-muted-foreground" />
      </div>
    )
  }

  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const margin = 8
    let left = r.right + margin
    if (left + PREVIEW > window.innerWidth - margin) left = r.left - margin - PREVIEW
    let top = r.top + r.height / 2 - PREVIEW / 2
    top = Math.max(margin, Math.min(top, window.innerHeight - PREVIEW - margin))
    setPreview({ top, left })
  }

  return (
    <>
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setBroken(true)}
        onMouseEnter={show}
        onMouseLeave={() => setPreview(null)}
        className="h-9 w-9 shrink-0 cursor-zoom-in rounded-lg border border-border bg-white object-cover"
      />
      {preview && createPortal(
        <div
          className="pointer-events-none fixed z-50 overflow-hidden rounded-xl border border-border bg-white shadow-xl"
          style={{ top: preview.top, left: preview.left, width: PREVIEW, height: PREVIEW }}
        >
          <img src={src} alt={alt} className="h-full w-full object-contain" />
        </div>,
        document.body,
      )}
    </>
  )
}

/** Miniatura + nome — a âncora visual de toda linha de produto. */
export function ProductCell({ image, name }: { image: string | null | undefined; name: string | null }) {
  return (
    // `min-w-0` no próprio contêiner: sem ele um item flex não encolhe abaixo
    // do conteúdo, o `truncate` do nome nunca dispara e o nome longo invade a
    // coluna vizinha em vez de cortar.
    <div className="flex min-w-0 items-center gap-3">
      <ProductThumb src={image} alt={name ?? 'Produto'} />
      <span className="min-w-0 truncate font-medium">{name ?? '—'}</span>
    </div>
  )
}
