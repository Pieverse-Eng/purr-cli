import { Parser } from 'htmlparser2'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
export async function mapThree<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        result[index] = await task(items[index])
      }
    }),
  )
  return result
}

export function extractPage(html: string, url: string) {
  const stack: string[] = [],
    text: string[] = [],
    titles: string[] = [],
    links: string[] = []
  let description = '',
    anchor: { href: string; text: string } | undefined
  const parser = new Parser({
    onopentag(tag, attrs) {
      stack.push(tag)
      if (
        tag === 'meta' &&
        !description &&
        ['description', 'og:description', 'twitter:description'].includes(
          (attrs.name || attrs.property || '').toLowerCase(),
        )
      )
        description = attrs.content || ''
      if (tag === 'a') anchor = { href: attrs.href || '', text: '' }
    },
    ontext(value) {
      if (stack.some((t) => ['script', 'style', 'noscript', 'svg', 'template'].includes(t))) return
      if (anchor) anchor.text += value
      if (stack.includes('title')) titles.push(value)
      if (!stack.some((t) => ['head', 'nav'].includes(t))) text.push(value)
    },
    onclosetag(tag) {
      if (tag === 'a' && anchor) {
        if (
          /about|docs?|how.it.works|whitepaper|\u4ecb\u7ecd|\u6587\u6863|\u673a\u5236/i.test(
            anchor.text + ' ' + anchor.href,
          )
        ) {
          try {
            const link = new URL(anchor.href, url)
            if (['http:', 'https:'].includes(link.protocol) && !links.includes(link.href))
              links.push(link.href)
          } catch {
            /* Ignore malformed page links. */
          }
        }
        anchor = undefined
      }
      stack.pop()
      if (['p', 'div', 'br', 'li', 'h1', 'h2', 'section'].includes(tag)) text.push(' ')
    },
  })
  parser.end(html)
  const title = titles.join('').replace(/\s+/g, ' ').trim()
  const body = text.join('').replace(/\s+/g, ' ').trim()
  const blocked =
    /just a moment|access denied|verify you are human|attention required/i.test(title) ||
    /please complete the following challenge|enable javascript and cookies to continue/i.test(body)
  const unavailable = blocked || (!description && body.length < 80)
  return {
    status: unavailable ? 'unavailable' : 'ok',
    title: title.slice(0, 300),
    description: description.slice(0, 1200),
    text: blocked ? '' : body.slice(0, 6000),
    related_links: links.slice(0, 5),
    truncated: body.length > 6000,
    ...(unavailable
      ? { error: 'Blocked page or insufficient readable content; may require login or JavaScript' }
      : {}),
  }
}

// Limit decoded response bytes while streaming, including after decompression.
export async function boundedText(response: Response, limit = 1_500_000): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let size = 0,
    text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new Error('Response exceeds size limit')
      text += decoder.decode(part.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel()
  }
}

export async function readPages(urls: string[], request: Fetcher = fetch) {
  if (!urls.length || urls.length > 10) throw new Error('Provide 1–10 URLs')
  for (const url of urls) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('Use HTTP(S) URLs without credentials')
  }
  return {
    pages: await mapThree([...new Set(urls)], async (url) => {
      try {
        const response = await request(url, {
          headers: { Accept: 'text/html,application/json', 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(12_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const raw = await boundedText(response),
          finalUrl = response.url || url
        const type = response.headers.get('content-type') || ''
        const base = { url, final_url: finalUrl, http_status: response.status }
        if (type.includes('json')) {
          const text = JSON.stringify(JSON.parse(raw))
          return {
            ...base,
            status: 'ok',
            content_type: 'json',
            text: text.slice(0, 6000),
            truncated: text.length > 6000,
          }
        }
        if (!type.includes('html')) throw new Error('Unsupported content type')
        return { ...base, ...extractPage(raw, finalUrl) }
      } catch (error) {
        return {
          url,
          status: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  }
}
