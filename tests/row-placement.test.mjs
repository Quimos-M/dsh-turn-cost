/**
 * 落位算法的回归测试（node:test + 自建极简 DOM 夹具）。
 *
 * 锁定的核心不变量：
 *   1. `before-usage` 必须落在**分支之后、用量之前**（两轮实测的 bug 现场）；
 *   2. 锚点必须是动作行的直接子节点 —— 用 pill 内部的 button 当锚点在真实 DOM 里
 *      会抛 NotFoundError，夹具复刻了这条约束；
 *   3. **包裹层**（槽位渲染给条目套的那一层）不能让落位失效：靠 `parentElement`
 *      找行是错的，必须向上寻找真正含原生 pill 的祖先（`findActionRow`）；
 *   4. 边界：到 `[data-turn-tail]` 还没找到就必须放弃，绝不认领别的轮次的动作行；
 *   5. 插件自己的 pill（同样带 aria-haspopup="dialog"）不会被误当成原生 pill；
 *   6. 幂等：重复调用不改顺序；结构异常时静默保持原位、不抛错。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findActionRow, nativePills, reposition, rowCellOf } from '../lib/client/row-placement.js'
import { buildRow, el, order } from './dom-fixture.mjs'

test('夹具复刻了真实约束：拿 pill 内部的 button 当锚点会抛错', () => {
  const { row, own, usageCell } = buildRow()
  const innerButton = usageCell.children[0]
  assert.throws(() => row.insertBefore(own, innerButton), /NotFoundError/)
  assert.equal(rowCellOf(innerButton, row), usageCell)
  assert.doesNotThrow(() => row.insertBefore(own, rowCellOf(innerButton, row)))
})

test('回归：条目被包裹层包住时，parentElement 里没有原生 pill（旧实现的失效点）', () => {
  const { row, own, ownCell } = buildRow({ wrapOwn: true })
  assert.notEqual(own.parentElement, row)
  assert.equal(own.parentElement, ownCell)
  // 旧实现直接查 parentElement：必然空集 → 静默不落位。
  assert.equal(nativePills(own.parentElement).length, 0)
  // 新实现向上寻找：拿到真正的动作行。
  assert.equal(findActionRow(own), row)
})

test('回归：portal 进动作行后在行内重排 → 落在分支之后、用量之前', () => {
  const { row, own, ownCell, usageCell, timeCell } = buildRow({ wrapOwn: true })
  // 模拟 React portal：React 把 portal 子节点插入容器（行）末尾。
  row.append(own)
  assert.equal(ownCell.children.length, 0)
  reposition(own, 'before-usage', row)
  assert.deepEqual(order(row, own), ['copy', 'like', 'cell', 'branch', 'COST', 'cell', 'cell', 'clock'])
  assert.equal(own.previousElementSibling.attrs['aria-label'], 'branch')
  assert.equal(own.nextElementSibling, usageCell)
  assert.equal(usageCell.nextElementSibling, timeCell)
})

test('边界：到 [data-turn-tail] 仍未找到原生 pill 就放弃（不认领别的轮次）', () => {
  const { own } = buildRow({ usage: false, time: false })
  assert.equal(findActionRow(own), null)
})

test('原生 pill 识别：排除插件自己的弹窗按钮', () => {
  const { row } = buildRow()
  const pills = nativePills(row)
  assert.equal(pills.length, 2)
  assert.equal(pills.every(button => button.closest('[data-dsh-turn-cost]') === null), true)
})

test('before-usage（默认）：落在分支之后、用量之前', () => {
  const { row, own, usageCell, timeCell } = buildRow()
  reposition(own, 'before-usage', row)
  assert.deepEqual(order(row, own), ['copy', 'like', 'branch', 'COST', 'cell', 'cell', 'clock'])
  assert.equal(own.previousElementSibling.attrs['aria-label'], 'branch')
  assert.equal(own.nextElementSibling, usageCell)
  assert.equal(usageCell.nextElementSibling, timeCell)
})

test('between：落在用量与耗时之间', () => {
  const { row, own, usageCell, timeCell } = buildRow()
  reposition(own, 'between', row)
  assert.equal(own.previousElementSibling, usageCell)
  assert.equal(own.nextElementSibling, timeCell)
})

test('after-time：落在耗时之后、时钟之前', () => {
  const { row, own, timeCell } = buildRow()
  reposition(own, 'after-time', row)
  assert.equal(own.previousElementSibling, timeCell)
  assert.equal(own.nextElementSibling.attrs['aria-label'], 'clock')
})

test('inline：完全不碰 DOM', () => {
  const { row, own } = buildRow()
  reposition(own, 'inline', row)
  assert.deepEqual(order(row, own), ['copy', 'like', 'COST', 'branch', 'cell', 'cell', 'clock'])
})

test('幂等：重复调用保持位置且不抛错', () => {
  for (const placement of ['before-usage', 'between', 'after-time']) {
    const { row, own } = buildRow()
    reposition(own, placement, row)
    const first = order(row, own)
    reposition(own, placement, row)
    reposition(own, placement, row)
    assert.deepEqual(order(row, own), first)
  }
})

test('结构异常：没有原生 pill 时留在原位、不抛错', () => {
  const { row, own } = buildRow({ usage: false, time: false })
  const before = order(row, own)
  assert.doesNotThrow(() => { reposition(own, 'before-usage', row) })
  assert.deepEqual(order(row, own), before)
})

test('只有一个原生 pill 时：before-usage 落在它之前，between 退化为同一位置', () => {
  const single = buildRow({ time: false })
  reposition(single.own, 'between', single.row)
  assert.equal(single.own.nextElementSibling, single.usageCell)

  const single2 = buildRow({ time: false })
  reposition(single2.own, 'before-usage', single2.row)
  assert.equal(single2.own.nextElementSibling, single2.usageCell)
})

test('别的插件在同一行插入带弹窗按钮时，仍贴着原生那一对', () => {
  const { row, own, usageCell, timeCell } = buildRow()
  const foreign = el('button', { 'aria-haspopup': 'dialog' })
  row.insertBefore(foreign, row.children[2])
  reposition(own, 'before-usage', row)
  assert.equal(own.nextElementSibling, usageCell)
  assert.equal(usageCell.nextElementSibling, timeCell)
  assert.equal(nativePills(row).length, 3)
})
