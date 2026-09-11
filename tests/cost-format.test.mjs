/**
 * 金额显示格式的单测（node:test，直接跑构建产物 lib/client/cost-format.js）。
 *
 * 显示契约：货币标注**只出现一次** —— 数值 + ISO 代码 `CNY`，配合金币图标表达
 * "这是钱"；不足四位小数的正值显示下限写法；非有限值/负值一律归零。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCost, formatCostWithTokens, formatHitRate, formatTokens } from '../lib/client/cost-format.js'

test('金额：四位小数 + CNY 单位', () => {
  assert.equal(formatCost(1_680_856), '1.6809 CNY')
  assert.equal(formatCost(12_300), '0.0123 CNY')
  assert.equal(formatCost(100), '0.0001 CNY')
})

test('金额：零与下限', () => {
  assert.equal(formatCost(0), '0 CNY')
  assert.equal(formatCost(99), '<0.0001 CNY')
  assert.equal(formatCost(-5), '0 CNY')
  assert.equal(formatCost(Number.NaN), '0 CNY')
})

test('金额：不含 ¥ 符号（货币标注只由 CNY 承担）', () => {
  assert.equal(formatCost(1_000_000).includes('¥'), false)
  assert.equal(formatCost(1_000_000), '1.0000 CNY')
})

test('明细行：金额（tokens）组合', () => {
  assert.equal(formatCostWithTokens(1_200, 1_234), '0.0012 CNY（1,234 tokens）')
  assert.equal(formatCostWithTokens(0, 0), '0 CNY（0 tokens）')
})

test('token 千分位与命中率', () => {
  assert.equal(formatTokens(12_345), '12,345')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatHitRate(900, 100), '90.0%')
  assert.equal(formatHitRate(0, 0), null)
})
