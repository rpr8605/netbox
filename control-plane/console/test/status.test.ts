import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapStatus, resolveServiceStatus, STALE_THRESHOLD_MS } from '../src/status.ts'

describe('status mapping', () => {
  it('maps active/verified_ready/reachable to working', () => {
    assert.equal(mapStatus('active').ui, 'working')
    assert.equal(mapStatus('verified_ready').ui, 'working')
    assert.equal(mapStatus('reachable').ui, 'working')
  })

  it('maps degraded and down', () => {
    assert.equal(mapStatus('degraded').ui, 'degraded')
    assert.equal(mapStatus('down').ui, 'down')
  })

  it('maps unknown or missing to nodata', () => {
    assert.equal(mapStatus('unknown').ui, 'nodata')
    assert.equal(mapStatus(undefined).ui, 'nodata')
  })

  it('treats not-monitored services as notmonitored', () => {
    const s = resolveServiceStatus('active', { monitored: false })
    assert.equal(s.ui, 'notmonitored')
  })

  it('treats stale services as nodata even if status was active', () => {
    const old = new Date(Date.now() - STALE_THRESHOLD_MS - 1).toISOString()
    const s = resolveServiceStatus('active', { lastReportAt: old })
    assert.equal(s.ui, 'nodata')
  })

  it('keeps active status when fresh', () => {
    const recent = new Date(Date.now() - 1000).toISOString()
    const s = resolveServiceStatus('active', { lastReportAt: recent })
    assert.equal(s.ui, 'working')
  })
})
