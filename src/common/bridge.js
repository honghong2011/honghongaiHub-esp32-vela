// ============================================================
// bridge.js · interconnect 蓝牙桥接封装（全 App 唯一出口）
// ------------------------------------------------------------
// 职责：
//   1. v3 JSON 信封封装/解析（自动处理 {"json":"..."} 系统嵌套）
//   2. 链路状态机（linkReady 缓存，1006/202/204 分类处理）
//   3. type 路由分发（on/off 注册回调）
//   4. 心跳 pong 自动应答
//   5. 大消息自动分包（chat_req_start/part，单帧 ≤2000B）
//   6. 上行分包接收拼装（providers_push 逐条收集）
// 链路经验（实测结论）：
//   - send 需 obj 形式 {json:"..."}（本机验证可用）
//   - 1006 = 链路断开（不可重试）；202/204 = 瞬态（热身后重试）
//   - 发送前查 linkReady 缓存，断开直接失败不白发
// ============================================================

import { saveProviders } from './store'

// 单帧业务 JSON 安全线（协议硬限 4096B - 68B 包装开销，再留余量）
const FRAME_SAFE_BYTES = 2000

// 链路与实例状态（模块级单例，跨页面共享）
let _connect = null
let _linkReady = false
let _sendMode = 'obj'          // 已验证的发送形式
let _listeners = {}            // { type: [handler,...] }
let _stateListeners = []       // 链路状态变化回调
let _inited = false
let _lastHelloMs = 0           // watch_hello 节流（8s 内不重复发）

// 上行分包接收状态（providers_push 逐条收集）
let _pushCollector = { ver: -1, total: 0, received: [], active: false }

// 供应商内存缓存（推送收齐 / providers 页加载 storage 后更新；
// 数据主权在 storage 与 providers 页，此缓存仅供会话内快速读取）
let _providersCache = []

// 设置供应商缓存（providers 页与 _collectPush 调用）
export function setProvidersCache(list) {
  _providersCache = Array.isArray(list) ? list : []
}

// ------------------------------------------------------------
// 初始化（App 内可多次调用：每次都会重新注册回调，
// 因为 debug 页会临时抢占 onmessage，返回时调用本函数恢复）
// ------------------------------------------------------------
export function initBridge() {
  // eslint-disable-next-line no-undef
  const interconnect = require('@system.interconnect')
  if (!_connect) _connect = interconnect.instance()
  _inited = true

  _connect.onopen = () => {
    _linkReady = true
    _notifyState(true)
    // 链路恢复即打招呼：ESP32 标记手表在线并补推 pending 供应商
    _sendWatchHello()
  }
  _connect.onclose = () => {
    _linkReady = false
    _notifyState(false)
  }
  _connect.onerror = (data) => {
    // 1006 = 连接断开：链路不可用
    if (data && data.code === 1006) {
      _linkReady = false
      _notifyState(false)
    }
  }
  // 统一收包入口：解嵌套 → JSON 解析 → type 路由
  _connect.onmessage = (data) => {
    _handleRaw(data.data)
  }
  // 已打开的链路不会再触发 onopen：初始化时主动打一次招呼（节流保护）
  _sendWatchHello()
}

function _notifyState(ready) {
  for (let i = 0; i < _stateListeners.length; i++) {
    try { _stateListeners[i](ready) } catch (e) { /* 回调异常不阻断 */ }
  }
}

// ------------------------------------------------------------
// 链路状态查询
// ------------------------------------------------------------
export function isLinkReady() {
  return _linkReady
}

export function onLinkState(handler) {
  if (_stateListeners.indexOf(handler) === -1) _stateListeners.push(handler)
  return handler
}

export function offLinkState(handler) {
  const idx = _stateListeners.indexOf(handler)
  if (idx >= 0) _stateListeners.splice(idx, 1)
}

// 主动查询真实链路状态（热身/校正缓存用）
export function checkLink() {
  if (!_connect) return
  _connect.getReadyState({
    success: (data) => {
      const ready = data.status === 1
      if (ready !== _linkReady) {
        _linkReady = ready
        _notifyState(ready)
      }
    },
    fail: () => { /* 查询失败保持现状 */ }
  })
}

