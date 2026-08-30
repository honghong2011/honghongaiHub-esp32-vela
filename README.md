# 宏宏AIHub · 手表端（Vela 快应用）

> **English:** An AI chat quickapp for Xiaomi Vela wearables (Mi Band 10 Pro) — chat with OpenAI-compatible LLMs through your own ESP32 gateway over classic Bluetooth. No phone app, no cloud middleman.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

**中文说明 | 姐妹仓库（ESP32 固件）：`honghongaiHub-vela-esp32`**

## 这是什么

宏宏AIHub 的**手表端**，一个运行在小米手环 10 Pro 上的 Vela 快应用。它通过经典蓝牙 SPP 直连一块 ESP32 开发板，把你的消息转发给 OpenAI 兼容的大模型 API（DeepSeek / Kimi / GLM…），并以打字机效果流式显示回复——全程不经过手机，也不经过任何中间服务器。

```
小米手环 10 Pro（本仓库）↔ 经典蓝牙 SPP ↔ ESP32（固件仓库）↔ Wi-Fi ↔ LLM API
```

## 功能

- 💬 微信式聊天界面：气泡流、打字机效果、聊天记录本地保存（JSONL）
- ⌨️ 内置中文拼音键盘，支持扫描选网 / 手动输入等所有文本场景
- 🔌 多供应商 / 多模型管理，手表上一键切换
- 📶 在手表上直接给 ESP32 配网（扫描 WiFi 列表或手动输入）
- 🌐 Web 配置端入口：在电脑浏览器里管理 AI 供应商，一键推送到手环
- 🛠 内置链路调试页（收发统计、echo 测试）

## 硬件与系统

- 小米手环 10 Pro（其他 Vela 手表 / 手环可自行测试）
- 已配对好的 ESP32 网关（见姐妹仓库）

## 构建与安装

```bash
npm install
npm run build
```

构建产物 `dist/*.rpk` 用 AIoT-IDE 或手环开发者工具安装到手环即可。

## 使用流程

1. 完成 ESP32 固件侧的配对（见姐妹仓库 README 的「首次配置」）
2. 手表打开宏宏AIHub → 设置 → 扫描 WiFi，给 ESP32 配网
3. 电脑浏览器打开 ESP32 的 IP，填入 AI 供应商（地址 / API Key / 模型列表）→ 推送到手环
4. 手表端选择模型，开聊！

## 目录结构

```
src/
├── manifest.json          # 快应用配置（包名 com.honghong.aihub）
├── app.ux                 # 入口
├── pages/                 # chat / providers / setting / keyboard / debug
├── common/
│   ├── bridge.js          # 蓝牙桥接封装（分包/重试/心跳/链路状态机）
│   └── store.js           # 聊天记录 JSONL + 配置存储
└── components/InputMethod # 键盘组件（基于 NEORUAA/Vela_input_method，MIT）
```

## 许可证

[GPL-3.0](LICENSE)。键盘输入组件基于 [NEORUAA/Vela_input_method](https://github.com/NEORUAA/Vela_input_method)（MIT）。
