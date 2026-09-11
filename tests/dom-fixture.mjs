/**
 * 极简 DOM 夹具：只为 `row-placement` 的落位单测服务。
 *
 * 刻意复刻真实 DOM 的关键约束：`insertBefore` 的参照节点**必须**是当前父节点的
 * 直接子节点，否则抛 NotFoundError —— 第一轮实测里"每轮 pill 留在分支之前"的
 * 根因就是拿 pill 内部的 button 当锚点，这里把这个约束固化下来当回归护栏。
 *
 * 选择器只支持本测试用到的一小撮：`button[aria-haspopup="dialog"]` 与
 * `[data-dsh-turn-cost]`。
 */

/** 一个假元素。 */
export class FakeElement {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.attrs = attrs
    this.children = []
    this.parentElement = null
  }

  /** 追加子节点。 */
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement?.detach?.(node)
      node.parentElement = this
      this.children.push(node)
    }
    return this
  }

  /** 摘除一个子节点（内部用）。 */
  detach(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentElement = null
  }

  /**
   * 在参照节点之前插入。
   * @throws 当参照节点不是本节点的直接子节点时（复刻真实 DOM 的 NotFoundError）。
   */
  insertBefore(node, reference) {
    if (reference === null || reference === undefined) return this.append(node)
    if (reference.parentElement !== this) {
      throw new Error('NotFoundError: the node before which the new node is to be inserted is not a child of this node')
    }
    node.parentElement?.detach?.(node)
    const index = this.children.indexOf(reference)
    this.children.splice(index, 0, node)
    node.parentElement = this
    return node
  }

  /** 插到自己后面（同级）。 */
  after(node) {
    const parent = this.parentElement
    if (parent === null) throw new Error('NotFoundError: no parent')
    node.parentElement?.detach?.(node)
    const index = parent.children.indexOf(this)
    parent.children.splice(index + 1, 0, node)
    node.parentElement = parent
    return node
  }

  get nextElementSibling() {
    const parent = this.parentElement
    if (parent === null) return null
    const index = parent.children.indexOf(this)
    return index >= 0 ? parent.children[index + 1] ?? null : null
  }

  get previousElementSibling() {
    const parent = this.parentElement
    if (parent === null) return null
    const index = parent.children.indexOf(this)
    return index > 0 ? parent.children[index - 1] : null
  }

  /** 后代里匹配选择器的元素（文档序）。 */
  querySelectorAll(selector) {
    const found = []
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }

  /** 自身或祖先里匹配选择器的最近一个。 */
  closest(selector) {
    let node = this
    while (node !== null) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  /** 是否带某个属性（生产代码用它识别 `[data-turn-tail]` 边界）。 */
  hasAttribute(name) {
    return Object.hasOwn(this.attrs, name)
  }
}

const DIALOG_BUTTON = /^button\[aria-haspopup="dialog"\]$/
const EXPANDED_BUTTON = /^button\[aria-expanded\]$/
const OWN_MARK = /^\[([a-z-]+)\]$/

/** 支持本测试用到的一小撮选择器，含逗号列表。 */
function matches(element, selector) {
  if (selector.includes(',')) return selector.split(',').some(part => matches(element, part.trim()))
  if (DIALOG_BUTTON.test(selector)) {
    return element.tagName === 'BUTTON' && element.attrs['aria-haspopup'] === 'dialog'
  }
  if (EXPANDED_BUTTON.test(selector)) {
    return element.tagName === 'BUTTON' && Object.hasOwn(element.attrs, 'aria-expanded')
  }
  const own = OWN_MARK.exec(selector)
  if (own !== null) return Object.hasOwn(element.attrs, own[1])
  throw new Error(`fixture: unsupported selector ${selector}`)
}

/** 建元素（语法糖）。 */
export const el = (tag, attrs = {}) => new FakeElement(tag, attrs)

/**
 * 搭一个与原生一致的轮次动作行。
 *
 * 结构：`[复制按钮][反馈按钮][插件条目][分支按钮][用量 span>button][耗时 span>button][时钟 span]`
 *
 * `wrapOwn: true` 复刻**真实**情形：槽位渲染会给插件条目套一层包裹元素，于是插件的
 * `parentElement` 只是包裹层（里面查不到原生 pill）—— 这正是"落位静默失效"的成因。
 *
 * @returns 行、插件节点、它在行内的占位单元、以及两个原生 pill 单元。
 */
export function buildRow({ withOwn = true, usage = true, time = true, wrapOwn = false } = {}) {
  const row = el('div', { 'data-turn-tail': '1' })
  row.append(el('button', { 'aria-label': 'copy' }))
  row.append(el('button', { 'aria-label': 'like' }))
  const own = el('span', { 'data-dsh-turn-cost': '' })
  own.append(el('button', { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' })) // 插件自己的 pill 也带这两条线索
  const ownCell = wrapOwn ? el('span', { 'aria-label': 'entry-wrapper' }) : own
  if (wrapOwn) ownCell.append(own)
  if (withOwn) row.append(ownCell)
  row.append(el('button', { 'aria-label': 'branch' }))
  const usageCell = el('span')
  if (usage) usageCell.append(el('button', { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }))
  row.append(usageCell)
  const timeCell = el('span')
  if (time) timeCell.append(el('button', { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }))
  row.append(timeCell)
  row.append(el('span', { 'aria-label': 'clock' }))
  return { row, own, ownCell, usageCell, timeCell }
}

/**
 * 行的子节点标签序列（便于断言顺序）。
 * @param row - 动作行。
 * @param costCell - 代表本插件的那一行内子节点（包裹层或插件节点本身）。
 */
export function order(row, costCell) {
  return row.children.map((child) => {
    if (child === costCell) return 'COST'
    if (child.attrs['aria-label'] === 'copy') return 'copy'
    if (child.attrs['aria-label'] === 'like') return 'like'
    if (child.attrs['aria-label'] === 'branch') return 'branch'
    if (child.attrs['aria-label'] === 'clock') return 'clock'
    return child.tagName === 'SPAN' ? 'cell' : child.tagName.toLowerCase()
  })
}
