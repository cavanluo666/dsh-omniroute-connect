/**
 * dsh-omniroute-connect —— 浏览器半身：网关管理页。
 *
 * 这个插件**自己就是网关**，所以这一页不是「接入开关」，而是
 * **一个网关的控制台**：上游列表、每个上游的健康度、路由策略、
 * 以及最近几次请求实际走了哪条路。
 *
 * ## 页面结构（按用户的实际顺序）
 *
 *   1. 顶部：整体状态 + 三个动作（自检、重置健康、全部恢复）
 *   2. 上游列表：每条可展开——改地址/密钥、探测、启停、删除、
 *      看它的健康度（成功率、平均延迟、断路器状态）
 *   3. 路由策略：选策略 + 竞速开关（带真实代价的提示）
 *   4. 最近请求：实际用了谁、有没有回退
 *
 * ## 三个刻意的设计决定
 *
 * **竞速默认关闭，且代价写在界面上。** 同一请求发给 N 家只有 1 个答案
 * 被采用，另外 N-1 个是已经产生的真实计费。把这个开关做成一个
 * 无提示的 checkbox 是不负责任的。
 *
 * **健康度显示「还不知道」而不是 0。** 一个刚配好的上游成功率是
 * `undefined`（没有样本），把它显示成 0% 会让人以为它坏了。
 *
 * **失败要说清是「谁的错」。** 上游本身的错（5xx/超时）和请求的错
 * （400/413）在界面上分开显示，因为修法完全不同。
 *
 * ## 手写、不打包
 *
 * 这个文件不经过任何构建：`window.__ModuleLoader__.load` 的工厂里只
 * `require('react')`。所有控件都是手写的 div/button/input，
 * 样式只用 `--dsw-alias-*` 主题令牌。
 */

