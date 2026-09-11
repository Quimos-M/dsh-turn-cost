/**
 * 本插件自带的**人民币金币**图标（DSH 图元集没有货币字形）。
 *
 * 造型：外圈（币）+ 圈内 ¥。
 *
 * 结构取舍（第二轮目视反馈："￥ 结构要调、图标要再大一点"）：
 *   * 原稿两条横线间距只有 0.3 单位净空，15px 下必然糊成一块 —— 现在把两横拉开到
 *     净空 ≈0.95 单位（y=9.2 / 11.3），¥ 的两横在小尺寸下才立得住；
 *   * ¥ 整体笔画比外圈细（1.15 vs 1.2），让字面成为视觉主体；
 *   * 两撇起点内收，字面与圈内壁保持 ≈0.85 单位留白，避免"顶到圈上"。
 *
 * 尺寸基准：原生 `IconClockOutline16` 是 `circle r=6.375 / strokeWidth 1.25`，
 * 本图标取 r=6.4 / 1.2 与其光学大小持平；**实际渲染尺寸由 CSS 决定，并且已按用户
 * 要求比原生 pill 图标放大一档**（每轮 15→17px、输入框下 14→16px、弹窗标题 15px）。
 *
 * @module dsh-turn-cost/client/icons
 */

import type { ReactElement } from 'react'

/** ¥ 金币轮廓图标。 */
export function IconCoinOutline16(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* 币面外圈 */}
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      {/* 圈内 ¥：两撇（起笔内收）+ 竖 + 两横（净空足够，不糊） */}
      <path
        d="M5.5 4.4 8 7.6l2.5-3.2M8 7.6v4.5M5.4 9.2h5.2M5.4 11.3h5.2"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
