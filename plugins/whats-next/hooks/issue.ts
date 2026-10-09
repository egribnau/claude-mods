const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A date as a day and month: 14 Oct. Another year adds it: 14 Oct 2025.
export function day(iso: string, now: number): string {
  const d = new Date(iso)
  const year = d.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`
}

// A due date and how far off it is, and whether it has passed.
export function dueText(iso: string, now: number): { text: string; passed: boolean } {
  const days = Math.round((Date.parse(iso) - now) / 86400000)
  const when =
    days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : days === -1 ? 'yesterday' : `${-days} days ago`
  return { text: `${day(iso, now)}, ${when}`, passed: days < 0 }
}

// Seconds as hours and minutes: 1h 20m, 45m.
export function duration(seconds: number): string {
  const m = Math.round(seconds / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

// A label's `rrggbb` colour as text on a dark terminal: as Forgejo has it,
// made lighter when it is too dark to read; undefined for no colour.
export function readable(color: string): string | undefined {
  const hex = color.replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return undefined
  let [r, g, b] = [0, 2, 4].map(k => Number.parseInt(hex.slice(k, k + 2), 16)) as [number, number, number]
  // Toward white a fifth at a time, so the hue stays.
  while (0.299 * r + 0.587 * g + 0.114 * b < 110) [r, g, b] = [r, g, b].map(v => v + (255 - v) * 0.2) as [number, number, number]
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

// `text` broken into lines of at most `width` characters, at spaces where
// it can; blank lines are kept.
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  if (width <= 0) return out
  for (const line of text.replace(/\r/g, '').split('\n')) {
    let rest = line.trimEnd()
    if (rest === '') {
      out.push('')
      continue
    }
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width)
      const at = cut > 0 ? cut : width
      out.push(rest.slice(0, at))
      rest = rest.slice(at).trimStart()
    }
    out.push(rest)
  }
  return out
}