// ------------------------------------------------------------
// type 路由
// ------------------------------------------------------------
export function on(type, handler) {
  if (!_listeners[type]) _listeners[type] = []
  _listeners[type].push(handler)
}

export function off(type, handler) {
  const arr = _listeners[type]
  if (!arr) return
  const idx = arr.indexOf(handler)
  if (idx >= 0) arr.splice(idx, 1)
}

// ------------------------------------------------------------
// 收包处理：兼容 Object / str / {"json":"..."} 三种封装
// ------------------------------------------------------------
function _handleRaw(text) {
  if (typeof text === 'object' && text !== null) {
    try { text = JSON.stringify(text) } catch (e) { text = String(text) }
  }
  if (typeof text !== 'string' || !text) return

  let msg = null
  try { msg = JSON.parse(text) } catch (e) {
    console.log('bridge: JSON parse fail: ' + text.substring(0, 80))
    return
  }
  if (!msg || typeof msg !== 'object') return

  // 系统嵌套封装 {"json":"{\"v\":3,...}"}：取内层重新解析
  if (typeof msg.json === 'string' && msg.json) {
    try { msg = JSON.parse(msg.json) } catch (e) {
      console.log('bridge: nested parse fail')
      return
    }
    if (!msg || typeof msg !== 'object') return
  }

  const type = msg.type || ''
  if (!type) return

  // 心跳 pong 自动应答（不通知业务层）
  if (type === 'ping') {
    _sendDirect('pong', { ok: true, from: 'watch' })
    return
  }

  // 上行分包收集：providers_push 逐条收集，收齐整体派发
  if (type === 'providers_push') {
    _collectPush(msg.payload || {})
    return
  }

  _dispatch(type, msg)
}

function _dispatch(type, msg) {
  const arr = _listeners[type]
  if (!arr) return
  for (let i = 0; i < arr.length; i++) {
    try { arr[i](msg.payload || {}, msg) } catch (e) {
      console.log('bridge handler error type=' + type + ': ' + e)
    }
  }
}

// providers_push 分包收集：收齐 total 条后合成完整列表派发
function _collectPush(payload) {
  const ver = payload.ver || 0
  const total = payload.total || 0
  const provider = payload.provider || null

  // 新一轮推送（ver 变化）：重置收集器
  if (!_pushCollector.active || _pushCollector.ver !== ver) {
    _pushCollector = { ver: ver, total: total, received: [], active: true }
  }
  if (provider) _pushCollector.received.push(provider)

  if (_pushCollector.received.length >= total) {
    const providers = _pushCollector.received
    _providersCache = providers
    // 常驻落盘：无论当前停在哪个页面，推送收齐即持久化
    // （此前落盘只挂在 providers 页 handler 上，页面不在场时数据丢失）
    saveProviders(providers)
    _pushCollector = { ver: -1, total: 0, received: [], active: false }
    // 通知业务层完整列表（type 仍为 providers_push，payload 带完整数组）
    _dispatch('providers_push', { type: 'providers_push', payload: { ver: ver, providers: providers } })
    // 回 ack
    _sendDirect('providers_ack', { ok: true, ver: ver, received: providers.length })
  }
}

// ------------------------------------------------------------
// 发送（核心）
// ------------------------------------------------------------
// watch_hello：链路可用时向 ESP32 打招呼（节流 8s）。
// ESP32 收到后标记手表在线，并补推 pending 的供应商配置。
// 以前只有 debug/setting 页会发，导致 Web 推送后无人触发补推。
function _sendWatchHello() {
  const now = Date.now()
  if (now - _lastHelloMs < 8000) return
  _lastHelloMs = now
  _sendDirect('watch_hello', { from: 'watch' })
}

// 业务层统一入口：send(type, payloadObj)
// 返回 true=已提交发送（不代表对端收到）；false=链路断开未发送
export function send(type, payloadObj) {
  return _sendDirect(type, payloadObj)
}

