# PRD: Skill Management for purr-cli

## Introduction

purr-cli 目前是一个 calldata builder，作为 skill 供 OpenClaw 等 agent 使用。现在需要在 purr-cli 中集成 **skill 生命周期管理**能力，让 agent 可以从 Pieverse Skill Marketplace 发现、安装、卸载 skills。

Skill 是一个标准文件夹，包含 `SKILL.md`（含 YAML front matter 的指令文档）及可选的 references 子目录，遵循 [heurist skill 格式规范](https://github.com/heurist-network/heurist-skills-cli)。CLI 负责从 Marketplace 下载 ZIP 包并放置到正确位置。支持 project-level 和 global-level 两种安装范围，支持多 agent 生态（OpenClaw、Claude Code、Cursor 等）。

**参考实现**: [heurist-network/heurist-skills-cli](https://github.com/heurist-network/heurist-skills-cli)

## Goals

- 提供 `purr skill list` / `install` / `remove` 三个核心命令，实现 skill 的基本生命周期管理
- 支持 project-level（本地）和 global-level（全局）两种安装范围
- 支持多 agent 安装（同一 skill 可安装到多个 agent 的目录下）
- 通过 lock file 记录安装状态，确保可追溯和可复现
- 复用 purr-cli 现有的命令路由模式和代码风格，保持一致性

## User Stories

### US-001: 浏览 Marketplace 上的可用 Skills

**Description:** As an agent operator, I want to list available skills from the marketplace so that I can discover what skills are available for installation.

**Acceptance Criteria:**
- [ ] `purr skill list --remote` 从 Marketplace API 拉取并展示可用 skills 列表
- [ ] 每个 skill 显示: slug、name、description、category
- [ ] 支持 `--category <name>` 过滤特定分类
- [ ] 支持 `--search <term>` 关键词搜索
- [ ] API 请求失败时输出清晰的错误信息
- [ ] Typecheck / lint passes

### US-002: 查看已安装的 Skills

**Description:** As an agent operator, I want to see what skills are currently installed so that I can manage my skill inventory.

**Acceptance Criteria:**
- [ ] `purr skill list` 显示本地已安装的 skills
- [ ] `purr skill list --global` 显示全局已安装的 skills
- [ ] 每个 skill 显示: slug、name、安装时间、安装路径、关联的 agents
- [ ] 没有已安装 skills 时显示空状态提示
- [ ] Typecheck / lint passes

### US-003: 安装 Skill 到指定 Agent

**Description:** As an agent operator, I want to install a skill from the marketplace so that my agents can use it.

**Acceptance Criteria:**
- [ ] `purr skill install <slug>` 从 Marketplace 下载并安装 skill
- [ ] 不指定 `--agent` 时，自动检测已安装的 agents，交互式让用户选择目标 agent（多选）
- [ ] 支持 `--agent <name>` 指定目标 agent（可重复，安装到多个 agent），跳过交互选择
- [ ] 不提供 `<slug>` 时，交互式搜索 Marketplace 让用户选择要安装的 skill
- [ ] 支持 `--global` 安装到全局范围（默认 project-level）
- [ ] 默认使用 symlink 方式安装（canonical 目录 + symlink 到各 agent 目录）
- [ ] 支持 `--copy` 强制使用复制模式（兼容不支持 symlink 的环境）
- [ ] 安装后更新 lock file，记录 slug、name、sha256、安装时间、安装方式、agent 映射
- [ ] 下载后校验 SHA256 完整性（与 API response header 中的 hash 比对）
- [ ] 已安装的 skill 再次安装时提示已存在（或用 `--force` 覆盖）
- [ ] Typecheck / lint passes

### US-004: 卸载 Skill

**Description:** As an agent operator, I want to remove an installed skill so that I can clean up unused skills.

**Acceptance Criteria:**
- [ ] `purr skill remove <slug>` 卸载指定 skill
- [ ] 支持 `--agent <name>` 只从特定 agent 移除（保留其他 agent 的安装）
- [ ] 支持 `--global` 从全局范围移除
- [ ] 当所有 agent 都移除后，自动清理 canonical 目录
- [ ] 更新 lock file（移除对应条目，或更新 agent_installs）
- [ ] 移除前提示确认，支持 `--yes` 跳过确认
- [ ] Typecheck / lint passes

### US-005: Skill Marketplace API Client

**Description:** As a developer, I need an API client module to interact with the Pieverse Skill Marketplace.

**Acceptance Criteria:**
- [ ] 新建 `src/skill/api.ts`，封装 Marketplace API 调用
- [ ] 支持 `listSkills(options)` — 获取 skill 列表（支持 category、search、pagination）
- [ ] 支持 `getSkill(slug)` — 获取单个 skill 详情
- [ ] 支持 `downloadSkill(slug)` — 下载 skill 文件（返回 buffer + sha256）
- [ ] 支持 `checkUpdates(installed)` — 检查已安装 skills 的更新（为 V2 预留）
- [ ] Marketplace API base URL 可通过 `SKILL_MARKETPLACE_URL` 环境变量或 config 覆盖
- [ ] 错误处理：网络错误、404、非 200 响应均有清晰提示
- [ ] Typecheck / lint passes

### US-006: Lock File 管理

**Description:** As a developer, I need a lock file system to track installation state for reproducibility.

**Acceptance Criteria:**
- [ ] Project-level lock file: `./skills-lock.json`
- [ ] Global-level lock file: `~/.purrfectclaw/skills-lock.json`
- [ ] Lock entry 结构: `{ slug, name, sha256, installed_at, install_method, canonical_path, agent_installs }`
- [ ] 支持 CRUD 操作: read / write / upsert / remove
- [ ] 读取不存在的 lock file 时返回空数组（不报错）
- [ ] 写入时使用 atomic write（先写临时文件再 rename），防止写入中断导致损坏
- [ ] Typecheck / lint passes

### US-007: Agent 注册与目录检测

**Description:** As a developer, I need an agent registry that knows where each supported agent expects skills to be placed.

**Acceptance Criteria:**
- [ ] 新建 `src/skill/agents.ts`，定义支持的 agent 列表及其 skill 目录路径
- [ ] 初始支持的 agents: OpenClaw、Claude Code、Cursor、Windsurf（可扩展）
- [ ] 每个 agent 定义: name、skill 目录路径（local + global）、检测函数
- [ ] `detectInstalled()` 自动检测当前环境中已安装的 agents
- [ ] 未检测到任何 agent 时给出提示
- [ ] Typecheck / lint passes

### US-008: Skill 安装器（下载 + 解压 + 放置）

**Description:** As a developer, I need an installer module that handles downloading, extracting, and placing skill folders.

**Acceptance Criteria:**
- [ ] 新建 `src/skill/installer.ts`
- [ ] 从 API 下载 skill 压缩包（zip）
- [ ] 解压到 canonical 目录（local: `.skills/<slug>/`，global: `~/.purrfectclaw/skills/<slug>/`）
- [ ] 创建 symlink 从 agent 目录指向 canonical 目录（默认模式）
- [ ] 支持 copy 模式：直接复制到 agent 目录
- [ ] 解压时验证路径安全（防止 zip slip / path traversal 攻击）
- [ ] Symlink 创建失败时自动降级为 copy 模式
- [ ] Typecheck / lint passes

## Functional Requirements

- **FR-1**: 新增 `skill` 命令组，路由到 `src/skill/` 下的处理模块
- **FR-2**: `purr skill list` 展示已安装 skills（默认 local，`--global` 切换）
- **FR-3**: `purr skill list --remote` 展示 Marketplace 可用 skills（支持 `--search`、`--category`）
- **FR-4**: `purr skill install <slug>` 下载并安装 skill 到指定 agent 目录
- **FR-5**: `purr skill remove <slug>` 卸载 skill，清理文件和 lock file
- **FR-6**: 安装时自动检测已安装的 agents，让用户选择目标 agent
- **FR-7**: 通过 lock file 持久化安装状态（local + global 分别维护）
- **FR-8**: SHA256 完整性校验，确保下载文件未被篡改
- **FR-9**: 所有输出兼容 JSON 模式（`--json` flag），便于 agent 程序化解析
- **FR-10**: 命令路由沿用 `main.ts` 现有的 switch-case 模式

## Non-Goals (Out of Scope)

- **不做 skill 内容解析**: CLI 不关心 skill 文件夹内部结构，不校验内容格式
- **不做 skill 发布/上传**: V1 只做消费端（install/remove），发布走其他渠道
- **不做 update/upgrade 命令**: V1 用 remove + install 手动更新
- **不做 info/show 命令**: V1 用 `list --remote` 查看基本信息即可
- **不做 verification gate**: V1 不实现 skill 审核机制，Marketplace 上的 skill 默认可信
- **不做 skill 权限/能力声明 UI**: 不实现 heurist 的 capabilities 安全警告弹窗
- **不做 skill 版本管理**: V1 只关心最新版本，不支持安装指定版本
- **不做自动同步/watch**: 不监听 Marketplace 变更

## Technical Considerations

### 项目结构

```
src/
├── skill/                    # 新增: skill 管理模块
│   ├── api.ts               # Marketplace API client
│   ├── agents.ts            # Agent 注册表 + 目录检测
│   ├── installer.ts         # 下载 / 解压 / symlink / copy
│   ├── lock.ts              # Lock file CRUD
│   └── commands/            # 命令处理器
│       ├── list.ts          # list (local + remote)
│       ├── install.ts       # install
│       └── remove.ts        # remove
├── main.ts                  # 新增 'skill' case 到 switch router
└── ...existing files...
```

### 交互模式

purr-cli 支持交互式操作。当必要参数未通过 flags 提供时，CLI 应进入交互模式引导用户：

- `purr skill install`（无 slug）→ 交互式搜索 Marketplace，让用户选择 skill
- `purr skill install <slug>`（无 `--agent`）→ 自动检测已安装 agents，多选让用户选择目标
- `purr skill remove`（无 slug）→ 列出已安装 skills，让用户选择要卸载的

当所有参数通过 flags 提供时（如 `--agent openclaw --yes`），跳过交互，适合 agent 程序化调用。

推荐使用 `@clack/prompts` 作为交互式 UI 库（与 heurist-skills-cli 一致）。

### 命令接口设计

```bash
# 查看远程可用 skills
purr skill list --remote [--search <term>] [--category <name>] [--json]

# 查看已安装 skills
purr skill list [--global] [--json]

# 安装 skill（交互式 or 全 flags）
purr skill install [<slug>] [--agent <name>]... [--global] [--copy] [--force] [--json]

# 卸载 skill（交互式 or 全 flags）
purr skill remove [<slug>] [--agent <name>] [--global] [--yes] [--json]
```

### Marketplace API

标准 REST API，公开访问，无需认证。API 返回 skill 元数据（slug、name、description、category 等），CLI 无需下载 ZIP 即可展示列表信息。

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/skills` | GET | 列表 + 元数据（支持 ?category=&search=&offset=&limit=） |
| `/skills/{slug}` | GET | 单个 skill 详情 + 元数据 |
| `/skills/{slug}/download` | GET | 下载 ZIP（header 含 X-Skill-SHA256） |

**List 接口返回的元数据字段（最小集）：**
```json
{
  "skills": [
    {
      "slug": "dune",
      "name": "Dune Analytics",
      "description": "Query blockchain data with DuneSQL",
      "category": "Crypto",
      "download_url": "/skills/dune/download"
    }
  ],
  "total": 42
}
```

Base URL 通过 `SKILL_MARKETPLACE_URL` 环境变量或 `purr config set skill-marketplace-url <url>` 配置。

### 安装目录约定

| Scope | Canonical Path | Lock File |
|-------|---------------|-----------|
| Local (project) | `./.skills/<slug>/` | `./skills-lock.json` |
| Global | `~/.purrfectclaw/skills/<slug>/` | `~/.purrfectclaw/skills-lock.json` |

### Agent 目录映射（初始）

| Agent | Local Skill Path | Global Skill Path |
|-------|-----------------|-------------------|
| OpenClaw | `./.openclaw/workspace/skills/<slug>/` | `~/.openclaw/workspace/skills/<slug>/` |
| Claude Code | `./.claude/skills/<slug>/` | `~/.claude/skills/<slug>/` |
| Cursor | `./.cursor/skills/<slug>/` | `~/.cursor/skills/<slug>/` |
| Windsurf | `./.windsurf/skills/<slug>/` | `~/.windsurf/skills/<slug>/` |
| Cline | `./.cline/skills/<slug>/` | `~/.cline/skills/<slug>/` |
| GitHub Copilot | `./.github/copilot/skills/<slug>/` | `~/.github/copilot/skills/<slug>/` |

> 其他主流 agent 的路径参考 [heurist agents.ts](https://github.com/heurist-network/heurist-skills-cli/blob/main/src/agents.ts)，按需扩展。

### Skill 格式

遵循 heurist skill 标准格式，以 ZIP 包分发：

```
skill-name/
├── SKILL.md              # 必须，主文件（含 YAML front matter）
└── references/           # 可选，补充文档
    ├── guide.md
    └── ...
```

**SKILL.md front matter 格式：**
```yaml
---
name: skill-slug
description: "When to trigger this skill..."
compatibility: "Runtime requirements..."
allowed-tools: Bash(tool:*) Read
metadata:
  author: author-name
  version: "1.0.0"
  cli_version: "0.1"
---
```

### 依赖

- `@clack/prompts` — 交互式 UI（选择 agent、搜索 skill 等）
- `picocolors` — 终端着色
- ZIP 解压：轻量库如 `fflate`，或参考 heurist 的内置 ZIP parser
- Node.js 内置的 `fs`、`path`、`crypto`（SHA256）足够处理其余逻辑

### 与现有代码的集成

- `main.ts`: 新增 `case 'skill':` 分支，动态 import `src/skill/commands/*.ts`
- `api-client.ts`: 可考虑复用 `loadConfig()` 读取 marketplace URL 配置
- `config`: 新增 `skill-marketplace-url` 配置项（可选，有默认值）
- 输出格式: 与现有命令一致，默认 `console.log(JSON.stringify(result))`

## Success Metrics

- agent 可以通过 `purr skill install <slug> --agent openclaw --yes` 一行命令完成 skill 安装
- `purr skill list --json` 输出可被 agent 程序化解析
- install → remove → install 循环操作后 lock file 状态正确
- symlink 模式下多 agent 安装同一 skill，canonical 目录只存一份

## Resolved Questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Marketplace API 认证方式 | 公开访问，无需鉴权 |
| 2 | Skill 分发格式 | ZIP |
| 3 | OpenClaw skill 目录 | `~/.openclaw/workspace/skills/`，其他 agent 参考 heurist |
| 4 | `--agent` 自动检测 | 支持。不指定时自动检测 + 交互选择；指定时跳过交互 |
| 5 | Lock file git commit | 是，project-level 的 `skills-lock.json` 应纳入版本控制 |
| 6 | Marketplace API endpoint 设计 | 标准 REST API（list/detail/download），支持动态更新 |
| 7 | Skill 元数据来源 | API list 接口直接返回元数据（slug、name、description、category） |
| 8 | Verification gate | V1 不做，Marketplace 上的 skill 默认可信 |
