// Bucket de token adaptativo por conexão. O limite de requisições da v2 não é
// documentado, então o número certo só se aprende em produção: 429 derruba
// `refill_per_sec` pela metade, 200 chamadas limpas seguidas sobem 10%. O
// estado vive em `integration_rate_limits` porque o sync é retomável — o
// aprendizado de uma invocação tem que sobreviver para a próxima.

// deno-lint-ignore no-explicit-any
type Admin = any

export interface RateLimitState {
  capacity: number
  tokens: number
  refillPerSec: number
  cleanStreak: number
}

const CLEAN_STREAK_TO_GROW = 200
const MIN_REFILL_PER_SEC = 0.2

export async function loadRateLimit(admin: Admin, connectionId: string): Promise<RateLimitState> {
  const { data } = await admin
    .from('integration_rate_limits')
    .select('capacity, tokens, refill_per_sec, clean_streak')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (data) {
    return {
      capacity: Number(data.capacity),
      tokens: Number(data.tokens),
      refillPerSec: Number(data.refill_per_sec),
      cleanStreak: Number(data.clean_streak),
    }
  }

  const defaults: RateLimitState = { capacity: 30, tokens: 30, refillPerSec: 2, cleanStreak: 0 }
  await admin.from('integration_rate_limits').insert({
    connection_id: connectionId,
    capacity: defaults.capacity,
    tokens: defaults.tokens,
    refill_per_sec: defaults.refillPerSec,
    clean_streak: defaults.cleanStreak,
  })
  return defaults
}

export async function saveRateLimit(admin: Admin, connectionId: string, state: RateLimitState) {
  await admin
    .from('integration_rate_limits')
    .update({
      capacity: state.capacity,
      tokens: state.tokens,
      refill_per_sec: state.refillPerSec,
      clean_streak: state.cleanStreak,
      updated_at: new Date().toISOString(),
    })
    .eq('connection_id', connectionId)
}

export class TokenBucket {
  private state: RateLimitState
  private lastRefillAt = Date.now()

  constructor(state: RateLimitState) {
    this.state = state
  }

  get snapshot(): RateLimitState {
    return { ...this.state }
  }

  private refill() {
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillAt) / 1000
    this.lastRefillAt = now
    this.state.tokens = Math.min(this.state.capacity, this.state.tokens + elapsedSec * this.state.refillPerSec)
  }

  /** Bloqueia até haver 1 token, consome e devolve. */
  async take(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.state.tokens >= 1) {
        this.state.tokens -= 1
        return
      }
      const waitMs = Math.max(50, ((1 - this.state.tokens) / this.state.refillPerSec) * 1000)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }

  onSuccess() {
    this.state.cleanStreak += 1
    if (this.state.cleanStreak >= CLEAN_STREAK_TO_GROW) {
      this.state.refillPerSec *= 1.1
      this.state.cleanStreak = 0
    }
  }

  onRateLimited() {
    this.state.refillPerSec = Math.max(MIN_REFILL_PER_SEC, this.state.refillPerSec / 2)
    this.state.cleanStreak = 0
  }

  /**
   * Ajusta ao limite real do plano, lido do header `x-limit-api` do Tiny —
   * substitui o chute inicial (e qualquer sobra de uma calibração anterior a
   * uma troca de plano) assim que a primeira resposta chega. 90% de margem:
   * o cron e a UI ("Testar token") podem gastar chamada do mesmo minuto.
   */
  calibrateToPlanLimit(limitPerMinute: number) {
    const target = Math.max(MIN_REFILL_PER_SEC, (limitPerMinute * 0.9) / 60)
    if (Math.abs(this.state.refillPerSec - target) < 0.01) return
    this.state.refillPerSec = target
    this.state.capacity = Math.max(1, Math.floor(limitPerMinute * 0.9))
    this.state.tokens = Math.min(this.state.tokens, this.state.capacity)
  }
}