function _sendDirect(type, payloadObj) {
  if (!_connect) return false
  // 链路断开：不白发（异步查一次真实状态，可能已恢复）
  if (!_linkReady) {
    checkLink()
    return false
  }
  const text = JSON.stringify({
    v: 3,
    id: 'w' + Date.now(),
    timestamp: Date.now(),
    type: type,
    payload: payloadObj || {}
  })
  _trySend(text, 0)
  return true
}

// 带重试的底层发送：瞬态失败(202/204)热身后重试一次；1006 标记断开
function _trySend(text, attempt) {
  const payload = _sendMode === 'str' ? text : { json: text }
  _connect.send({
    data: payload,
    success: () => {
      _linkReady = true
    },
    fail: (data, code) => {
      console.log('bridge TX FAIL code=' + code + ' attempt=' + attempt)
      if (code === 1006) {
        _linkReady = false
        _notifyState(false)
        return
      }
      // 瞬态失败：热身后重试一次
      if (attempt === 0) {
        checkLink()
        setTimeout(() => {
          if (_linkReady) _trySend(text, 1)
        }, 800)
      }
    }
  })
}

// ------------------------------------------------------------
// 大消息自动分包：chat_req（超 2000B 切 start/part）
// ------------------------------------------------------------
// provider: 供应商对象 {id, name, baseUrl, apiKey, models}（数据主权在手表，
// baseUrl/apiKey 随每次请求发给 ESP32，ESP32 不落盘）
// messages: [{role, content},...]；按条切分，单条超长时按字符切
export function sendChatRequest(cid, provider, model, messages) {
  const head = JSON.stringify({
    cid: cid,
    provider: provider ? provider.id : '',
    model: model,
    baseUrl: provider ? provider.baseUrl : '',
    apiKey: provider ? provider.apiKey : ''
  })
  const overhead = 60 // 信封+type+字段名开销估算
  const payloadBase = {
    cid: cid,
    provider: provider ? provider.id : '',
    model: model,
    baseUrl: provider ? provider.baseUrl : '',
    apiKey: provider ? provider.apiKey : ''
  }
  const single = JSON.stringify({
    v: 3, id: 'w' + Date.now(), timestamp: Date.now(),
    type: 'chat_req',
    payload: Object.assign({}, payloadBase, { messages: messages })
  })

  if (single.length <= FRAME_SAFE_BYTES) {
    _sendDirect('chat_req', Object.assign({}, payloadBase, { messages: messages }))
    return true
  }

  // 分包：start 携带 baseUrl/apiKey（避免每 part 重复），parts 按条切
  const parts = []
  let current = []
  let currentLen = overhead + head.length
  for (let i = 0; i < messages.length; i++) {
    const mLen = JSON.stringify(messages[i]).length + 2
    if (currentLen + mLen > FRAME_SAFE_BYTES && current.length > 0) {
      parts.push(current)
      current = []
      currentLen = overhead + head.length
    }
    current.push(messages[i])
    currentLen += mLen
  }
  if (current.length > 0) parts.push(current)

  // 发送 start（携带 parts 总数 + baseUrl/apiKey）+ parts
  const startPayload = Object.assign({}, payloadBase, { parts: parts.length })
  _sendDirect('chat_req_start', startPayload)
  for (let p = 0; p < parts.length; p++) {
    // 串行发送（间隔 60ms 防止瞬态失败集中出现）
    setTimeout(() => {
      _sendDirect('chat_req_part', { cid: cid, part: p + 1, messages: parts[p] })
    }, 60 * (p + 1))
  }
  return true
}

// ------------------------------------------------------------
// 上下文构建（system 首尾双置）
// ------------------------------------------------------------
export const SYSTEM_PROMPT =
  '你运行在小屏幕手表上。请用纯文本回答，禁止使用 Markdown、代码块、LaTeX 公式、表格。回答简洁。'

// baseMessages: [system, u1, a1, ..., 最新user]（不含尾部 system）
// 返回发送用的 messages（尾部追加同内容 system）
export function buildContext(baseMessages) {
  const out = baseMessages.slice()
  out.push({ role: 'system', content: SYSTEM_PROMPT })
  return out
}
