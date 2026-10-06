/**
 * dsh-reasoning-loop-guard — the log card (browser half).
 *
 * Hand-written in the lazy-CJS bundle protocol (`window.__ModuleLoader__.load`
 * with a factory returning cordis-plugin exports), so this package needs no
 * build step and no imports from dsh client packages — the same
 * zero-dependency stance as the host half.
 *
 * The card renders the fire journal (see `../lib/journal.js`) inside the
 * Plugins page, on the `plugins.bundle.config` slot keyed by this package's
 * name. It reads through the host route `/reasoning-loop-guard/log`
 * (`../lib/log-route.js`); with no web profile, or with the route absent, the
 * card never mounts and the plugin is exactly what it was before.
 *
 * `slots` and `locale` are both optional, so neither is required here:
 * `registerCard` takes each on its own scoped inject, and a missing locale
 * service just leaves the handle empty (the card then follows the page
 * language).
 */
window.__ModuleLoader__.load({
  id: 'dsh-reasoning-loop-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Absolute route the card reads and clears through. */
    var ROUTE = '/reasoning-loop-guard/log'

    /** Entry count requested per load. */
    var PAGE_LIMIT = 50

    /** Card copy, by language. Kept small: this card is a maintenance surface. */
    var STRINGS = {
      en: {
        title: 'Fire journal',
        subtitle: 'Every abort the guard recorded, newest first.',
        refresh: 'Refresh',
        clear: 'Clear journal',
        confirm: 'Confirm clear',
        cancel: 'Cancel',
        loading: 'Loading…',
        loadFailed: 'Could not read the journal',
        cleared: 'Journal cleared',
        nothingToClear: 'Nothing to clear',
        clearFailed: 'Could not clear the journal',
        copyPath: 'Copy path',
        copied: 'Path copied',
        empty: 'No fires recorded yet. The guard is armed and watching.',
        fires: 'fires',
        window: 'span',
        byRule: 'by rule',
        byModel: 'by model',
        atChars: 'at',
        route: 'route',
        disabled: 'The journal is disabled in this profile (journal: false).',
        truncated: 'Showing the newest {shown} of {matched} matched ({total} on file).',
        matched: '{matched} matched of {total} on file.',
      },
      zh: {
        title: '触发日志',
        subtitle: '守卫每一次中断推理循环的记录，最新的在最上面。',
        refresh: '刷新',
        clear: '清除日志',
        confirm: '确认清除',
        cancel: '取消',
        loading: '读取中…',
        loadFailed: '读取日志失败',
        cleared: '日志已清除',
        nothingToClear: '没有可清除的内容',
        clearFailed: '清除日志失败',
        copyPath: '复制路径',
        copied: '路径已复制',
        empty: '还没有触发记录。守卫已在运行并持续观察。',
        fires: '次触发',
        window: '时间跨度',
        byRule: '按判据',
        byModel: '按模型',
        atChars: '位置',
        route: '接口',
        disabled: '当前配置关闭了日志（journal: false）。',
        truncated: '显示最新的 {shown} 条，共命中 {matched} 条（文件内 {total} 条）。',
        matched: '命中 {matched} 条，文件内共 {total} 条。',
      },
    }

    /**
     * Pick the card dictionary for a language tag.
     * @param language - active language from the locale service, or undefined.
     * @returns the dictionary to render with.
     */
    function labelsFor(language) {
      return typeof language === 'string' && language.toLowerCase().indexOf('zh') === 0
        ? STRINGS.zh
        : STRINGS.en
    }

    /**
     * Fill `{name}` placeholders in one label.
     * @param text - template from {@link STRINGS}.
     * @param values - replacement values.
     * @returns the rendered string.
     */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      )
    }

    /**
     * One record's timestamp, as `YYYY-MM-DD HH:MM:SS`.
     * @param entry - a journal record.
     * @returns the display stamp.
     */
    function formatWhen(entry) {
      if (entry && typeof entry.iso === 'string' && entry.iso.length >= 19) {
        return entry.iso.replace('T', ' ').slice(0, 19)
      }
      if (entry && Number.isFinite(entry.at)) {
        return new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19)
      }
      return '?'
    }

    /**
     * The measurement that tripped the guard, as one short phrase.
     * @param entry - a journal record.
     * @returns display text, empty when the record carries no measurement.
     */
    function measureOf(entry) {
      if (!entry) return ''
      if (entry.rule === 'periodic-run') {
        return 'period=' + String(entry.period) + ' · units=' + String(entry.units)
      }
      if (Number.isFinite(entry.count)) return 'count=' + String(entry.count)
      return ''
    }

    /**
     * The provider/model pair behind one fire.
     * @param entry - a journal record.
     * @returns display text, or an em dash when the record has neither.
     */
    function whereOf(entry) {
      var parts = [entry?.provider, entry?.model].filter(
        (part) => typeof part === 'string' && part !== '',
      )
      return parts.length === 0 ? '—' : parts.join(' / ')
    }

    /**
     * Whether a load result has no fires at all.
     * @param summary - the route response.
     * @returns whether the journal is empty.
     */
    function isEmpty(summary) {
      return !summary || !Array.isArray(summary.entries) || summary.entries.length === 0
    }

    /**
     * Counters as one `key × n` line.
     * @param counts - a `{key: count}` map from the route.
     * @returns display text, or an em dash when there is nothing to show.
     */
    function countsText(counts) {
      if (!counts || typeof counts !== 'object') return '—'
      var parts = Object.keys(counts).map((key) => key + ' × ' + String(counts[key]))
      return parts.length === 0 ? '—' : parts.join('  ·  ')
    }

    /** Colours and spacing shared by the card's pieces. */
    var STYLE = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      muted: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
      dim: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
      mono: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
    }

    /**
     * Build the card component.
     * @param react - the React seed module.
     * @param ui - the shared UI primitives module.
     * @param localeRef - `{current}` handle on the locale service, filled late.
     * @returns the React component registered on the slot.
     */
    function LoopGuardCard(react, ui, localeRef) {
      var h = react.createElement

      // Built once per card so useSyncExternalStore is not handed a fresh
      // subscribe on every render, which would resubscribe every render.
      var subscribeLocale = (onChange) => {
        var locale = localeRef && localeRef.current
        return locale ? locale.subscribe(onChange) : () => {}
      }
      var readLocale = () => {
        var locale = localeRef && localeRef.current
        return locale ? locale.getSnapshot().active : ''
      }

      /**
       * Render the card.
       * @param props - `{view}` from the Plugins page; `page` means the page
       *   already drew the title and crumb, so the card is only its content.
       * @returns the card element.
       */
      return function LoopGuardCardView(props) {
        // Subscribed, not sampled: the language is a live setting, and a card
        // sitting open while the user switches has to follow. The branch is on
        // a closure constant, so hook order never varies within one card.
        var t = labelsFor(
          typeof react.useSyncExternalStore === 'function'
            ? react.useSyncExternalStore(subscribeLocale, readLocale)
            : readLocale(),
        )
        var page = props && props.view === 'page'

        var summaryState = react.useState(null)
        var noteState = react.useState('')
        var busyState = react.useState(true)
        var confirmState = react.useState(false)
        var summary = summaryState[0]
        var note = noteState[0]
        var busy = busyState[0]
        var confirming = confirmState[0]

        // Each load claims a generation so a slow response cannot overwrite a
        // newer one, and so an unmounting card stops touching state.
        var gen = react.useRef(0)
        react.useEffect(
          () => () => {
            gen.current += 1
          },
          [],
        )

        var load = react.useCallback(() => {
          var id = ++gen.current
          busyState[1](true)
          fetch(ROUTE + '?limit=' + String(PAGE_LIMIT))
            .then((response) =>
              response.json().then((body) => {
                if (!response.ok) throw new Error(body && body.error ? body.error : '')
                return body
              }),
            )
            .then((body) => {
              if (id !== gen.current) return
              summaryState[1](body)
              noteState[1]('')
              busyState[1](false)
            })
            .catch((error) => {
              if (id !== gen.current) return
              noteState[1](String((error && error.message) || '') || t.loadFailed)
              busyState[1](false)
            })
        }, [t.loadFailed])

        react.useEffect(() => {
          load()
        }, [load])

        var clear = react.useCallback(() => {
          var id = ++gen.current
          busyState[1](true)
          fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'clear' }),
          })
            .then((response) =>
              response.json().then((body) => {
                if (!response.ok) throw new Error(body && body.error ? body.error : '')
                return body
              }),
            )
            .then((body) => {
              if (id !== gen.current) return
              confirmState[1](false)
              busyState[1](false)
              noteState[1](body && body.removed === true ? t.cleared : t.nothingToClear)
              load()
            })
            .catch((error) => {
              if (id !== gen.current) return
              confirmState[1](false)
              busyState[1](false)
              noteState[1](String((error && error.message) || '') || t.clearFailed)
            })
        }, [load, t.cleared, t.clearFailed, t.nothingToClear])

        var copyPath = react.useCallback(() => {
          var path = summary && summary.path ? String(summary.path) : ''
          if (path === '') return
          var done = () => noteState[1](t.copied)
          if (typeof ui.writeClipboard === 'function') {
            Promise.resolve(ui.writeClipboard(path)).then(done).catch(() => {})
            return
          }
          done()
        }, [summary, t.copied, ui])

        /** One key/value line in the summary block. */
        var statLine = (label, value) =>
          h(
            'div',
            { style: { display: 'flex', gap: '10px', fontSize: '12.5px', lineHeight: 1.7 } },
            h('span', { style: { flex: 'none', minWidth: '68px', color: STYLE.muted } }, label),
            h('span', { style: { minWidth: 0, wordBreak: 'break-all' } }, value),
          )

        /** One journal record, as a bordered row. */
        var recordRow = (entry, index) =>
          h(
            'div',
            {
              key: String(entry && entry.at) + '-' + String(index),
              style: {
                border: STYLE.border,
                borderRadius: '10px',
                padding: '10px 12px',
                marginTop: '8px',
                background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '10px',
                  flexWrap: 'wrap',
                  fontSize: '12.5px',
                },
              },
              h('span', { style: { fontFamily: STYLE.mono } }, formatWhen(entry)),
              h(
                'span',
                {
                  style: {
                    color:
                      entry && entry.rule === 'periodic-run'
                        ? 'var(--dsw-alias-state-warn-primary, #c98a00)'
                        : 'var(--dsw-alias-state-error-primary, #d64545)',
                  },
                },
                String((entry && entry.rule) || '?'),
              ),
              h('span', { style: { color: STYLE.dim, fontFamily: STYLE.mono } }, measureOf(entry)),
              h(
                'span',
                { style: { color: STYLE.muted } },
                t.atChars + ' ' + String((entry && entry.atChars) ?? '?') + ' 字符',
              ),
              h('span', { style: { color: STYLE.muted, marginLeft: 'auto' } }, whereOf(entry)),
            ),
            entry && typeof entry.preview === 'string' && entry.preview !== ''
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: '6px',
                      fontSize: '12px',
                      fontFamily: STYLE.mono,
                      color: STYLE.dim,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    },
                  },
                  '“' + entry.preview + '”',
                )
              : null,
          )

        /** The summary + list body, shared by both views. */
        var body = []
        if (summary && summary.enabled === false) {
          body.push(
            h('div', { key: 'off', style: { fontSize: '13px', color: STYLE.muted } }, t.disabled),
          )
        }
        if (summary) {
          var stats = summary.stats || {}
          body.push(
            h(
              'div',
              { key: 'stats', style: { marginBottom: '4px' } },
              statLine(t.fires, String(stats.count ?? 0)),
              statLine(t.byRule, countsText(stats.byRule)),
              statLine(t.byModel, countsText(stats.byModel)),
              statLine(
                t.window,
                Number.isFinite(stats.earliest) && Number.isFinite(stats.latest)
                  ? new Date(stats.earliest).toISOString().replace('T', ' ').slice(0, 19) +
                      '  →  ' +
                      new Date(stats.latest).toISOString().replace('T', ' ').slice(0, 19)
                  : '—',
              ),
              statLine(t.route, h('span', { style: { fontFamily: STYLE.mono } }, ROUTE)),
            ),
          )
        }

        var toolbar = h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h(
            'span',
            { style: { fontSize: '12.5px', color: STYLE.muted } },
            busy
              ? t.loading
              : summary
                ? fill(summary.matched > PAGE_LIMIT ? t.truncated : t.matched, {
                    shown: Array.isArray(summary.entries) ? summary.entries.length : 0,
                    matched: summary.matched ?? 0,
                    total: summary.total ?? 0,
                  })
                : '',
          ),
          h('span', { style: { flex: 1 } }),
          h(
            ui.Button,
            {
              key: 'refresh',
              disabled: busy,
              onClick: load,
              icon: ui.IconRefreshOutlineMedium ? h(ui.IconRefreshOutlineMedium, null) : undefined,
            },
            t.refresh,
          ),
          confirming
            ? h(
                ui.Button,
                { key: 'confirm', disabled: busy, onClick: clear },
                t.confirm,
              )
            : h(
                ui.Button,
                {
                  key: 'clear',
                  disabled: busy || !summary,
                  onClick: () => confirmState[1](true),
                },
                t.clear,
              ),
          confirming
            ? h(
                ui.Button,
                { key: 'cancel', disabled: busy, onClick: () => confirmState[1](false) },
                t.cancel,
              )
            : null,
          summary && summary.path
            ? h(ui.Button, { key: 'copy', onClick: copyPath }, t.copyPath)
            : null,
        )
        body.push(h('div', { key: 'toolbar', style: { marginTop: '10px' } }, toolbar))

        if (note !== '') {
          body.push(
            h(
              'div',
              { key: 'note', style: { marginTop: '8px', fontSize: '12.5px', color: STYLE.dim } },
              note,
            ),
          )
        }

        if (summary && summary.path) {
          body.push(
            h(
              'div',
              {
                key: 'path',
                style: {
                  marginTop: '8px',
                  fontSize: '12px',
                  fontFamily: STYLE.mono,
                  color: STYLE.muted,
                  wordBreak: 'break-all',
                },
              },
              String(summary.path),
            ),
          )
        }

        if (isEmpty(summary)) {
          body.push(
            h(
              'div',
              { key: 'empty', style: { marginTop: '10px', fontSize: '13px', color: STYLE.muted } },
              t.empty,
            ),
          )
        } else {
          body.push(
            h(
              'div',
              { key: 'entries', style: { marginTop: '2px' } },
              summary.entries.map(recordRow),
            ),
          )
        }

        if (page) {
          return h('div', null, body)
        }

        // Outside the Plugins page the card keeps its own header, so it reads
        // as a self-contained panel wherever a host mounts it.
        return h(
          'div',
          {
            style: {
              border: STYLE.border,
              background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
              borderRadius: '12px',
              padding: '14px 16px',
            },
          },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
          h('div', { style: { color: STYLE.muted, fontSize: '13px', lineHeight: 1.5 } }, t.subtitle),
          h('div', { style: { marginTop: '10px' } }, body),
        )
      }
    }

    /**
     * Take the optional services and mount the card where they exist.
     * @param ctx - the client half's cordis context.
     */
    function registerCard(ctx) {
      // Reaching for an undeclared service throws in cordis, so each optional
      // dependency rides a scoped ctx.inject of its own: the closure runs where
      // the service exists and never runs where it does not.
      if (typeof ctx.inject !== 'function') return

      // Locale gets an inject of its own and fills a handle the card reads
      // later. Listing it beside `slots` would be worse than useless:
      // ctx.inject waits for every service named, so on a host that never
      // provides locale the card would never register at all.
      var localeRef = { current: null }
      ctx.inject(['locale'], (scope) => {
        localeRef.current = scope.locale
        if (typeof scope.effect === 'function') {
          scope.effect(
            () => () => {
              localeRef.current = null
            },
            'reasoning-loop-guard: locale handle',
          )
        }
      })

      ctx.inject(['slots'], (scope) => {
        // The card and the host route live and die together: with no web
        // profile the route is absent and a card could only render an error,
        // which is not what "no web profile" means. Any response at all proves
        // the route exists; only a 404 or 403 reads as absent — 403 is the
        // route's same-origin loopback fence turning this page away, which is
        // just as permanent.
        fetch(ROUTE + '?limit=1')
          .then((response) => {
            if (response.status === 404 || response.status === 403) return
            try {
              mountCard(scope, localeRef)
            } catch (error) {
              console.error(`[reasoning-loop-guard] log card skipped: ${error}`)
            }
          })
          .catch(() => {})
      })
    }

    /**
     * Require the seeds and claim the Plugins-page slot.
     * @param ctx - the injected scope carrying `slots`.
     * @param localeRef - `{current}` handle on the locale service.
     */
    function mountCard(ctx, localeRef) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error(`[reasoning-loop-guard] log card skipped: ${error}`)
        return
      }
      var ui
      try {
        ui = require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (error) {
        console.error(`[reasoning-loop-guard] log card skipped: ${error}`)
        return
      }
      var Card = LoopGuardCard(react, ui, localeRef)
      // dsh 0.1.7 moved plugin configuration to the Plugins page, which shows a
      // bundle's form from plugins.bundle.config keyed by its package name.
      // slots.inject waits for a slot to be declared.
      ctx.slots.inject('plugins.bundle.config', function* () {
        yield ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-reasoning-loop-guard' },
          Card,
        )
      })
    }

    /**
     * Client-half entry point.
     * @param ctx - the client half's cordis context.
     */
    function apply(ctx) {
      registerCard(ctx)
    }

    exports.apply = apply
    exports.name = 'reasoning-loop-guard-log-card'
    // Exposed for this repo's tests only; not part of the plugin contract.
    exports.__card = {
      ROUTE,
      PAGE_LIMIT,
      STRINGS,
      labelsFor,
      fill,
      formatWhen,
      measureOf,
      whereOf,
      countsText,
      isEmpty,
      LoopGuardCard,
      registerCard,
      mountCard,
    }
    // `slots` and `locale` are both optional, so neither is required here:
    // registerCard takes each on its own scoped inject.
    exports.inject = []
    return module.exports
  },
})
