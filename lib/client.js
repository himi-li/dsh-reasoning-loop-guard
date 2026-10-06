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

    /**
     * Entry count requested per load.
     *
     * A hundred, not everything: the journal is a post-mortem surface and the
     * newest fires are the ones being explained, while a long-running profile
     * can accumulate hundreds. The route clamps well above this, so the cap is
     * the card's own choice and the toolbar says when it bit.
     */
    var PAGE_LIMIT = 100

    // Mirrors EFFORT_VALUES in lib/settings.js. Duplicated on purpose: this file
    // is served to the browser and cannot import the host half, and a mismatch
    // only ever shows up as a rejected save with the host's reason.
    var EFFORT_VALUES = ['off', 'low', 'high', 'max']

    /** Rule names the journal can carry. Mirrors REPEAT_RULES in lib/detector.js. */
    var REPEAT_RULES = ['periodic-run', 'block-repeat', 'line-repeat', 'kgram-repeat', 'filler-run']

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
        chars: 'chars',
        route: 'route',
        disabled: 'The journal is disabled in this profile (journal: false).',
        session: 'session',
        attempt: 'attempt',
        code: 'code',
        version: 'version',
        purpose: 'purpose',
        sinceStart: 'sinceStart',
        thresholds: 'Thresholds in force',
        previewLabel: 'preview',
        rawLabel: 'raw',
        blankPreview: 'whitespace only',
        truncated: 'Showing the newest {shown} of {matched} matched ({total} on file).',
        matched: '{matched} matched of {total} on file.',
        settings: 'Settings',
        settingsHint: 'Saved to the plugin’s own config file and applied to the next request — no restart.',
        settingsPath: 'file',
        recoveryLabel: 'Recovery',
        recoveryHint: 'After the guard aborts a stream, append a corrective message and retry the step.',
        recoveryMessage: 'Corrective message',
        recoveryMessagePlaceholder: 'Leave blank to use the built-in wording.',
        recoveryMaxRetries: 'Retries per step',
        effortLabel: 'Lower reasoning effort',
        effortHint: 'Ask for a shorter chain of thought on the request that follows a loop.',
        effortValue: 'Effort level',
        stripLabel: 'Strip historical reasoning',
        stripHint: 'Stop replaying finished turns’ reasoning to DeepSeek; other providers are left alone.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Settings saved',
        saveFailed: 'Could not save settings',
        unsaved: 'Unsaved changes',
        showDetail: 'Details',
        hideDetail: 'Hide details',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        on: 'On',
        off: 'Off',
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
        chars: '字符',
        route: '接口',
        disabled: '当前配置关闭了日志（journal: false）。',
        session: '会话',
        attempt: '尝试',
        code: '代码',
        version: '版本',
        purpose: '用途',
        sinceStart: '总耗时',
        thresholds: '当时的判定阈值',
        previewLabel: '重复片段',
        rawLabel: '原文',
        blankPreview: '纯空白',
        truncated: '显示最新的 {shown} 条，共命中 {matched} 条（文件内 {total} 条）。',
        matched: '命中 {matched} 条，文件内共 {total} 条。',
        settings: '功能开关',
        settingsHint: '保存到插件自己的配置文件，下一次请求即生效——不需要重启。',
        settingsPath: '配置文件',
        recoveryLabel: '自动恢复',
        recoveryHint: '守卫中断一次流之后，追加一条纠正消息并重跑同一步。',
        recoveryMessage: '纠正消息',
        recoveryMessagePlaceholder: '留空则使用内置文案。',
        recoveryMaxRetries: '每步重试次数',
        effortLabel: '降低思考强度',
        effortHint: '在循环之后的那次请求上要求更短的思维链。',
        effortValue: '强度档位',
        stripLabel: '剥离历史思维链',
        stripHint: '不再把已完成轮次的思维链回传给 DeepSeek；其他模型一概不动。',
        save: '保存',
        saving: '保存中…',
        saved: '设置已保存',
        saveFailed: '保存设置失败',
        unsaved: '有未保存的改动',
        showDetail: '详情',
        hideDetail: '收起详情',
        expandAll: '全部展开',
        collapseAll: '全部收起',
        on: '开',
        off: '关',
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
      if (entry.rule === 'block-repeat') {
        return 'block=' + String(entry.blockLen) + ' · reuses=' + String(entry.count)
      }
      if (entry.rule === 'line-repeat') {
        var parts = ['line=' + String(entry.lineLen), 'reuses=' + String(entry.count)]
        if (Number.isFinite(entry.share)) parts.push('share=' + (entry.share * 100).toFixed(1) + '%')
        return parts.join(' · ')
      }
      if (entry.rule === 'filler-run') {
        return 'run=' + String(entry.count) + ' chars'
      }
      if (Number.isFinite(entry.count)) return 'count=' + String(entry.count)
      return ''
    }

    /**
     * The provenance line under one fire: what the model was asked with, where
     * the session was running, and how long the stream lived before the abort.
     *
     * The point of the journal is post-mortem, so the card shows the fields the
     * journal gained for it; older records simply carry fewer of them.
     * @param entry - a journal record.
     * @returns display text, or an empty string when the record has nothing.
     */
    function detailOf(entry) {
      if (!entry || typeof entry !== 'object') return ''
      var parts = []
      var at = (label, value) => {
        if (value === undefined || value === null || value === '') return
        parts.push(label + '=' + String(value))
      }
      at('turn', entry.turn)
      at('step', entry.step)
      at('effort', entry.reasoningEffort)
      at('maxTokens', entry.maxTokens)
      at('temp', entry.temperature)
      if (Number.isFinite(entry.elapsedMs)) parts.push('elapsed=' + String(entry.elapsedMs) + 'ms')
      if (Number.isFinite(entry.ttftMs)) parts.push('ttft=' + String(entry.ttftMs) + 'ms')
      if (Number.isFinite(entry.reasoningChars)) {
        parts.push('reasoning=' + String(entry.reasoningChars) + 'chars')
      }
      at('cwd', entry.cwd)
      return parts.join('  ·  ')
    }

    /**
     * The identity line under one fire: which attempt, in which session, under
     * which build of the plugin, and with which failure code it ended.
     *
     * Kept apart from {@link detailOf} because the two answer different
     * questions — that one is "how did the model run", this one is "which fire
     * am I looking at" — and a single merged line stops being scannable.
     * @param entry - a journal record.
     * @returns display text, or an empty string when the record has nothing.
     */
    function originOf(entry) {
      if (!entry || typeof entry !== 'object') return ''
      var parts = []
      var at = (label, value) => {
        if (value === undefined || value === null || value === '') return
        parts.push(label + '=' + String(value))
      }
      at('code', entry.failureCode)
      at('attempt', entry.attemptId)
      at('session', entry.sessionId)
      at('purpose', entry.purpose)
      at('version', entry.pluginVersion)
      if (entry.aborted === true) parts.push('aborted=user')
      if (Number.isFinite(entry.fromStartMs)) {
        parts.push('sinceStart=' + String(entry.fromStartMs) + 'ms')
      }
      return parts.join('  ·  ')
    }

    /**
     * The thresholds that were in force at fire time, as one compact line.
     *
     * Recorded per fire precisely so an old record still explains itself after
     * the tunables have been changed; older records carry no snapshot and
     * render nothing.
     * @param entry - a journal record.
     * @returns display text, or an empty string when there is no snapshot.
     */
    function thresholdsOf(entry) {
      var thresholds = entry && entry.thresholds
      if (!thresholds || typeof thresholds !== 'object') return ''
      var keys = Object.keys(thresholds)
      if (keys.length === 0) return ''
      return keys
        .map((key) => key + '=' + String(thresholds[key]))
        .join('  ·  ')
    }

    /**
     * A preview string made safe to display.
     *
     * A fire can land on padding: one real record's repeating unit was eight
     * spaces, which renders as an empty-looking pair of quotes and reads like a
     * bug in the panel. Whitespace-only material is therefore labelled instead
     * of printed.
     * @param value - the raw preview string.
     * @param labels - the active dictionary, for the placeholder wording.
     * @returns the text to show.
     */
    function previewText(value, labels) {
      if (typeof value !== 'string' || value === '') return ''
      var blank = (labels && labels.blankPreview) || STRINGS.en.blankPreview
      return value.trim() === '' ? blank + ' (' + String(value.length) + ')' : value
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
        var draftState = react.useState(null)
        var savingState = react.useState(false)
        // Fold state for the record list. `mode` is the bulk setting and
        // `overrides` holds the rows the user opened or closed by hand, so a
        // single click survives a later "expand all" without the bulk control
        // having to know which rows were touched.
        var foldState = react.useState({ mode: 'newest', overrides: {} })
        var summary = summaryState[0]
        var note = noteState[0]
        var busy = busyState[0]
        var confirming = confirmState[0]
        var draft = draftState[0]
        var saving = savingState[0]
        var fold = foldState[0]

        /**
         * Whether one record's detail is showing.
         * @param key - the row's stable key.
         * @param index - its position, newest first.
         * @returns whether the detail block is drawn.
         */
        var isOpen = (key, index) => {
          if (Object.prototype.hasOwnProperty.call(fold.overrides, key)) {
            return fold.overrides[key] === true
          }
          if (fold.mode === 'all') return true
          if (fold.mode === 'none') return false
          // Default: the newest fire is the one being explained, so it starts
          // open and the rest stay folded.
          return index === 0
        }

        /** Flip one record open or closed, remembering the choice. */
        var toggle = (key, index) => {
          foldState[1]((current) => {
            var overrides = Object.assign({}, current.overrides)
            var nowOpen = Object.prototype.hasOwnProperty.call(overrides, key)
              ? overrides[key] === true
              : current.mode === 'all' || (current.mode === 'newest' && index === 0)
            overrides[key] = !nowOpen
            return { mode: current.mode, overrides }
          })
        }

        /** Open or close every record at once, discarding per-row choices. */
        var setAll = (mode) => foldState[1]({ mode, overrides: {} })

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

        // The draft is seeded from the server's values and only replaced when a
        // load brings a different payload, so a background refresh cannot erase
        // edits the user has not saved yet.
        var settings = summary && summary.settings ? summary.settings : null
        var seed = settings && settings.values ? settings.values : null
        react.useEffect(() => {
          if (seed === null) return
          draftState[1]((current) => (current === null ? Object.assign({}, seed) : current))
        }, [seed])

        /** Change one key of the draft. */
        var edit = react.useCallback(
          (key, value) => {
            draftState[1]((current) => {
              var next = Object.assign({}, current || seed || {})
              next[key] = value
              return next
            })
          },
          [seed],
        )

        var save = react.useCallback(() => {
          if (draft === null) return
          var id = ++gen.current
          savingState[1](true)
          fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'set', patch: draft }),
          })
            .then((response) =>
              response.json().then((body) => {
                if (!response.ok) throw new Error(body && body.error ? body.error : '')
                return body
              }),
            )
            .then((body) => {
              if (id !== gen.current) return
              savingState[1](false)
              noteState[1](t.saved)
              if (body && body.settings) {
                draftState[1](Object.assign({}, body.settings.values))
                summaryState[1]((current) =>
                  current === null ? current : Object.assign({}, current, { settings: body.settings }),
                )
              }
            })
            .catch((error) => {
              if (id !== gen.current) return
              savingState[1](false)
              noteState[1](String((error && error.message) || '') || t.saveFailed)
            })
        }, [draft, t.saved, t.saveFailed])

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

        /** One journal record, as a bordered row.
         *
         * The header line is always drawn; everything the post-mortem needs
         * (provenance, thresholds, the repeating material itself) sits behind a
         * fold. With a hundred records on screen an always-expanded list is
         * unreadable, but the detail still has to be one click away — the newest
         * record therefore starts open, and the toolbar can open or close all of
         * them at once.
         */
        var recordRow = (entry, index) => {
          var key = String(entry && entry.at) + '-' + String(index)
          var open = isOpen(key, index)
          var detail = detailOf(entry)
          var origin = originOf(entry)
          var thresholds = thresholdsOf(entry)
          var preview = entry && typeof entry.preview === 'string' && entry.preview !== ''
          var raw = entry && typeof entry.previewRaw === 'string' && entry.previewRaw !== ''
          var hasDetail = detail !== '' || origin !== '' || thresholds !== '' || preview || raw
          return h(
            'div',
            {
              key,
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
                onClick: () => toggle(key, index),
                role: 'button',
                'aria-expanded': open ? 'true' : 'false',
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '10px',
                  flexWrap: 'wrap',
                  fontSize: '12.5px',
                  cursor: hasDetail ? 'pointer' : 'default',
                },
              },
              h(
                'span',
                { style: { color: STYLE.muted, fontFamily: STYLE.mono, flex: 'none' } },
                hasDetail ? (open ? '▾' : '▸') : ' ',
              ),
              h('span', { style: { fontFamily: STYLE.mono } }, formatWhen(entry)),
              h(
                'span',
                {
                  style: {
                    color:
                      entry && entry.rule === 'kgram-repeat'
                        ? 'var(--dsw-alias-state-error-primary, #d64545)'
                        : 'var(--dsw-alias-state-warn-primary, #c98a00)',
                  },
                },
                String((entry && entry.rule) || '?'),
              ),
              h('span', { style: { color: STYLE.dim, fontFamily: STYLE.mono } }, measureOf(entry)),
              h(
                'span',
                { style: { color: STYLE.muted } },
                t.atChars + ' ' + String((entry && entry.atChars) ?? '?') + ' ' + t.chars,
              ),
              h('span', { style: { color: STYLE.muted, marginLeft: 'auto' } }, whereOf(entry)),
            ),
            open && detail !== ''
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: '4px',
                      fontSize: '11.5px',
                      fontFamily: STYLE.mono,
                      color: STYLE.dim,
                      wordBreak: 'break-all',
                    },
                  },
                  detail,
                )
              : null,
            open && origin !== ''
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: '2px',
                      fontSize: '11.5px',
                      fontFamily: STYLE.mono,
                      color: STYLE.muted,
                      wordBreak: 'break-all',
                    },
                  },
                  origin,
                )
              : null,
            open && preview
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
                  h('span', { style: { color: STYLE.muted } }, t.previewLabel + '  '),
                  '“' + previewText(entry.preview, t) + '”',
                )
              : null,
            open && raw
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: '2px',
                      fontSize: '12px',
                      fontFamily: STYLE.mono,
                      color: STYLE.dim,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    },
                  },
                  h('span', { style: { color: STYLE.muted } }, t.rawLabel + '  '),
                  '“' + previewText(entry.previewRaw, t) + '”',
                )
              : null,
            open && thresholds !== ''
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: '6px',
                      paddingTop: '6px',
                      borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      fontSize: '11px',
                      fontFamily: STYLE.mono,
                      color: STYLE.muted,
                      wordBreak: 'break-all',
                    },
                  },
                  h('span', null, t.thresholds + '  '),
                  thresholds,
                )
              : null,
          )
        }

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
              key: 'expand',
              disabled: busy || isEmpty(summary),
              onClick: () => setAll('all'),
            },
            t.expandAll,
          ),
          h(
            ui.Button,
            {
              key: 'collapse',
              disabled: busy || isEmpty(summary),
              onClick: () => setAll('none'),
            },
            t.collapseAll,
          ),
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

        // The switches, rendered as a plain section. Every control is a
        // controlled component fed from `draft`, and nothing reaches the host
        // until Save posts the whole patch, so a half-typed message is never
        // persisted.
        if (settings) {
          var value = (key, fallback) => {
            var source = draft || settings.values || {}
            var held = source[key]
            return held === undefined ? fallback : held
          }

          var dirty = false
          if (draft) {
            var keys = Object.keys(draft)
            for (var k = 0; k < keys.length; k += 1) {
              if (JSON.stringify(draft[keys[k]]) !== JSON.stringify((settings.values || {})[keys[k]])) {
                dirty = true
                break
              }
            }
          }

          /** A toggle line: label, hint, and the switch itself. */
          var switchLine = (key, label, hint) =>
            h(
              'div',
              {
                key: 'sw-' + key,
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '9px 0',
                  borderTop: STYLE.border,
                },
              },
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13px' } }, label),
                h('div', { style: { fontSize: '12px', color: STYLE.muted, lineHeight: 1.6 } }, hint),
              ),
              h(ui.Switch, {
                checked: value(key, false) === true,
                onChange: (next) => edit(key, next === true),
                label,
              }),
            )

          var panel = []

          panel.push(
            h(
              'div',
              { key: 'head', style: { marginTop: '16px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t.settings),
              h(
                'div',
                { style: { fontSize: '12px', color: STYLE.muted, lineHeight: 1.6, marginTop: '2px' } },
                t.settingsHint,
              ),
            ),
          )

          panel.push(switchLine('recovery.enabled', t.recoveryLabel, t.recoveryHint))
          if (value('recovery.enabled', false) === true) {
            panel.push(
              h(
                'div',
                { key: 'recovery-body', style: { padding: '2px 0 10px 0' } },
                h(
                  'div',
                  { style: { fontSize: '12px', color: STYLE.muted, marginBottom: '4px' } },
                  t.recoveryMessage,
                ),
                h(ui.Input, {
                  value: String(value('recovery.message', '')),
                  placeholder: t.recoveryMessagePlaceholder,
                  onChange: (event) => edit('recovery.message', event.target.value),
                }),
                h(
                  'div',
                  { style: { fontSize: '12px', color: STYLE.muted, margin: '8px 0 4px 0' } },
                  t.recoveryMaxRetries,
                ),
                h(ui.Input, {
                  type: 'number',
                  min: 0,
                  max: 10,
                  value: String(value('recovery.maxRetries', 2)),
                  onChange: (event) => {
                    var parsed = Number.parseInt(event.target.value, 10)
                    edit('recovery.maxRetries', Number.isSafeInteger(parsed) ? parsed : 0)
                  },
                }),
              ),
            )
          }

          panel.push(switchLine('effort.enabled', t.effortLabel, t.effortHint))
          if (value('effort.enabled', false) === true && ui.SegmentedControl) {
            panel.push(
              h(
                'div',
                { key: 'effort-body', style: { padding: '2px 0 10px 0' } },
                h(
                  'div',
                  { style: { fontSize: '12px', color: STYLE.muted, marginBottom: '4px' } },
                  t.effortValue,
                ),
                h(ui.SegmentedControl, {
                  id: 'reasoning-loop-guard-effort',
                  value: String(value('effort.value', 'low')),
                  options: EFFORT_VALUES.map((item) => ({ value: item, label: item })),
                  onChange: (next) => edit('effort.value', next),
                  label: t.effortValue,
                }),
              ),
            )
          }

          panel.push(switchLine('stripHistory.enabled', t.stripLabel, t.stripHint))

          panel.push(
            h(
              'div',
              { key: 'save', style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' } },
              h(
                ui.Button,
                { disabled: saving || !dirty, onClick: save },
                saving ? t.saving : t.save,
              ),
              h(
                'span',
                { style: { fontSize: '12.5px', color: STYLE.dim } },
                dirty ? t.unsaved : '',
              ),
            ),
          )

          if (settings.path) {
            panel.push(
              h(
                'div',
                {
                  key: 'settings-path',
                  style: {
                    marginTop: '6px',
                    fontSize: '12px',
                    fontFamily: STYLE.mono,
                    color: STYLE.muted,
                    wordBreak: 'break-all',
                  },
                },
                t.settingsPath + ' ' + String(settings.path),
              ),
            )
          }

          body.push(h('div', { key: 'settings', style: { marginTop: '2px' } }, panel))
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
      detailOf,
      originOf,
      thresholdsOf,
      previewText,
      whereOf,
      countsText,
      isEmpty,
      EFFORT_VALUES,
      REPEAT_RULES,
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
