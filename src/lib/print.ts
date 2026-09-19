/**
 * O nome do arquivo que o navegador sugere no "Salvar como PDF" vem do
 * `document.title`. Trocar antes de imprimir e devolver no `afterprint` é o
 * único jeito de controlá-lo sem biblioteca.
 *
 * Sem acento e sem maiúscula no slug: isto vira NOME DE ARQUIVO no disco de
 * quem baixa, e circula por e-mail e WhatsApp até chegar no fornecedor. "ô"
 * vira %C3%B4 ou pior em anexo de cliente antigo.
 */
export function printDocument(slug: string) {
  const previous = document.title
  document.title = slug
  const restore = () => {
    document.title = previous
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
}
