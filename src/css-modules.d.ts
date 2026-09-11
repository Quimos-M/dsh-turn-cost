/**
 * CSS Modules 的类型声明：`import css from './x.module.css'` 得到哈希类名映射。
 * 真正的编译由构建期的 lightningcss 完成（见 build/tsdown.client.ts）。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
