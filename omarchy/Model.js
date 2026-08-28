// Pure data shaping for the Balances widget. No QML globals: the exact
// snapshot contract (CONTRACT.md) is exercised by Node in model.test.mjs.
// Money stays a decimal string end to end; the only "math" here is display
// formatting of pre-rendered strings and the percent numbers the CLI computed.

var MAX_PROVIDERS = 8
var PROVIDER_ORDER = ["openrouter", "vercel-ai", "elevenlabs", "openai-api", "anthropic-api"]
var SHORT_TAGS = {
  "openrouter": "OR",
  "vercel-ai": "VA",
  "elevenlabs": "EL",
  "openai-api": "OA",
  "anthropic-api": "AN"
}

function cleanText(value, maxLength) {
  var text = value === undefined || value === null ? "" : String(value)
  // The CLI sanitizes before writing; this second, cheap boundary keeps a
  // hand-edited snapshot from putting controls into a long-lived shell process.
  text = text.replace(/[\t\r]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  var limit = Number(maxLength) || 2048
  if (text.length <= limit) return text
  var end = limit - 1
  var finalCodeUnit = text.charCodeAt(end - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end--
  return text.slice(0, end) + "…"
}

// Shared Omarchy components use Text.AutoText. Replace angle brackets before
// passing provider-controlled strings into those components so they can never
// be reclassified as rich text (including an image tag with a remote URL).
function autoTextSafe(value) {
  return cleanText(value, 1000)
    .replace(/[\n\u2028\u2029]/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
}

function decimalString(value) {
  var text = String(value === undefined || value === null ? "" : value).trim()
  return /^-?\d{1,15}(\.\d{1,15})?$/.test(text) ? text : ""
}

function shortTag(id) {
  var tag = SHORT_TAGS[String(id || "")]
  if (tag) return tag
  return String(id || "??").slice(0, 2).toUpperCase()
}

// ---------------------------------------------------------------- snapshot

function normalizeBalance(raw) {
  if (!raw || typeof raw !== "object") return null
  var remaining = decimalString(raw.remaining)
  if (remaining === "") return null
  return {
    remaining: remaining,
    funded: decimalString(raw.funded),
    spent: decimalString(raw.spent),
    currency: cleanText(raw.currency, 12).trim() || "USD",
    estimated: raw.estimated === true
  }
}

function normalizeError(raw) {
  if (!raw || typeof raw !== "object") return null
  return {
    kind: cleanText(raw.kind, 40).trim(),
    message: cleanText(raw.message, 200).trim(),
    hint: cleanText(raw.hint, 200).trim()
  }
}

function normalizeProvider(raw) {
  if (!raw || typeof raw !== "object") return null
  var id = cleanText(raw.id, 60).trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null
  var status = ["ok", "error", "unconfigured"].indexOf(raw.status) >= 0 ? raw.status : "error"
  var severity = ["ok", "low", "critical", "unknown"].indexOf(raw.severity) >= 0 ? raw.severity : "unknown"
  var source = ["credits", "key-limit", "subscription", "ledger"].indexOf(raw.source) >= 0 ? raw.source : ""
  var percent = Number(raw.percentRemaining)
  var percentRemaining = raw.percentRemaining === null || raw.percentRemaining === undefined || !isFinite(percent)
    ? null : Math.max(0, Math.min(1, percent))
  return {
    id: id,
    name: cleanText(raw.name, 60).trim() || id,
    status: status,
    source: source,
    balance: normalizeBalance(raw.balance),
    percentRemaining: percentRemaining,
    severity: severity,
    resetsAt: cleanText(raw.resetsAt, 80).trim(),
    ledgerSince: cleanText(raw.ledgerSince, 80).trim(),
    detail: cleanText(raw.detail, 200).trim(),
    fetchedAt: cleanText(raw.fetchedAt, 80).trim(),
    stale: raw.stale === true,
    error: normalizeError(raw.error),
    hint: cleanText(raw.hint, 200).trim()
  }
}

function parseSnapshot(raw) {
  var failure = function(message) {
    return { ok: false, error: message, model: null }
  }
  var parsed
  try {
    parsed = JSON.parse(String(raw || ""))
  } catch (error) {
    return failure("snapshot.json is not valid JSON.")
  }
  if (!parsed || typeof parsed !== "object") return failure("snapshot.json is not an object.")
  if (parsed.schemaVersion !== 1) return failure("snapshot.json has an unsupported schemaVersion.")
  if (!Array.isArray(parsed.providers)) return failure("snapshot.json has no providers array.")
  var providers = []
  for (var i = 0; i < parsed.providers.length && providers.length < MAX_PROVIDERS; i++) {
    var provider = normalizeProvider(parsed.providers[i])
    if (provider) providers.push(provider)
  }
  if (parsed.providers.length > 0 && providers.length === 0)
    return failure("snapshot.json contains no valid provider row.")
  return {
    ok: true,
    error: "",
    model: {
      schemaVersion: 1,
      generatedAt: cleanText(parsed.generatedAt, 80).trim(),
      totalRemainingUsd: decimalString(parsed.totalRemainingUsd) || "0.00",
      anyEstimated: parsed.anyEstimated === true,
      attention: cleanText(parsed.attention, 60).trim(),
      providers: providers
    }
  }
}

// --------------------------------------------------------------- formatting

function formatMoney(value) {
  var match = /^(-?)(\d{1,15})(?:\.(\d{1,15}))?$/.exec(String(value === undefined || value === null ? "" : value).trim())
  if (!match) return ""
  var whole = match[2].replace(/^0+(?=\d)/, "")
  if (whole.length > 2 || Number(whole) >= 100) return match[1] + "$" + whole
  var cents = ((match[3] || "") + "00").slice(0, 2)
  return match[1] + "$" + whole + "." + cents
}

function formatCredits(value) {
  var match = /^(-?)(\d{1,15})$/.exec(String(value === undefined || value === null ? "" : value).trim())
  if (!match) return ""
  var count = Number(match[2])
  var text
  if (count >= 1000000) {
    var millions = count / 1000000
    text = (millions >= 100 ? Math.round(millions) : Math.round(millions * 10) / 10) + "M"
  } else if (count >= 1000) {
    var thousands = count / 1000
    text = (thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10) + "k"
  } else {
    text = String(count)
  }
  return match[1] + text + " cr"
}

function formatDuration(milliseconds) {
  if (!(milliseconds > 0)) return "now"
  var minutes = Math.floor(milliseconds / 60000)
  var hours = Math.floor(minutes / 60)
  var days = Math.floor(hours / 24)
  if (days > 0) return days + "d " + (hours % 24) + "h"
  if (hours > 0) return hours + "h " + (minutes % 60) + "m"
  return Math.max(1, minutes) + "m"
}

function formatReset(resetsAt, nowMs) {
  if (!resetsAt) return ""
  var resetMs = new Date(String(resetsAt)).getTime()
  if (!isFinite(resetMs)) return ""
  var remaining = resetMs - Number(nowMs)
  if (remaining <= 0) return "Reset due"
  return "Resets in " + formatDuration(remaining)
}

function formatUpdated(generatedAt, nowMs) {
  if (!generatedAt) return ""
  var generatedMs = new Date(String(generatedAt)).getTime()
  if (!isFinite(generatedMs)) return ""
  var elapsed = Math.max(0, Number(nowMs) - generatedMs)
  if (elapsed < 60000) return "updated just now"
  return "updated " + formatDuration(elapsed) + " ago"
}

// ---------------------------------------------------------------- selection

function findProvider(model, id) {
  if (!model) return null
  for (var i = 0; i < model.providers.length; i++)
    if (model.providers[i].id === id) return model.providers[i]
  return null
}

function configuredProviders(model) {
  if (!model) return []
  return model.providers.filter(function(p) { return p.status !== "unconfigured" })
}

function readyProviders(model) {
  if (!model) return []
  return model.providers.filter(function(p) { return p.status === "ok" && p.balance !== null })
}

function everyConfiguredErrored(model) {
  var configured = configuredProviders(model)
  if (configured.length === 0) return false
  return configured.every(function(p) { return p.status === "error" })
}

function worstProvider(model) {
  if (!model) return null
  var flagged = findProvider(model, model.attention)
  if (flagged) return flagged
  var ready = readyProviders(model)
  var best = null
  for (var i = 0; i < ready.length; i++) {
    var percent = ready[i].percentRemaining === null ? 2 : ready[i].percentRemaining
    var bestPercent = best === null || best.percentRemaining === null ? 2 : best.percentRemaining
    if (best === null || percent < bestPercent) best = ready[i]
  }
  return best
}

function cyclePinned(model, currentId, step) {
  var ids = model && model.providers.length > 0
    ? model.providers.map(function(p) { return p.id })
    : PROVIDER_ORDER.slice()
  var index = ids.indexOf(String(currentId || ""))
  if (index < 0) index = 0
  var next = ((index + (Number(step) || 1)) % ids.length + ids.length) % ids.length
  return ids[next]
}

// ------------------------------------------------------------------- pill

function providerValue(p) {
  if (!p || p.status === "unconfigured") return "—"
  if (!p.balance) return p.status === "error" ? "!" : "—"
  var text = p.balance.currency === "credits"
    ? formatCredits(p.balance.remaining)
    : formatMoney(p.balance.remaining)
  if (text === "") return "—"
  return (p.balance.estimated ? "~" : "") + text
}

function providerPillText(p, withLabel) {
  var value = providerValue(p)
  return withLabel === true ? shortTag(p ? p.id : "") + " " + value : value
}

function totalText(model) {
  // Zero configured providers (first run: every row unconfigured, or all
  // disabled) keeps the pre-snapshot placeholder — "$0.00" would read as an
  // empty account rather than "no keys yet".
  if (!model || configuredProviders(model).length === 0) return "$ …"
  var text = formatMoney(model.totalRemainingUsd)
  if (text === "") text = "$0.00"
  return (model.anyEstimated ? "~" : "") + text
}

function barText(model, mode, pinnedId, showLabel, vertical) {
  if (vertical === true) {
    if (!model || configuredProviders(model).length === 0) return "$"
    return everyConfiguredErrored(model) ? "!" : "$"
  }
  if (!model || configuredProviders(model).length === 0) return "$ …"
  if (everyConfiguredErrored(model)) return "$ !"
  if (mode === "attention") {
    var worst = worstProvider(model)
    return worst ? providerPillText(worst, true) : totalText(model)
  }
  if (mode === "pinned") {
    var pinned = findProvider(model, String(pinnedId || ""))
    return pinned ? providerPillText(pinned, showLabel === true) : totalText(model)
  }
  return totalText(model)
}

function alarming(model) {
  if (!model) return false
  return model.providers.some(function(p) {
    return p.severity === "critical" || p.status === "error"
  })
}

function allStale(model) {
  var ready = readyProviders(model)
  if (ready.length === 0) return false
  return ready.every(function(p) { return p.stale === true })
}

function anyUnconfigured(model) {
  if (!model) return false
  return model.providers.some(function(p) { return p.status === "unconfigured" })
}

function tooltipText(model, nowMs) {
  if (!model) return "Balances · waiting for first sync"
  var parts = ["Balances " + totalText(model)]
  var configured = configuredProviders(model)
  for (var i = 0; i < configured.length; i++)
    parts.push(providerPillText(configured[i], true))
  var updated = formatUpdated(model.generatedAt, nowMs)
  if (updated !== "") parts.push(updated)
  return autoTextSafe(parts.join(" · "))
}

function subtitle(model, nowMs) {
  if (!model) return "Waiting for first sync"
  var estimated = 0, stale = 0, errors = 0, unconfigured = 0
  for (var i = 0; i < model.providers.length; i++) {
    var p = model.providers[i]
    if (p.status === "ok" && p.balance && p.balance.estimated) estimated++
    if (p.stale) stale++
    if (p.status === "error") errors++
    if (p.status === "unconfigured") unconfigured++
  }
  var parts = []
  if (estimated > 0) parts.push(estimated + " estimated")
  if (stale > 0) parts.push(stale + " stale")
  if (errors > 0) parts.push(errors + (errors === 1 ? " error" : " errors"))
  if (unconfigured > 0) parts.push(unconfigured + " not configured")
  var updated = formatUpdated(model.generatedAt, nowMs)
  if (updated !== "") parts.push(updated)
  return parts.length > 0 ? parts.join(" · ") : "No providers enabled"
}

// -------------------------------------------------------------------- rows

function severityRole(severity) {
  if (severity === "critical") return "urgent"
  if (severity === "low") return "warning"
  if (severity === "ok") return "accent"
  return "dim"
}

function tierLabel(p) {
  if (!p) return ""
  if (p.source === "credits") return "Prepaid"
  if (p.source === "key-limit") return "Key limit"
  if (p.source === "subscription") return "Subscription"
  if (p.source === "ledger") return "Prepaid (est.)"
  return ""
}

function providerRow(p, nowMs) {
  if (!p) return null
  var sub = ""
  var note = ""
  var noteRole = "dim"
  if (p.status === "ok") {
    var subParts = []
    if (p.detail !== "") subParts.push(autoTextSafe(p.detail))
    var reset = formatReset(p.resetsAt, nowMs)
    if (reset !== "") subParts.push(reset)
    sub = subParts.join(" · ")
    if (p.stale) {
      var age = formatUpdated(p.fetchedAt, nowMs)
      note = "Cached data" + (age !== "" ? " · " + age : "")
      noteRole = "warning"
    }
  } else if (p.status === "error") {
    var errorParts = []
    if (p.error && p.error.message !== "") errorParts.push(autoTextSafe(p.error.message))
    if (errorParts.length === 0) errorParts.push("Fetch failed")
    if (p.error && p.error.hint !== "") errorParts.push(autoTextSafe(p.error.hint))
    note = errorParts.join(" · ")
    noteRole = "urgent"
  } else {
    note = p.hint !== "" ? autoTextSafe(p.hint) : "No API key configured"
    noteRole = "dim"
  }
  return {
    id: p.id,
    name: autoTextSafe(p.name),
    tier: tierLabel(p),
    value: providerValue(p),
    valueRole: p.status === "unconfigured" ? "dim" : (p.severity === "critical" ? "urgent" : ""),
    percent: p.status === "ok" && p.percentRemaining !== null ? p.percentRemaining : -1,
    meterRole: severityRole(p.severity),
    sub: sub,
    note: note,
    noteRole: noteRole,
    greyed: p.status === "unconfigured"
  }
}

function providerRows(model, nowMs) {
  if (!model) return []
  // Unconfigured providers are hidden once anything is configured — they
  // remain reachable through the Keys view. On a fresh install (nothing
  // configured yet) the full list doubles as the onboarding checklist.
  var hideUnconfigured = configuredProviders(model).length > 0
  var rows = []
  for (var i = 0; i < model.providers.length && i < MAX_PROVIDERS; i++) {
    if (hideUnconfigured && model.providers[i].status === "unconfigured") continue
    var row = providerRow(model.providers[i], nowMs)
    if (row) rows.push(row)
  }
  return rows
}

// ------------------------------------------------------------- key entry

// Static, non-secret metadata for the in-panel key entry view (KeysView.qml).
// URLs are fixed constants pointing at each provider's own console — the
// exact page that issues the key type the CLI needs.
var KEY_META = {
  "openrouter": {
    label: "OpenRouter",
    url: "https://openrouter.ai/settings/management-keys",
    note: "Management key; a regular key limits the widget to per-key data"
  },
  "vercel-ai": {
    label: "Vercel AI Gateway",
    url: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys",
    note: "AI Gateway API key (not a Vercel account token)"
  },
  "elevenlabs": {
    label: "ElevenLabs",
    url: "https://elevenlabs.io/app/developers/api-keys",
    note: "API key — enable only the User: Read scope"
  },
  "openai-api": {
    label: "OpenAI API",
    url: "https://platform.openai.com/settings/organization/admin-keys",
    note: "Admin key sk-admin-…",
    needsLedger: true
  },
  "anthropic-api": {
    label: "Anthropic API",
    url: "https://platform.claude.com/settings/admin-keys",
    note: "Admin key sk-ant-admin…; requires a Console organization",
    needsLedger: true
  }
}

function keyProviderIds() {
  return PROVIDER_ORDER.slice()
}

function providerKeyMeta(id) {
  var meta = KEY_META[String(id || "")]
  if (!meta) return null
  return {
    id: String(id),
    label: meta.label,
    url: meta.url,
    note: meta.note,
    needsLedger: meta.needsLedger === true
  }
}

// Configured state comes from the current snapshot only — no extra CLI call.
function providerConfigured(model, id) {
  var p = findProvider(model, String(id || ""))
  return p !== null && p.status !== "unconfigured"
}

// Snapshot-hint style: the full invocation, since the CLI is not on PATH.
function ledgerHint(cliPath, id) {
  return "Also needs a funded ledger: python3 " + cleanText(cliPath, 300).trim()
    + " ledger set " + String(id || "") + " --funded N --since YYYY-MM-DD"
}

// Row error for a failed `key set` / `key clear` run: the stderr tail,
// sanitized and capped, never echoing anything the user typed.
function keyCommandErrorMessage(exitCode, stderrText) {
  var code = Number(exitCode)
  if (code === 0) return ""
  if (code === 127)
    return "python3 was not found. Install it with: sudo pacman -S python"
  var text = cleanText(stderrText, 2000).trim()
  if (text === "") return "The key command failed (exit " + code + ")."
  var lines = text.split("\n").filter(function(line) { return line.trim() !== "" })
  return autoTextSafe(cleanText(lines.slice(-2).join(" · "), 300))
}

// ---------------------------------------------------------------- settings

function booleanSetting(value, fallback) {
  if (value === true || value === false) return value
  var normalized = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  if (["true", "1", "yes", "on"].indexOf(normalized) >= 0) return true
  if (["false", "0", "no", "off"].indexOf(normalized) >= 0) return false
  return fallback === true
}

function pillModeSetting(value) {
  var mode = String(value === undefined || value === null ? "" : value).trim()
  return ["total", "attention", "pinned"].indexOf(mode) >= 0 ? mode : "total"
}

function settingsWithOverrides(settings, moduleName, overrides) {
  var moduleId = cleanText(moduleName, 180).trim()
  if (moduleId === "" || !overrides || typeof overrides !== "object" || Array.isArray(overrides))
    return null
  var next = { id: moduleId }
  var current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}
  for (var key in current) {
    if (key === "id" || key === "__proto__" || key === "constructor" || key === "prototype") continue
    next[key] = current[key]
  }
  for (var overrideKey in overrides) {
    if (overrideKey === "id" || overrideKey === "__proto__" || overrideKey === "constructor"
        || overrideKey === "prototype") continue
    next[overrideKey] = overrides[overrideKey]
  }
  return next
}

// The panel launches the CLI through /usr/bin/env, so a missing python3 comes
// back as exit 127 instead of the process silently never starting. Reserved
// for 127 and unexpected codes; the contract's data outcomes (1, 2) are
// mapped by refreshStatusMessage instead.
function launchErrorMessage(exitCode, stderrText) {
  if (Number(exitCode) === 127)
    return "python3 was not found. Install it with: sudo pacman -S python"
  var message = cleanText(stderrText, 500).trim()
  return message === "" ? "The sync command failed without an error message." : autoTextSafe(message)
}

// Banner text for the refresh Process exit. Exit 1 (every configured provider
// errored) and 2 (config/secrets unreadable) are data outcomes — the snapshot
// rows carry the detail — so 1 shows nothing and 2 only a short pointer.
function refreshStatusMessage(exitCode, stderrText) {
  var code = Number(exitCode)
  if (code === 0 || code === 1) return ""
  if (code === 2) return "Configuration error — see provider rows."
  return launchErrorMessage(code, stderrText)
}
