import { expect, test } from 'claude-code/testing'

import { forgejo } from '../hooks/forgejo'
import type { Send } from '../hooks/tracker'

// Forgejo behind the tracker: how a list is paged and narrowed to the repo,
// against a fake Send.

type Reply = { status: number; headers?: Record<string, string>; body: unknown }

function fakeSend(route: (url: URL) => Reply, asked: string[] = []): Send {
  return (async (url: string) => {
    asked.push(url)
    const r = route(new URL(url))
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: r.headers ?? { 'content-type': 'application/json' },
      text: JSON.stringify(r.body),
    }
  }) as unknown as Send
}

const issue = (number: number, fullName = 'boats/radar') => ({
  number,
  title: `Issue ${number}`,
  created_at: '2026-10-01T08:00:00Z',
  html_url: `https://git.example.org/${fullName}/issues/${number}`,
  body: null,
  milestone: null,
  labels: [],
  repository: { full_name: fullName },
})

const items = (from: number, n: number) => Array.from({ length: n }, (_, k) => issue(from + k))

test('mine: a slug whose case differs from the canonical name still matches', async () => {
  const send = fakeSend(() => ({ status: 200, body: [issue(7, 'boats/radar'), issue(8, 'boats/other')] }))
  const got = await forgejo(send, { host: 'git.example.org', owner: 'Boats', name: 'Radar' }, 'tok', 'epic').mine()
  expect(got.map(i => i.number)).toEqual([7])
})

const R = { host: 'git.example.org', owner: 'boats', name: 'radar' }

test('paging: a total above the first page keeps paging until it is reached', async () => {
  const asked: string[] = []
  const send = fakeSend(url => {
    const page = url.searchParams.get('page')
    return page === '1'
      ? { status: 200, headers: { 'x-total-count': '45' }, body: items(1, 30) }
      : { status: 200, headers: { 'x-total-count': '45' }, body: items(31, 15) }
  }, asked)
  const got = await forgejo(send, R, 'tok', 'epic').mine()
  expect(got).toHaveLength(45)
  expect(asked).toHaveLength(2)
})

test('paging: without a total a page shorter than 50 is the last', async () => {
  const asked: string[] = []
  const send = fakeSend(() => ({ status: 200, body: items(1, 30) }), asked)
  const got = await forgejo(send, R, 'tok', 'epic').mine()
  expect(got).toHaveLength(30)
  expect(asked).toHaveLength(1)
})

test('paging: an empty page stops it even when the total says more', async () => {
  const asked: string[] = []
  const send = fakeSend(url => ({
    status: 200,
    headers: { 'x-total-count': '100' },
    body: url.searchParams.get('page') === '1' ? items(1, 30) : [],
  }), asked)
  const got = await forgejo(send, R, 'tok', 'epic').mine()
  expect(got).toHaveLength(30)
  expect(asked).toHaveLength(2)
})
