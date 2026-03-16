import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const BASE_URL = 'https://four.meme/meme-api'

export const FOUR_MEME_SUPPORTED_LABELS = [
	'Meme',
	'AI',
	'Defi',
	'Games',
	'Infra',
	'De-Sci',
	'Social',
	'Depin',
	'Charity',
	'Others',
] as const

export interface FourMemeRaisedTokenConfig {
	symbol: string
	nativeSymbol: string
	symbolAddress: string
	deployCost: string
	buyFee: string
	sellFee: string
	minTradeFee: string
	b0Amount: string
	totalBAmount: string
	totalAmount: string
	logoUrl: string
	tradeLevel: string[]
	status: string
	buyTokenLink: string
	reservedNumber: number
	saleRate: string
	networkCode: string
	platform: string
}

export interface FourMemeTokenTaxInfo {
	burnRate: number
	divideRate: number
	feeRate: 1 | 3 | 5 | 10
	liquidityRate: number
	minSharing: string
	recipientAddress: string
	recipientRate: number
}

export interface FourMemeCreateTokenPayload {
	name: string
	shortName: string
	symbol: string
	desc: string
	imgUrl: string
	launchTime: number
	label: (typeof FOUR_MEME_SUPPORTED_LABELS)[number]
	lpTradingFee: 0.0025
	webUrl?: string
	twitterUrl?: string
	telegramUrl?: string
	preSale: string
	raisedAmount: string
	onlyMPC: boolean
	feePlan: boolean
	raisedToken: FourMemeRaisedTokenConfig
	tokenTaxInfo?: FourMemeTokenTaxInfo
}

export interface FourMemeApiClient {
	generateNonce(accountAddress: string): Promise<string>
	loginDex(args: { wallet: string; nonce: string; signature: string }): Promise<string>
	uploadTokenImage(args: { filePath: string; accessToken: string }): Promise<string>
	createToken(args: { payload: FourMemeCreateTokenPayload; accessToken: string }): Promise<{
		createArg: `0x${string}`
		signature: `0x${string}`
	}>
	getRaisedTokenConfig(): Promise<FourMemeRaisedTokenConfig>
}

export const DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG: FourMemeRaisedTokenConfig = {
	symbol: 'BNB',
	nativeSymbol: 'BNB',
	symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
	deployCost: '0',
	buyFee: '0.01',
	sellFee: '0.01',
	minTradeFee: '0',
	b0Amount: '8',
	totalBAmount: '24',
	totalAmount: '1000000000',
	logoUrl:
		'https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png',
	tradeLevel: ['0.1', '0.5', '1'],
	status: 'PUBLISH',
	buyTokenLink: 'https://pancakeswap.finance/swap',
	reservedNumber: 10,
	saleRate: '0.8',
	networkCode: 'BSC',
	platform: 'MEME',
}

interface FourMemeEnvelope<T> {
	code?: string | number
	data?: T
	msg?: string
	message?: string
}

function asErrorMessage(body: FourMemeEnvelope<unknown>): string {
	return body.msg || body.message || 'Unknown four.meme API error'
}

async function parseJson<T>(res: Response): Promise<FourMemeEnvelope<T>> {
	const text = await res.text()
	if (!text) return {}
	try {
		return JSON.parse(text) as FourMemeEnvelope<T>
	} catch {
		throw new Error(`four.meme returned invalid JSON: ${text.slice(0, 300)}`)
	}
}

async function ensureSuccess<T>(res: Response): Promise<T> {
	const body = await parseJson<T>(res)
	if (!res.ok) {
		throw new Error(`four.meme HTTP ${res.status}: ${asErrorMessage(body)}`)
	}
	if (`${body.code ?? ''}` !== '0') {
		throw new Error(`four.meme API error: ${asErrorMessage(body)}`)
	}
	if (body.data === undefined) {
		throw new Error('four.meme API error: missing data in response')
	}
	return body.data
}

function getMimeType(filePath: string): string {
	const normalized = filePath.toLowerCase()
	if (normalized.endsWith('.png')) return 'image/png'
	if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
	if (normalized.endsWith('.gif')) return 'image/gif'
	if (normalized.endsWith('.bmp')) return 'image/bmp'
	if (normalized.endsWith('.webp')) return 'image/webp'
	return 'application/octet-stream'
}

export function buildFourMemeLoginMessage(nonce: string): string {
	return `You are sign in Meme ${nonce}`
}

export function createFourMemeApiClient(): FourMemeApiClient {
	return {
		async generateNonce(accountAddress) {
			const res = await fetch(`${BASE_URL}/v1/private/user/nonce/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					accountAddress,
					verifyType: 'LOGIN',
					networkCode: 'BSC',
				}),
			})
			return ensureSuccess<string>(res)
		},

		async loginDex({ wallet, nonce, signature }) {
			const res = await fetch(`${BASE_URL}/v1/private/user/login/dex`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					region: 'WEB',
					langType: 'EN',
					loginIp: '',
					inviteCode: '',
					verifyInfo: {
						address: wallet,
						networkCode: 'BSC',
						signature,
						verifyType: 'LOGIN',
						message: buildFourMemeLoginMessage(nonce),
					},
					walletName: 'OpenClaw',
				}),
			})
			return ensureSuccess<string>(res)
		},

		async uploadTokenImage({ filePath, accessToken }) {
			const bytes = await readFile(filePath)
			const form = new FormData()
			form.set('file', new File([bytes], basename(filePath), { type: getMimeType(filePath) }))

			const res = await fetch(`${BASE_URL}/v1/private/token/upload`, {
				method: 'POST',
				headers: {
					'meme-web-access': accessToken,
				},
				body: form,
			})

			return ensureSuccess<string>(res)
		},

		async createToken({ payload, accessToken }) {
			const res = await fetch(`${BASE_URL}/v1/private/token/create`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'meme-web-access': accessToken,
				},
				body: JSON.stringify(payload),
			})

			const data = await ensureSuccess<{ createArg?: string; signature?: string }>(res)
			if (!data.createArg || !data.signature) {
				throw new Error('four.meme API error: missing createArg or signature')
			}
			return {
				createArg: data.createArg as `0x${string}`,
				signature: data.signature as `0x${string}`,
			}
		},

		async getRaisedTokenConfig() {
			return DEFAULT_FOUR_MEME_RAISED_TOKEN_CONFIG
		},
	}
}
