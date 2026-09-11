/**
 * 外部 UI 插件的 tsdown 预设（对齐 DSH 官方 packages 的
 * `shared/tsdown.client.ts`，为独立发行的插件复刻）：
 *
 *   * node 半 → `lib/index.js`（ESM，cordis 保持 external）；
 *   * 浏览器半 → `lib/client.js`（CJS 闭包工厂，调用
 *     `window.__ModuleLoader__.load({id, factory})`，externals 走注入的
 *     require，即加载器模块表 —— 无全局变量、无 import map）；
 *   * CSS Modules 由 lightningcss 在 bundle 内编译：`import css from
 *     './x.module.css'` 得到哈希类名映射，CSS 文本在工厂执行时自动插入一个
 *     `<style data-plugin>` 标签（插件卸载时由加载器移除该标签）。
 *
 * @module dsh-turn-cost/build/tsdown.client
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'
import { PLATFORM_MODULES } from './web-platform.ts'

/**
 * 虚拟 id 包装：把 CSS 挡在 tsdown 自己的 css 管线之外（那条管线需要
 * @tsdown/css）。后缀很关键：tsdown 的守卫匹配以 `.css` 结尾的 id，所以虚拟
 * id 不能以 `.css` 结尾。
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 允许内联的 wire/type 层（无共享运行时身份；本插件暂未使用，保留作纯度门定义）。 */
export const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|util-crypto|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$)/

/** 生成的 descriptor/codec 贡献（无共享运行时身份）。 */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/** 从加载器模块表解析的 externals。 */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

/** 本包根目录（build/ 的上一级）。 */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 把物理 lib 相对源路径重写为镜像仓库目录的浏览器 URL。 */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('packages/') ? `../../../${repositoryPath}` : source
}

/**
 * 为一个 UI 插件包生成 tsdown 配置：node 半 lib 构建 + 浏览器 client bundle。
 * @param id - 插件 id（包名），写进 `__ModuleLoader__.load` 与注入的 style 标签。
 * @param libEntry - node 半入口。
 * @returns 依据 DSH_BUILD_FACE 选择的 tsdown 配置。
 */
export function clientBundle(id: string, libEntry: readonly string[]): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry)
  return ({ env }) => {
    const face = buildFace(env?.DSH_BUILD_FACE)
    const client = clientConfig(id, face === undefined
      ? 'src/client/index.tsx'
      : 'lib/types/client/index.js')
    if (face === 'host') return [lib]
    if (face === 'client') return [client]
    return [lib, client]
  }
}

type BuildFace = 'host' | 'client' | undefined

type BuildFaceConfig = (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[]

function buildFace(value: unknown): BuildFace {
  if (value === undefined || value === 'host' || value === 'client') return value
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

function clientLibraryConfig(id: string, libEntry: readonly string[]): UserConfig {
  return {
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // cordis 在运行期由 dsh profile 树解析，绝不来自本仓库安装；其构建出的
    // 声明文件带有 .ts 后缀的相对 import，rolldown 无法跟进，因此保持 external。
    external: ['@deepseek-ai/cordis'],
  }
}

function clientConfig(id: string, entry: string): UserConfig {
  const cssFiles = new Map<string, string>()
  return {
    name: `${id}/client`,
    entry: { client: entry },
    // 浏览器产物落在 node 半旁边（同一个 lib/ 目录；entryFileNames 钉死为
    // lib/client.js）。clean 必须保持关闭，否则会抹掉上面刚产出的 node 半。
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // tsdown 会自动把 dependencies 外置；凡不在加载器模块表里的都必须内联
    // （wire/type 层等）。模块表答不上来的 require 必然在运行期抛错，所以规则
    // 就是这张表本身：表内保持 external（上面的 external 优先），表外全部内联。
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [{
      // bundle 纯度门（模块边界规则的构建期镜像）：平台 seed 条目保持 external，
      // 允许的 wire 层内联，其余任何 @deepseek-ai 值导入都是构建错误。
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" 不是平台模块（CLIENT_EXTERNALS）、不是允许内联的 wire 层、`
          + '也不是生成的 /remote 贡献 —— 跨插件值导入被禁止；跨插件协作请走 cordis 服务（type-only 导入会被擦除，不经过这里）',
        )
      },
    }, {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        const virtualId = CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        cssFiles.set(virtualId, abs)
        return virtualId
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const sourceId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const fileId = cssFiles.get(virtualId) ?? sourceId
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
          classMap[local] = exp.name
        }
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${id}/${basename(sourceId)}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** 把产物 JS 资源 import 解析回源码树对应文件。 */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
