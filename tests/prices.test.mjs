/**
 * 价表与峰谷判定的边界单测（node:test，直接跑构建产物 lib/prices.js）。
 *
 * 断言依据：DeepSeek 官方 2026-08-17（峰谷生效）、2026-08-23（周末全天谷价）、
 * 2026-09-10 12:00（flash 系列降价 + v4.1-flash 路由）三次公告。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PRICE_AS_OF, costOf, isPeakAt, resolvePrice,
} from '../lib/prices.js'

/** 北京时间 ISO → epoch ms。 */
const bj = iso => Date.parse(`${iso}+08:00`)

test('峰谷窗口：工作日 09:00–12:00 / 14:00–18:00 为峰，边界为半开区间', () => {
  // 2026-09-14 是周一。
  assert.equal(isPeakAt(bj('2026-09-14T08:59:59')), false)
  assert.equal(isPeakAt(bj('2026-09-14T09:00:00')), true)
  assert.equal(isPeakAt(bj('2026-09-14T11:59:59')), true)
  assert.equal(isPeakAt(bj('2026-09-14T12:00:00')), false)
  assert.equal(isPeakAt(bj('2026-09-14T13:59:59')), false)
  assert.equal(isPeakAt(bj('2026-09-14T14:00:00')), true)
  assert.equal(isPeakAt(bj('2026-09-14T17:59:59')), true)
  assert.equal(isPeakAt(bj('2026-09-14T18:00:00')), false)
  assert.equal(isPeakAt(bj('2026-09-14T23:30:00')), false)
})

test('峰谷窗口：周末全天谷价（2026-08-23 起），此前每天都是峰谷制', () => {
  // 2026-09-12 周六 / 09-13 周日：工作时段也按谷价。
  assert.equal(isPeakAt(bj('2026-09-12T10:00:00')), false)
  assert.equal(isPeakAt(bj('2026-09-13T10:00:00')), false)
  // 2026-08-22 周六但早于 08-23 规则：仍按"每天峰谷"判为高峰。
  assert.equal(isPeakAt(bj('2026-08-22T10:00:00')), true)
  // 2026-08-23 周日（新规则生效当天）。
  assert.equal(isPeakAt(bj('2026-08-23T10:00:00')), false)
})

test('峰谷窗口：制度生效前（2026-08-17 之前）恒为平价', () => {
  assert.equal(isPeakAt(bj('2026-08-15T10:00:00')), false) // 周六，且早于 08-17
  assert.equal(isPeakAt(bj('2026-08-16T23:59:59')), false)
  assert.equal(isPeakAt(bj('2026-08-17T00:00:00')), false) // 生效瞬间是凌晨＝谷
  assert.equal(isPeakAt(bj('2026-08-17T10:00:00')), true)
})

test('flash 家族：现行价（2026-09-10 12:00 起）峰谷各一档', () => {
  const peak = resolvePrice('deepseek-v4-flash-vision-exp', bj('2026-09-14T10:00:00'))
  assert.deepEqual([peak.hit, peak.miss, peak.out], [0.04, 2, 8])
  assert.equal(peak.peak, true)
  assert.equal(peak.estimated, false)
  assert.equal(peak.asOf, '2026-09-10')

  const valley = resolvePrice('deepseek-v4-flash-vision-exp', bj('2026-09-14T20:00:00'))
  assert.deepEqual([valley.hit, valley.miss, valley.out], [0.02, 1, 4])
  assert.equal(valley.peak, false)
})

test('flash 家族：v4.1-flash 与 v4-flash 同价（服务端统一路由）', () => {
  const at = bj('2026-09-14T20:00:00')
  const legacy = resolvePrice('deepseek-v4-flash', at)
  const vision = resolvePrice('deepseek-v4-flash-vision-exp', at)
  const v41 = resolvePrice('deepseek-v4.1-flash', at)
  assert.deepEqual([legacy.hit, legacy.miss, legacy.out], [0.02, 1, 4])
  assert.deepEqual([vision.hit, vision.miss, vision.out], [0.02, 1, 4])
  assert.deepEqual([v41.hit, v41.miss, v41.out], [0.02, 1, 4])
})

test('价格版本切换点：2026-09-10 12:00 前后价格不同', () => {
  // 08:00 是谷段，用来看"切换前的价格档"本身。
  const before = resolvePrice('deepseek-v4-flash', bj('2026-09-10T08:00:00'))
  assert.deepEqual([before.hit, before.miss, before.out], [0.05, 1.5, 4.5])
  assert.equal(before.asOf, '2026-08-17')
  // 11:59 仍在高峰段（09:00–12:00），故按旧价 ×2。
  const beforePeak = resolvePrice('deepseek-v4-flash', bj('2026-09-10T11:59:59'))
  assert.deepEqual([beforePeak.hit, beforePeak.miss, beforePeak.out], [0.1, 3, 9])
  assert.equal(beforePeak.asOf, '2026-08-17')
  const after = resolvePrice('deepseek-v4-flash', bj('2026-09-10T12:00:00'))
  assert.deepEqual([after.hit, after.miss, after.out], [0.02, 1, 4])
  assert.equal(after.asOf, '2026-09-10')
})

test('pro 家族：当前仍按自身价（含峰谷），08-17 之前为平价单档', () => {
  const peak = resolvePrice('deepseek-v4-pro', bj('2026-09-14T10:00:00'))
  assert.deepEqual([peak.hit, peak.miss, peak.out], [0.3, 9, 27])
  const valley = resolvePrice('deepseek-v4-pro', bj('2026-09-14T20:00:00'))
  assert.deepEqual([valley.hit, valley.miss, valley.out], [0.15, 4.5, 13.5])
  const flat = resolvePrice('deepseek-v4-pro', bj('2026-08-15T10:00:00'))
  assert.deepEqual([flat.hit, flat.miss, flat.out], [0.025, 3, 6])
  assert.equal(flat.peak, false)
})

test('未收录模型：按兜底档估算并标 estimated', () => {
  const price = resolvePrice('some-future-model', bj('2026-09-14T20:00:00'))
  assert.equal(price.estimated, true)
  assert.equal(price.family, 'default')
  assert.deepEqual([price.hit, price.miss, price.out], [0.02, 1, 4])
})

test('价格口径标签与常量一致', () => {
  assert.equal(resolvePrice('deepseek-v4-flash', bj('2026-09-14T20:00:00')).asOf, PRICE_AS_OF)
})

test('计价：tokens × 元/百万 = 微元，整数无漂移', () => {
  const rates = { hit: 0.02, miss: 1, out: 4 }
  const cost = costOf({ hit: 9000, miss: 1000, out: 500 }, rates)
  assert.deepEqual(cost, { hit: 180, miss: 1000, out: 2000 })
  // 一百万未命中 token × 1 元/百万 = 1 元 = 1e6 微元。
  assert.equal(costOf({ hit: 0, miss: 1_000_000, out: 0 }, rates).miss, 1_000_000)
  // 非法输入一律归零，不产生 NaN/负数。
  assert.deepEqual(costOf({ hit: -5, miss: Number.NaN, out: 3 }, rates), { hit: 0, miss: 0, out: 12 })
})
