// ============================================================
// store.js · 手表本地存储封装
// ------------------------------------------------------------
// 配置（system.storage 键值）：
//   providers  供应商列表 JSON 串
//   current    当前选择 {provider, model}
//   esp32_ip   ESP32 的 STA IP（wifi_status 推送时更新）
// 聊天记录（system.file JSONL 追加）：
//   internal://files/chat/records.jsonl
//   每行: {"t":时间戳,"cid":"..","role":"user|assistant|divider|error","text":".."}
// 读写策略：
//   - 追加写（append）；读全量后内存切行（文件 ≤256KB 可接受）
//   - 超 256KB 从头部裁剪重写（保留后半）
// ============================================================

// eslint-disable-next-line no-undef
const storage = require('@system.storage')
// eslint-disable-next-line no-undef
const file = require('@system.file')

const CHAT_URI = 'internal://files/chat/records.jsonl'
const MAX_CHAT_BYTES = 256 * 1024

// ------------------------------------------------------------
// 配置：供应商列表
// ------------------------------------------------------------
export function loadProviders(cb) {
  storage.get({
    key: 'providers',
    success: (data) => {
      try {
        const arr = data ? JSON.parse(data) : []
        cb(arr)
      } catch (e) { cb([]) }
    },
    fail: () => cb([])
  })
}

export function saveProviders(providers) {
  storage.set({
    key: 'providers',
    value: JSON.stringify(providers || []),
    success: () => {},
    fail: (data, code) => console.log('saveProviders fail ' + code)
  })
}

// ------------------------------------------------------------
// 配置：当前选择
// ------------------------------------------------------------
export function loadCurrent(cb) {
  storage.get({
    key: 'current',
    success: (data) => {
      try {
        cb(data ? JSON.parse(data) : { provider: '', model: '' })
      } catch (e) { cb({ provider: '', model: '' }) }
    },
    fail: () => cb({ provider: '', model: '' })
  })
}

export function saveCurrent(current) {
  storage.set({
    key: 'current',
    value: JSON.stringify(current || {}),
    success: () => {},
    fail: () => {}
  })
}

// ------------------------------------------------------------
// 配置：ESP32 IP（wifi_status 推送时更新）
// ------------------------------------------------------------
export function saveEspIp(ip) {
  storage.set({ key: 'esp32_ip', value: ip || '', success: () => {}, fail: () => {} })
}

export function loadEspIp(cb) {
  storage.get({
    key: 'esp32_ip',
    success: (data) => cb(data || ''),
    fail: () => cb('')
  })
}

// ------------------------------------------------------------
// 聊天记录：JSONL
// ------------------------------------------------------------

// 追加一条记录
// role: 'user' | 'assistant' | 'divider' | 'error'
export function appendRecord(role, text, cid) {
  const line = JSON.stringify({ t: Date.now(), cid: cid || '', role: role, text: text })
  file.writeText({
    uri: CHAT_URI,
    text: line + '\n',
    append: true,
    success: () => {},
    fail: (data, code) => console.log('appendRecord fail ' + code)
  })
}

// 读取全部记录（解析为数组，时间升序）
// cb(records)  records: [{t, cid, role, text}, ...]（含解析失败容错）
export function readAllRecords(cb) {
  file.readText({
    uri: CHAT_URI,
    success: (data) => {
      cb(_parseLines(data.text || ''))
    },
    fail: (data, code) => {
      // 301 = 文件不存在：首次使用
      cb([])
    }
  })
}

// 读取最近 count 条（用于首屏，从尾部取）
export function readRecentRecords(count, cb) {
  readAllRecords((all) => {
    cb(all.length > count ? all.slice(all.length - count) : all)
  })
}

function _parseLines(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj && obj.role) out.push(obj)
    } catch (e) { /* 坏行跳过 */ }
  }
  return out
}

// 裁剪：文件超限时保留后半（从头删一半的行数）
export function trimChatIfNeeded() {
  file.get({
    uri: CHAT_URI,
    success: (data) => {
      if (!data || data.length <= MAX_CHAT_BYTES) return
      file.readText({
        uri: CHAT_URI,
        success: (rd) => {
          const lines = (rd.text || '').split('\n')
          const keep = lines.slice(Math.floor(lines.length / 2))
          // 先写临时再覆盖（writeText 非 append 模式直接覆盖）
          file.writeText({
            uri: CHAT_URI,
            text: keep.join('\n'),
            success: () => console.log('chat trimmed'),
            fail: (d, code) => console.log('trim write fail ' + code)
          })
        },
        fail: () => {}
      })
    },
    fail: () => {} // 文件不存在无需裁剪
  })
}

// 清空全部聊天记录（新对话不调用此函数——新对话只插分割线；
// 本函数留给设置页的"清空记录"功能）
export function clearAllRecords() {
  file.delete({
    uri: CHAT_URI,
    success: () => {},
    fail: () => {}
  })
}
