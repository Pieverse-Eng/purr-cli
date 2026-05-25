/**
 * `purr treasure-code` — first-class commands for the Pieverse Treasure Code
 * paid guessing game on X Layer.
 *
 * Each subcommand owns the entire OKX-x402 helper-pattern flow
 * (payment-required → sign → submit → poll) in a single process, so an agent
 * issues ONE command instead of hand-rolling curl + jq + sign-okx-x402 +
 * a poll loop across several stateless shell calls. That hand-rolling was the
 * dominant source of wasted tokens, lost shell variables, guessed field names,
 * and burned payments observed across agent runtimes — see the skill A/B in
 * purrfect-claw-platform PR #751.
 */
import { readFileSync } from 'node:fs'
import { apiGet, apiPost } from '@pieverseio/purr-core/api-client'
import { signOkxX402FromExpected } from './sign-okx-x402.js'

interface Expected {
  amountBaseUnits: string
  chainId: number
  tokenAddress: string
  payTo: string
}

interface Envelope<T> {
  ok: boolean
  data: T
  error?: string
}

interface PaymentRequiredData {
  expected: Expected
  wordRequested?: string | null
}

interface SubmitData {
  attempt_id: string
  status: string
}

interface AttemptData {
  attempt_id?: string
  status: string
  position?: number | string | null
  word?: string | null
  result?: string | null
  settle_failed_reason?: string | null
}

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function pollUntilSettled(attemptId: string): Promise<AttemptData> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)
    const res = await apiGet<Envelope<AttemptData>>(`/v1/treasure-code/attempts/${attemptId}`)
    const status = res.data?.status
    if (status === 'ready' || status === 'settle_failed') return res.data
  }
  throw new Error(
    `Timed out after ${(POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS) / 1000}s polling attempt ${attemptId}`,
  )
}

/** `purr treasure-code vault` — current Code + claim-window status (free, no payment). */
export async function treasureCodeVault(): Promise<void> {
  const res = await apiGet<Envelope<unknown>>('/v1/treasure-code/vault')
  console.log(JSON.stringify(res.data))
}

/**
 * `purr treasure-code attempt [--guess <word>]` — one paid attempt, end to end.
 * Omit --guess to let the server pick both word and position (recommended).
 */
export async function treasureCodeAttempt(args: Record<string, string>): Promise<void> {
  const word = args.guess
  const requestBody = word ? { word } : {}

  const pr = await apiPost<Envelope<PaymentRequiredData>>(
    '/v1/treasure-code/attempts/payment-required',
    requestBody,
  )
  const expected = pr.data?.expected
  if (!expected) throw new Error('payment-required returned no `expected` envelope')

  // Sign the envelope verbatim — the helper owns the x402 plumbing.
  const signed = await signOkxX402FromExpected(JSON.stringify(expected))

  const submitBody: Record<string, unknown> = {
    paymentSignature: signed.paymentSignature,
    expected,
    idempotency_key: signed.authorizationNonce,
  }
  if (word) submitBody.word = word

  const sub = await apiPost<Envelope<SubmitData>>('/v1/treasure-code/attempts', submitBody)
  const attemptId = sub.data?.attempt_id
  if (!attemptId) throw new Error('submit returned no attempt_id')

  const final = await pollUntilSettled(attemptId)
  console.log(
    JSON.stringify({
      attempt_id: attemptId,
      status: final.status,
      position: final.position ?? null,
      word: final.word ?? null,
      result: final.result ?? null,
      settle_failed_reason: final.settle_failed_reason ?? null,
      cost_base_units: expected.amountBaseUnits,
    }),
  )
}

/**
 * `purr treasure-code final-unlock (--words '[...]' | --words-file <path>)` —
 * paid submit of all 24 position-ordered words to open/join the claim window.
 * Costs even if rejected — callers should confirm before invoking.
 */
export async function treasureCodeFinalUnlock(args: Record<string, string>): Promise<void> {
  const wordsRaw =
    args.words ?? (args['words-file'] ? readFileSync(args['words-file'], 'utf-8') : undefined)
  if (!wordsRaw) {
    throw new Error("Provide --words '[...24 words...]' or --words-file <path>")
  }
  let words: unknown
  try {
    words = JSON.parse(wordsRaw)
  } catch {
    throw new Error('--words / --words-file must be a JSON array of 24 position-ordered words')
  }
  if (!Array.isArray(words) || words.length !== 24) {
    throw new Error(
      `words must be a 24-element array (got ${Array.isArray(words) ? `${words.length}` : typeof words})`,
    )
  }

  const pr = await apiPost<Envelope<PaymentRequiredData>>(
    '/v1/treasure-code/final-unlocks/payment-required',
    { words },
  )
  const expected = pr.data?.expected
  if (!expected) throw new Error('final-unlocks/payment-required returned no `expected` envelope')

  const signed = await signOkxX402FromExpected(JSON.stringify(expected))
  const res = await apiPost<Envelope<unknown>>('/v1/treasure-code/final-unlocks', {
    paymentSignature: signed.paymentSignature,
    expected,
    idempotency_key: signed.authorizationNonce,
    words,
  })
  console.log(JSON.stringify(res.data))
}
