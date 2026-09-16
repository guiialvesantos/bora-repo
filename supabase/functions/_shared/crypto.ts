// AES-GCM para segredo em repouso (o token do Tiny). Mesmo padrão do
// `client-access` do cockpit-operacao: chave derivada de uma env var (base64
// de 32 bytes, ou qualquer string >= 32 chars), IV de 12 bytes por gravação.

export async function deriveKey(raw: string): Promise<CryptoKey> {
  let keyBytes: Uint8Array
  try {
    const bin = atob(raw)
    keyBytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    keyBytes = new TextEncoder().encode(raw)
  }
  if (keyBytes.length < 32) {
    throw new Error('TINY_ENCRYPTION_KEY must be at least 32 bytes')
  }
  const slice = keyBytes.slice(0, 32)
  return crypto.subtle.importKey('raw', slice, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function b64(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(value: string) {
  const bin = atob(value)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export async function encryptSecret(key: CryptoKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return { ciphertext: b64(cipher), iv: b64(iv), key_version: 1 }
}

export async function decryptSecret(key: CryptoKey, ciphertext: string, iv: string) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ciphertext))
  return new TextDecoder().decode(plain)
}
