/** Test session adoption triggered from session-list calls. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

const ownedContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

const header = (id: string, cwd = '/workspace', createdAt = 1): SessionHeader => ({
  version: SESSION_FORMAT_VERSION,
  id: SessionId(id),
  createdAt,
  isSeeded: false,
  cwd,
})

describe('session.list workspace adoption', () => {
  it('adopts a session another process persisted when a client lists', async () => {
    const ctx = new Context()
    ownedContexts.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)

    const persisted: SessionHeader[] = []
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => persisted,
    }))

    const adoptedFrames: SessionId[][] = []
    const adoptSessions = vi.fn(async (headers: readonly SessionHeader[]) => {
      const adopted = headers.map(h => h.id)
      adoptedFrames.push(adopted)
      return adopted
    })
    ctx.provide('workspaceRegistry', { adoptSessions } as never)

    const remote = await createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })

    // Persist a header after the controller started
    const unadopted = header('persisted-by-other-process', '/workspace')
    persisted.push(unadopted)

    const response = await remote.list({})
    expect(response.ok).toBe(true)

    expect(adoptSessions).toHaveBeenCalled()
    const callArgs = adoptSessions.mock.calls.flatMap(([headers]) => headers.map(h => h.id))
    expect(callArgs).toContain('persisted-by-other-process')
    expect(adoptedFrames.some(frame => frame.includes(SessionId('persisted-by-other-process')))).toBe(true)
  })

  it('a failing adoption does not fail the list', async () => {
    const ctx = new Context()
    ownedContexts.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)

    const persisted: SessionHeader[] = [header('persisted-1', '/workspace')]
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => persisted,
    }))

    const adoptSessions = vi.fn().mockRejectedValue(new Error('simulated adoption failure'))
    ctx.provide('workspaceRegistry', { adoptSessions } as never)

    const remote = await createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })

    const response = await remote.list({})
    expect(response.ok).toBe(true)
  })

  it('an adoption that throws synchronously does not fail the list', async () => {
    const ctx = new Context()
    ownedContexts.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)

    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header('persisted-1', '/workspace')],
    }))
    const adoptSessions = vi.fn(() => {
      throw new Error('simulated synchronous adoption failure')
    })
    ctx.provide('workspaceRegistry', { adoptSessions } as never)

    const remote = await createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })

    const response = await remote.list({})
    expect(response.ok).toBe(true)
    expect(adoptSessions).toHaveBeenCalled()
  })
})