window.__ModuleLoader__.load({
  id: 'dsh-omniroute-connect',
  factory(require) {
    /** React 由宿主提供；这个包不打包任何依赖。 */
    const React = require('react')
    const h = React.createElement

    /** 本地接口前缀。 */
    const API = '/api/omniroute-connect'

    /**
     * 样式表。
     *
     * 只用主题令牌，不写死颜色：这样浅色/深色主题切换、以及宿主换皮
     * 都能自动跟随。唯一的例外是几何量（尺寸、圆角），它们与主题无关。
     */
    const CSS = `
.dshor-root { display: flex; flex-direction: column; gap: 12px; }
.dshor-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshor-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshor-field { display: flex; flex-direction: column; gap: 4px; }
.dshor-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshor-input {
  box-sizing: border-box; width: 100%; padding: 5px 9px;
  font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px; outline: none;
}
.dshor-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dshor-input:disabled { color: var(--dsw-alias-label-secondary); cursor: not-allowed; }
.dshor-btn {
  padding: 4px 11px; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px; white-space: nowrap;
}
.dshor-btn:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary); }
.dshor-btn:disabled { opacity: .5; cursor: not-allowed; }
.dshor-btn-primary { color: var(--dsw-alias-bg-base); background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshor-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dshor-switch {
  position: relative; width: 32px; height: 18px; flex: none;
  border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0;
  transition: background .16s, border-color .16s;
}
.dshor-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshor-switch:disabled { opacity: .5; cursor: not-allowed; }
.dshor-knob {
  position: absolute; top: 1px; left: 1px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--dsw-alias-label-secondary);
  transition: transform .16s, background .16s;
}
.dshor-switch[aria-checked="true"] .dshor-knob { transform: translateX(14px); background: var(--dsw-alias-bg-base); }
.dshor-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.dshor-dot-ok { background: var(--dsw-alias-state-success-primary); }
.dshor-dot-warn { background: var(--dsw-alias-state-warn-primary); }
.dshor-dot-bad { background: var(--dsw-alias-state-error-primary); }
.dshor-note {
  font-size: 12px; line-height: 1.5; padding: 7px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); word-break: break-word;
}
.dshor-note-bad { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshor-note-ok { border-color: var(--dsw-alias-state-success-primary); }
.dshor-note-warn { border-color: var(--dsw-alias-state-warn-primary); }
.dshor-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.dshor-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dshor-card {
  border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); overflow: hidden;
}
.dshor-card-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer;
  background: 0 0; border: 0; width: 100%; font: inherit; text-align: left;
  color: var(--dsw-alias-label-primary);
}
.dshor-card-body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.dshor-grid { display: grid; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); }
.dshor-stat { display: flex; flex-direction: column; gap: 1px; }
.dshor-stat-value { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshor-stat-label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dshor-seg { display: inline-flex; flex-wrap: wrap; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; }
.dshor-seg-btn {
  padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border: 0; border-right: 0.5px solid var(--dsw-alias-border-l1);
}
.dshor-seg-btn:last-child { border-right: 0; }
.dshor-seg-btn[aria-pressed="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dshor-seg-btn:disabled { opacity: .5; cursor: not-allowed; }
.dshor-title { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshor-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }
`

    /**
     * 把样式表插进文档一次，返回它的清理函数。
     *
     * 用 `data-plugin-css` 做幂等标记，而不是靠 `ctx.styles`：
     * 后者是「动态插件」沙箱里的东西，静态客户端插件没有这个服务。
     * 手动插 `<style>` 是宿主自己的插件也在用的做法。
     *
     * @returns {() => void} 清理函数。
     */
    function injectCss() {
      if (typeof document === 'undefined') return () => {}
      const id = 'dsh-omniroute-connect/panel.css'
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-omniroute-connect'
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /**
     * 本进程的控制键，从 status 文档里拿到。
     *
     * 写操作必须带上它。它是**每进程随机**的，不落盘、不写进任何日志，
     * 所以本机其它程序就算也能发 HTTP 请求，也猜不到这个值。
     * 模块级而不是组件级：一次 status 读取后所有卡片都能用，
     * 不必每个组件各拿一份。
     */
    let controlKey

    /**
     * 一次 fetch，失败时给出可读的错误。
     *
     * 写操作自动带上控制键；读操作（status）不需要，因为那时
     * 还没有键可带——键本身就是从它的响应里来的。
     *
     * @param {string} path - 相对本插件接口前缀的路径。
     * @param {object} [init] - fetch 参数。
     * @returns {Promise<object>} 解析后的 JSON。
     */
    async function call(path, init) {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(method === 'GET' || controlKey === undefined ? {} : { 'x-omniroute-key': controlKey }),
      }
      const response = await fetch(`${API}/${path}`, {
        credentials: 'same-origin',
        ...init,
        headers,
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) {
        // 403 单独说清楚：它几乎总是「页面是旧的、控制键换了」
        // （进程重启后浏览器还开着旧页面），而重载就能解决。
        if (response.status === 403) {
          throw new Error(`被拒绝（${value?.error ?? '权限不足'}）——如果刚重启过 dsh，刷新本页即可。`)
        }
        throw new Error(value?.error ?? `HTTP ${String(response.status)}`)
      }
      if (value === undefined || value === null || typeof value !== 'object') {
        throw new Error('接口返回了非 JSON 内容')
      }
      // status 文档带回本进程的控制键，记下来供后续写操作使用。
      if (typeof value.controlKey === 'string' && value.controlKey !== '') controlKey = value.controlKey
      return value
    }

    /** 把毫秒数说成人话。 */
    function humanDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      if (ms < 1000) return `${String(Math.round(ms))} ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
      return `${String(Math.round(ms / 60000))} 分钟`
    }

    /** 把时间戳说成人话。 */
    function humanTime(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—'
      try { return new Date(ts).toLocaleString() } catch { return String(ts) }
    }

    /**
     * 成功率的显示。
     *
     * `undefined` 必须显示成「还不知道」——一个刚配好的上游没有样本，
     * 显示 0% 会让人以为它坏了，而它只是还没被用过。
     */
    function rateText(rate, sampleCount) {
      if (rate === undefined || sampleCount === 0) return '还不知道'
      return `${String(Math.round(rate * 100))}%`
    }

    /** 断路器状态 → 点颜色 + 中文。 */
    function breakerBadge(state) {
      switch (state) {
        case 'open': return { cls: 'dshor-dot dshor-dot-bad', text: '已拉闸' }
        case 'half-open': return { cls: 'dshor-dot dshor-dot-warn', text: '探测中' }
        default: return { cls: 'dshor-dot dshor-dot-ok', text: '正常' }
      }
    }

    /** 一个小开关控件（手写，避免引入宿主的 UI 包）。 */
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'dshor-switch',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: () => { props.onChange(!props.checked) },
      }, h('span', { className: 'dshor-knob' }))
    }

    /** 一行「标题 + 说明 + 开关」。 */
    function ToggleRow(props) {
      return h('div', { className: 'dshor-between' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'dshor-title' }, props.title),
          props.hint === undefined ? null : h('div', { className: 'dshor-hint' }, props.hint),
        ),
        h(Switch, { checked: props.checked, disabled: props.disabled, label: props.title, onChange: props.onChange }),
      )
    }

    /** 一个统计块。 */
    function Stat(props) {
      return h('div', { className: 'dshor-stat' },
        h('span', { className: 'dshor-stat-value' }, props.value),
        h('span', { className: 'dshor-stat-label' }, props.label),
      )
    }

    /**
     * 单个上游的卡片：可展开，展开后能改、能探测、能删。
     *
     * 编辑走本地草稿 + 「保存」按钮，而不是每敲一个字就发请求：
     * 地址改到一半的中间状态是**非法**的（比如 `http://` 后面还没写），
     * 立刻提交会让上游在那段时间里被丢弃。
     */
    function UpstreamCard(props) {
      const { upstream, busy, onSaved, onProbe, onReset, onBusy } = props
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState(undefined)
      const [probe, setProbe] = React.useState(undefined)

      const value = key => draft?.[key] ?? upstream[key]
      const edit = (key, next) => { setDraft({ ...(draft ?? {}), [key]: next }) }
      const dirty = draft !== undefined && Object.keys(draft).length > 0
      const health = upstream.health ?? {}
      const badge = breakerBadge(health.state)

      const modelText = upstream.modelCount === 0
        ? '未声明（接受任何模型 id）'
        : `${String(upstream.modelCount)} 个模型`

      return h('div', { className: 'dshor-card' },
        h('button', {
          type: 'button',
          className: 'dshor-card-head',
          'aria-expanded': open,
          onClick: () => { setOpen(!open) },
        },
          h('span', { className: badge.cls }),
          h('span', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'dshor-title' },
              upstream.name,
              upstream.builtin === true ? h('span', { className: 'dshor-sub' }, ' · 内置') : null,
              upstream.kind === 'opencode-free' ? h('span', { className: 'dshor-sub' }, ' · 免密钥') : null,
            ),
            h('div', { className: 'dshor-sub' }, upstream.baseURL),
          ),
          h('span', { className: 'dshor-sub', style: { whiteSpace: 'nowrap' } },
            `${rateText(health.successRate, health.sampleCount)} · ${modelText}`),
        ),

        open ? h('div', { className: 'dshor-card-body' },
          // 健康度
          h('div', { className: 'dshor-grid' },
            h(Stat, { label: '断路器', value: badge.text }),
            h(Stat, { label: '成功率', value: rateText(health.successRate, health.sampleCount) }),
            h(Stat, { label: '平均延迟', value: health.averageLatencyMs > 0 ? humanDuration(health.averageLatencyMs) : '—' }),
            h(Stat, { label: '成功 / 失败', value: `${String(health.totals?.success ?? 0)} / ${String(health.totals?.failure ?? 0)}` }),
            h(Stat, {
              label: '最近成功',
              value: health.lastSuccessAt === undefined ? '—' : humanTime(health.lastSuccessAt),
            }),
          ),

          health.lastFailure === undefined ? null : h('div', { className: 'dshor-note dshor-note-bad' },
            `最近一次失败（${health.lastFailure.code}）：${health.lastFailure.message || '未给出原因'}`),

          upstream.cooldownRemainingMs === undefined ? null : h('div', { className: 'dshor-note dshor-note-warn' },
            `已拉闸，${humanDuration(upstream.cooldownRemainingMs)} 后自动重试。改好了密钥或地址可以直接点「恢复」。`),

          // 地址与密钥
          h('div', { className: 'dshor-field' },
            h('span', { className: 'dshor-label' }, '基础地址（OpenAI 兼容，通常以 /v1 结尾）'),
            h('input', {
              className: 'dshor-input', value: value('baseURL') ?? '', spellCheck: false,
              placeholder: 'https://api.example.com/v1',
              onChange: event => { edit('baseURL', event.target.value) },
            }),
          ),
          h('div', { className: 'dshor-field' },
            h('span', { className: 'dshor-label' }, 'API Key'),
            h('input', {
              className: 'dshor-input', type: 'password', spellCheck: false, autoComplete: 'off',
              value: draft?.apiKey ?? '',
              placeholder: upstream.hasApiKey ? '已设置（留空表示不改动）' : '留空 = 这个上游不需要密钥',
              onChange: event => { edit('apiKey', event.target.value) },
            }),
          ),
          h('div', { className: 'dshor-field' },
            h('span', { className: 'dshor-label' }, '模型列表（每行一个 id；留空表示接受任何模型）'),
            h('textarea', {
              className: 'dshor-input',
              style: { minHeight: 56, resize: 'vertical', fontFamily: 'ui-monospace, monospace' },
              // 初值取**现存模型的 id 列表**，而不是空串：
              // 文本框空着会让「保存」看起来像保存成功，实际却把
              // 已有的模型列表清空了——一个用户完全没打算做的破坏性操作。
              value: value('modelsText') ?? (upstream.models ?? []).join('\n'),
              spellCheck: false,
              placeholder: 'gpt-4o\\nclaude-sonnet-4-6',
              onChange: event => { edit('modelsText', event.target.value) },
            }),
            h('span', { className: 'dshor-hint' }, '一个上游声明了模型之后，只有这些模型会路由到它；留空表示它什么都能接。'),
          ),

          // 权重与价格（只在相关策略下才有意义，但显示出来便于比较）
          h('div', { className: 'dshor-row' },
            h('div', { className: 'dshor-field', style: { flex: 1, minWidth: 90 } },
              h('span', { className: 'dshor-label' }, '权重（按权重策略）'),
              h('input', {
                className: 'dshor-input', type: 'number', min: 1,
                value: String(value('weight') ?? 1),
                onChange: event => { edit('weight', Number(event.target.value) || 1) },
              }),
            ),
            h('div', { className: 'dshor-field', style: { flex: 1, minWidth: 90 } },
              h('span', { className: 'dshor-label' }, '输入价 $/M tok'),
              h('input', {
                className: 'dshor-input', type: 'number', min: 0, step: '0.01',
                value: value('inputPricePerMTok') === undefined ? '' : String(value('inputPricePerMTok')),
                placeholder: '未填',
                onChange: event => {
                  const raw = event.target.value
                  edit('inputPricePerMTok', raw === '' ? undefined : Number(raw))
                },
              }),
            ),
            h('div', { className: 'dshor-field', style: { flex: 1, minWidth: 90 } },
              h('span', { className: 'dshor-label' }, '输出价 $/M tok'),
              h('input', {
                className: 'dshor-input', type: 'number', min: 0, step: '0.01',
                value: value('outputPricePerMTok') === undefined ? '' : String(value('outputPricePerMTok')),
                placeholder: '未填',
                onChange: event => {
                  const raw = event.target.value
                  edit('outputPricePerMTok', raw === '' ? undefined : Number(raw))
                },
              }),
            ),
          ),

          h(ToggleRow, {
            title: '启用这个上游',
            hint: '停用后它不参与路由，但配置保留。',
            checked: value('enabled') !== false,
            disabled: busy !== '',
            onChange: next => { edit('enabled', next) },
          }),

          // 动作
          h('div', { className: 'dshor-row' },
            dirty
              ? h('button', {
                  type: 'button', className: 'dshor-btn dshor-btn-primary', disabled: busy !== '',
                  onClick: () => { void onSaved(upstream, draft) },
                }, busy === `save:${upstream.id}` ? '保存中…' : '保存')
              : null,
            h('button', {
              type: 'button', className: 'dshor-btn', disabled: busy !== '',
              onClick: async () => {
                onBusy(`probe:${upstream.id}`)
                try { setProbe(await onProbe(upstream.id)) } finally { onBusy('') }
              },
            }, busy === `probe:${upstream.id}` ? '探测中…' : '探测可用模型'),
            h('button', {
              type: 'button', className: 'dshor-btn', disabled: busy !== '',
              onClick: () => { void onReset(upstream.id) },
            }, '恢复健康状态'),
            upstream.builtin === true ? null : h('button', {
              type: 'button', className: 'dshor-btn dshor-btn-danger', disabled: busy !== '',
              onClick: () => { void props.onDeleted(upstream.id) },
            }, '删除'),
          ),

          probe === undefined ? null : h('div', {
            className: `dshor-note ${probe.status === 'ready' ? 'dshor-note-ok' : (probe.status === 'no-listing' ? 'dshor-note-warn' : 'dshor-note-bad')}`,
          },
            h('div', { className: 'dshor-row' },
              h('span', { className: probe.status === 'ready' ? 'dshor-dot dshor-dot-ok' : 'dshor-dot dshor-dot-bad' }),
              h('span', null, probe.message),
              probe.elapsedMs === undefined ? null : h('span', { className: 'dshor-sub', style: { marginLeft: 'auto' } }, humanDuration(probe.elapsedMs)),
            ),
            probe.status !== 'ready' || !Array.isArray(probe.models) ? null : h('div', { className: 'dshor-row', style: { marginTop: 6 } },
              h('span', { className: 'dshor-sub' }, `发现 ${String(probe.models.length)} 个模型。`),
              h('button', {
                type: 'button', className: 'dshor-btn',
                onClick: () => {
                  // 把探测结果填进草稿，让用户确认后再保存——
                  // 自动保存会覆盖用户手写但还没来得及保存的内容。
                  edit('modelsText', probe.models.slice(0, 200).map(model => model.id).join('\n'))
                },
              }, '填入模型列表'),
            ),
          ),
        ) : null,
      )
    }

    /**
     * 主页面。
     *
     * 状态全部走一个 `status` 文档 + 本地 UI 状态。写入一律
     * 「先发请求，再用返回的 status 覆盖本地」——不乐观更新，
     * 因为这里的写操作会改变路由行为，猜错了界面就会和实际不符。
     */
    function OmniRoutePanel() {
      const [status, setStatus] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [busy, setBusy] = React.useState('')
      const [checkResult, setCheckResult] = React.useState(undefined)

      /** 用服务端返回的状态覆盖本地。 */
      const adopt = next => { setStatus(next) }

      React.useEffect(() => {
        let live = true
        call('status')
          .then(value => { if (live) adopt(value) })
          .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
        return () => { live = false }
      }, [])

      /** 跑一个动作，成功后采用返回的 status。 */
      const run = async (name, action) => {
        setBusy(name)
        setError(undefined)
        try { return await action() } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
          return undefined
        } finally { setBusy('') }
      }

      /** 提交一批配置改动。 */
      const save = (patch, tag = 'save') => run(tag, async () => {
        adopt(await call('config', { method: 'POST', body: JSON.stringify(patch) }))
      })

      const gateway = status?.gateway
      const strategies = status?.strategies ?? []

      /** 把上游列表里的某一条换成新的。 */
      const saveUpstream = (upstream, draft) => {
        /** 模型列表来自文本框；没动过就用服务端现存的那份。 */
        const models = typeof draft.modelsText === 'string'
          ? draft.modelsText.split('\n').map(line => line.trim()).filter(line => line !== '').map(id => ({ id, name: id }))
          : (upstream.models ?? [])
        const next = {
          id: upstream.id,
          name: upstream.name,
          baseURL: typeof draft.baseURL === 'string' && draft.baseURL.trim() !== '' ? draft.baseURL.trim() : upstream.baseURL,
          // 密钥留空 = 「不改动」，用占位符表达；服务端会换成已存的值。
          // 这样用户改个地址不会顺手把密钥抹掉，而界面上看不出这件事发生过。
          apiKey: typeof draft.apiKey === 'string' && draft.apiKey !== ''
            ? draft.apiKey
            : (upstream.hasApiKey === true ? '__keep__' : ''),
          enabled: draft.enabled !== undefined ? draft.enabled === true : upstream.enabled,
          weight: typeof draft.weight === 'number' ? draft.weight : (upstream.weight ?? 1),
          ...(typeof draft.inputPricePerMTok === 'number' ? { inputPricePerMTok: draft.inputPricePerMTok } : {}),
          ...(typeof draft.outputPricePerMTok === 'number' ? { outputPricePerMTok: draft.outputPricePerMTok } : {}),
          ...(upstream.kind === undefined ? {} : { kind: upstream.kind }),
          ...(upstream.builtin === true ? { builtin: true } : {}),
          models,
        }
        const list = (gateway?.upstreams ?? []).map(entry => (
          entry.id === upstream.id ? next : serializeExisting(entry)
        ))
        return save({ upstreams: list }, `save:${upstream.id}`)
      }

      /** 探测一个上游。 */
      const probeOne = async id => {
        const value = await call('probe', { method: 'POST', body: JSON.stringify({ id }) })
        adopt(value.status)
        return value.probe
      }

      /** 重置健康状态。 */
      const resetHealth = id => run('reset', async () => {
        adopt(await call('reset-health', { method: 'POST', body: JSON.stringify(id === undefined ? {} : { id }) }))
      })

      /** 删掉一个上游。 */
      const deleteUpstream = id => {
        const list = (gateway?.upstreams ?? []).filter(entry => entry.id !== id).map(serializeExisting)
        return save({ upstreams: list }, `save:${id}`)
      }

      /** 新增一个空上游。 */
      const addUpstream = () => {
        const existing = gateway?.upstreams ?? []
        const taken = new Set(existing.map(entry => entry.id))
        let id = 'upstream-1'
        for (let index = 1; index < 999; index += 1) {
          if (!taken.has(`upstream-${String(index)}`)) { id = `upstream-${String(index)}`; break }
        }
        const list = [...existing.map(serializeExisting), {
          id, name: id, baseURL: 'https://', apiKey: '', enabled: true, models: [],
        }]
        return save({ upstreams: list })
      }

      if (status === undefined) {
        return h('div', { className: 'dshor-root' },
          h('div', { className: 'dshor-title' }, 'OmniRoute 网关'),
          h('div', { className: 'dshor-hint' }, error ?? '正在读取…'),
        )
      }

      return h('div', { className: 'dshor-root' },
        // ── 顶部 ──
        h('div', { className: 'dshor-between' },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'dshor-title' }, 'OmniRoute 网关'),
            h('div', { className: 'dshor-hint' },
              `${String(gateway.upstreams.length)} 个上游 · 策略 ${strategyName(strategies, gateway.strategy)}`
              + (gateway.raceEnabled ? ` · 竞速 ${String(gateway.raceWidth)} 路` : '')
              + (status.registered ? '' : ' · 已停用')),
          ),
          h('div', { className: 'dshor-row' },
            h('span', { className: status.registered ? 'dshor-dot dshor-dot-ok' : 'dshor-dot' }),
            h(Switch, {
              checked: status.enabled,
              label: '启用 OmniRoute provider',
              onChange: next => { void save({ enabled: next }) },
            }),
          ),
        ),

        error === undefined ? null : h('div', { className: 'dshor-note dshor-note-bad' }, error),

        status.rejected !== undefined && status.rejected.length > 0
          ? h('div', { className: 'dshor-note dshor-note-warn' },
              `有 ${String(status.rejected.length)} 条上游配置被忽略：`,
              h('div', { style: { marginTop: 4 } },
                ...status.rejected.map((entry, index) => h('div', { key: index, className: 'dshor-mono' }, `#${String(entry.index + 1)} ${entry.reason}`)),
              ),
            )
          : null,

        // ── 动作 ──
        h('div', { className: 'dshor-row' },
          h('button', {
            type: 'button', className: 'dshor-btn dshor-btn-primary', disabled: busy !== '',
            onClick: async () => {
              const result = await run('check', async () => {
                const value = await call('self-check', { method: 'POST', body: '{}' })
                adopt(value.status)
                return value.result
              })
              if (result !== undefined) setCheckResult(result)
            },
          }, busy === 'check' ? '自检中…' : '发一条自检消息'),
          h('button', {
            type: 'button', className: 'dshor-btn', disabled: busy !== '',
            onClick: () => { void resetHealth(undefined) },
          }, '全部恢复健康状态'),
          h('button', {
            type: 'button', className: 'dshor-btn', disabled: busy !== '',
            onClick: () => { void addUpstream() },
          }, '添加上游'),
        ),

        checkResult === undefined ? null : h('div', {
          className: `dshor-note ${checkResult.ok === true ? 'dshor-note-ok' : 'dshor-note-bad'}`,
        },
          h('div', { className: 'dshor-row' },
            h('span', { className: checkResult.ok === true ? 'dshor-dot dshor-dot-ok' : 'dshor-dot dshor-dot-bad' }),
            h('span', null, checkResult.ok === true
              ? `自检成功（${checkResult.model}）：${checkResult.answer ?? ''}`
              : `自检失败：${checkResult.message ?? '未知原因'}`),
            checkResult.elapsedMs === undefined ? null : h('span', { className: 'dshor-sub', style: { marginLeft: 'auto' } }, humanDuration(checkResult.elapsedMs)),
          ),
        ),

        // ── 上游列表 ──
        h('div', { className: 'dshor-label' }, '上游（按策略决定用哪个，失败自动换下一个）'),
        gateway.upstreams.length === 0
          ? h('div', { className: 'dshor-hint' }, '还没有上游。点上面的「添加上游」。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              ...gateway.upstreams.map(upstream => h(UpstreamCard, {
                key: upstream.id,
                // 直接把视图对象传下去：它的 `models` 是 id 列表，
                // 卡片用它做模型文本框的初值。
                // 早先这里塞了个 `modelsText: ''`，把初值强行置空，
                // 结果是「打开就显示空列表，一保存就清空模型」。
                upstream,
                busy,
                onBusy: setBusy,
                onSaved: saveUpstream,
                onProbe: probeOne,
                onReset: id => resetHealth(id),
                onDeleted: deleteUpstream,
              })),
            ),

        // ── 路由策略 ──
        h('div', { className: 'dshor-label' }, '路由策略'),
        h('div', { className: 'dshor-seg' },
          ...strategies.map(strategy => h('button', {
            key: strategy.id,
            type: 'button',
            className: 'dshor-seg-btn',
            'aria-pressed': gateway.strategy === strategy.id ? 'true' : 'false',
            disabled: busy !== '',
            title: strategy.description,
            onClick: () => { void save({ strategy: strategy.id }) },
          }, strategy.name)),
        ),
        h('div', { className: 'dshor-hint' },
          strategies.find(entry => entry.id === gateway.strategy)?.description ?? ''),

        // ── 竞速 ──
        h(ToggleRow, {
          title: '并行竞速（会多花钱，默认关闭）',
          hint: '同一个请求同时发给前几家，取最快开始回答的。'
            + '注意：另外几家**已经产生了真实计费**，只是答案被丢弃。'
            + '只有「首字节延迟比钱重要」时才值得开。',
          checked: gateway.raceEnabled === true,
          disabled: busy !== '',
          onChange: next => { void save({ raceEnabled: next }) },
        }),
        gateway.raceEnabled !== true ? null : h('div', { className: 'dshor-row' },
          h('span', { className: 'dshor-label' }, '竞速宽度'),
          h('div', { className: 'dshor-seg' },
            ...[2, 3, 4].map(width => h('button', {
              key: width,
              type: 'button',
              className: 'dshor-seg-btn',
              'aria-pressed': gateway.raceWidth === width ? 'true' : 'false',
              disabled: busy !== '',
              onClick: () => { void save({ raceWidth: width }) },
            }, `${String(width)} 路`)),
          ),
        ),

        // ── 最近请求 ──
        h('div', { className: 'dshor-label' }, '最近请求'),
        (status.recentRoutes ?? []).length === 0
          ? h('div', { className: 'dshor-hint' }, '还没有通过网关发过请求。把模型选择器切到 omniroute 下的模型聊一句就会出现在这里。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              ...(status.recentRoutes ?? []).slice(0, 8).map((route, index) => h('div', {
                key: index, className: 'dshor-note',
              },
                h('div', { className: 'dshor-row' },
                  h('span', { className: route.raced === true ? 'dshor-dot dshor-dot-warn' : 'dshor-dot dshor-dot-ok' }),
                  h('span', { className: 'dshor-mono' }, `${route.model} → ${route.upstreamName}`),
                  h('span', { className: 'dshor-sub', style: { marginLeft: 'auto' } }, humanTime(route.at)),
                ),
                route.routeNote === undefined ? null
                  : h('div', { className: 'dshor-hint', style: { marginTop: 3 } }, route.routeNote),
                route.raced === true
                  ? h('div', { className: 'dshor-hint', style: { marginTop: 3 } },
                      `竞速：${(route.racers ?? []).map(racer => `${racer.upstream}${racer.won ? '✓' : ''}(${humanDuration(racer.elapsedMs)})`).join(' · ')}`)
                  : null,
              )),
            ),

        // ── 高级 ──
        h('div', { className: 'dshor-label' }, '高级'),
        h('div', { className: 'dshor-row' },
          h('div', { className: 'dshor-field', style: { flex: 1, minWidth: 120 } },
            h('span', { className: 'dshor-label' }, '未知模型的上下文容量'),
            h('input', {
              className: 'dshor-input', type: 'number', min: 1,
              defaultValue: String(status.defaultContextWindow),
              onBlur: event => {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value > 0 && value !== status.defaultContextWindow) {
                  void save({ defaultContextWindow: Math.floor(value) })
                }
              },
            }),
          ),
          h('div', { className: 'dshor-field', style: { flex: 1, minWidth: 120 } },
            h('span', { className: 'dshor-label' }, '每次请求输出上限'),
            h('input', {
              className: 'dshor-input', type: 'number', min: 1,
              defaultValue: String(status.defaultMaxTokens),
              onBlur: event => {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value > 0 && value !== status.defaultMaxTokens) {
                  void save({ defaultMaxTokens: Math.floor(value) })
                }
              },
            }),
          ),
          h('div', { className: 'dshor-field', style: { flex: 1, minWidth: 120 } },
            h('span', { className: 'dshor-label' }, '输出上限覆盖（0 = 不覆盖）'),
            h('input', {
              className: 'dshor-input', type: 'number', min: 0,
              defaultValue: String(status.maxTokensOverride),
              onBlur: event => {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value >= 0 && value !== status.maxTokensOverride) {
                  void save({ maxTokensOverride: Math.floor(value) })
                }
              },
            }),
          ),
        ),

        h('div', { className: 'dshor-hint' },
          '配置文件：$DSH_HOME/omniroute-connect/config.json。'
          + (status.edited ? '当前存在本地改动。' : '当前全部是默认值。')),
      )
    }

    /** 策略 id → 中文名。 */
    function strategyName(strategies, id) {
      return strategies.find(entry => entry.id === id)?.name ?? id
    }

    /**
     * 把服务端返回的上游视图还原成配置条目。
     *
     * 服务端的视图是**给人看的**（带健康度、hasApiKey 这样的派生字段），
     * 直接回传会把它们写进配置文件，下次读出来就多了一堆垃圾。
     * 所以回写时显式只取配置字段。
     *
     * `apiKey: '__keep__'` 是「沿用已存的密钥」的占位符——浏览器
     * 从来拿不到密钥原值（status 里只有 hasApiKey 布尔），
     * 所以只能用这个标记表达「别动它」。
     */
    function serializeExisting(entry) {
      return {
        id: entry.id,
        name: entry.name,
        baseURL: entry.baseURL,
        apiKey: entry.hasApiKey === true ? '__keep__' : '',
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        ...(entry.builtin === true ? { builtin: true } : {}),
        enabled: entry.enabled,
        weight: entry.weight ?? 1,
        ...(entry.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: entry.inputPricePerMTok }),
        ...(entry.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: entry.outputPricePerMTok }),
        models: (entry.models ?? []).map(id => ({ id, name: id })),
      }
    }

    return {
      name: 'dsh-omniroute-connect-client',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => injectCss())
        /**
         * 注册到「插件」面板里本 bundle 的详情页。
         *
         * 键必须是本包的包名：宿主用同一个键判断「这个 bundle 有没有自己的
         * 配置界面」，键对不上就整块不显示。`slots.inject` 会等宿主把那个
         * 槽位声明出来再注册，所以加载顺序无所谓。
         */
        try {
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: 'dsh-omniroute-connect',
          }, OmniRoutePanel))
        } catch (error) {
          console.error('[dsh-omniroute-connect] 注册管理页失败（Host 半身不受影响）：', error)
        }
      },
    }
  },
})
