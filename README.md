# 多机器人消息面板

面向当前 Orangezai / TRSS 风格 Yunzai 框架的消息插件。页面挂载在框架现有 HTTP 服务的 `/bot-web/`，不创建独立端口，不依赖 Guoba 登录。

## 安装

在 Yunzai 框架根目录执行：

```sh
git clone https://github.com/Tong068/bot-web-panel.git plugins/bot-web-panel
```

框架需提供 `express`、`sqlite3`、`yaml` 和 `file-type` 依赖。仓库包含前端构建产物，安装后重启框架即可使用。

## 使用

插件已包含构建后的 `web/dist`。重启框架后访问 `http://localhost:2536/bot-web/`，端口以框架配置为准。主人也可以发送 `#消息面板` 查看入口说明。

主人发送 `#面板登录` 或 `#消息面板登录` 可获取免密码登录链接（兼容“登陆”和省略 `#`）。登录消息采用合并转发，分别展示自定义地址、内网地址、外网地址和 IPv6 地址；没有地址的类别会显示未配置或未获取到。群聊触发时，合并转发只通过当前机器人私信发送；私信失败时请添加机器人好友后私聊重试。所有地址共用一个临时令牌，3 分钟内有效且只能使用一次，打开后建立与密码登录相同的管理员会话，默认有效期为 24 小时。修改或重置密码会使已有会话和未使用的登录链接失效。

自定义地址来自 `publicUrl` 和 `allowedOrigins`，自动地址使用框架实际监听端口，包含本机入口、网卡 IPv4、可用 IPv6 及公网 IP 查询结果。公网 IPv4 优先使用锅巴同源的 zxinc HTTPS 查询，失败时尝试 ipify；IPv6 使用 ipify，失败时尝试 ipw.cn。单次请求超时 3 秒，成功缓存 10 分钟，失败缓存 1 分钟，查询失败不影响其他地址。IPv6 使用方括号拼接端口，过滤不可直接在浏览器中使用的链路本地地址；只监听 IPv4 或回环接口时不会生成未监听的 IPv6 链接。

使用域名、反向代理或公网映射时，可在 `config/config.yaml` 设置 `publicUrl: 'https://chat.example.com/bot-web/'`，也可填写 URL 数组。自定义地址与其他类别同时展示。外网地址需要防火墙放行及必要的端口映射；外部端口与监听端口不同应填写自定义地址。HTTPS 反代仍需把 `https://chat.example.com` 加入 `allowedOrigins`。

管理员账号为 `admin`。首次生成的随机密码显示在启动日志，并保存在插件目录的 `data/initial-password.txt`。登录后可在设置中修改密码，修改会使已有会话失效并删除初始密码文件。

忘记密码时，在框架根目录执行：

```powershell
node plugins/bot-web-panel/scripts/password.mjs
```

选中机器人后，可从「消息」查看最近会话，从「好友与群」主动打开联系人。支持文本、图片、表情、@、引用、文件与撤回；按钮根据适配器能力启用。文件可选择、粘贴或拖拽上传。默认 Enter 发送、Shift+Enter 换行，可在设置中更改发送组合键。

所有 ID 按字符串保存，机器人、群和私聊分别隔离。切换机器人保留会话选择与草稿；手机界面通过聊天标题左侧返回按钮切换会话。

## 头像、设置与菜单

群、好友、机器人和消息发送者的头像优先使用适配器提供的头像信息或 `getAvatarUrl()`，通过登录鉴权后的媒体接口加载，可点击预览。旧记录读取时也会补全头像；缺少接口或加载失败时显示 Stapxs 默认图标。官机的 OpenID 原样传给对应适配器，不能按普通 QQ 号码拼接头像；平台不提供群头像时使用回退图标。

「设置」复用 Stapxs 的选项行和 Border-Card-UI 控件，提供界面、聊天、存储与账户三个分类：自动/手动明暗主题、六种原主题色、独立显示自己的消息、最近/全部会话、发送键及图片自动加载开关。关闭图片自动加载后，点击消息里的图片占位再加载。

- 会话右键菜单：置顶/取消置顶、标记已读/未读、复制会话 ID、头像预览。
- 消息右键菜单：回复、完整文本或选中文字复制、@发送者、复制发送者/消息 ID、下载图片与附件、撤回。能力不足的操作禁用。
- 手机支持长按菜单，移动手指取消长按；菜单支持方向键、Home/End 和 Escape，聚焦会话或消息后可用 Shift+F10 打开。

界面和聊天偏好存于当前浏览器 `localStorage`，不跨浏览器同步；会话置顶、未读位置存于服务端 SQLite，按机器人、会话类型和目标 ID 隔离。手动将当前会话标为未读会回到列表，重新进入后标为已读。存储限制仍由服务器统一管理。

完整的上游功能差距、状态统计及分批计划见 [ROADMAP.md](ROADMAP.md)，实际验证范围见 [VALIDATION.md](VALIDATION.md)。

## 记录与适配器

- 从插件启用后开始记录，不导入旧历史。浏览器关闭后仍记录框架接收到的消息。
- 自动记录适配器标准发送入口的消息，包括插件回复和主动发送。已接入内置 OneBot、OPQ、ComWeChat、GSUIDCore、Satori、标准输入，以及当前安装的 ICQQ、QQBot。ICQQ 和 OneBot 的 `QQ` 适配器 ID 结合名称识别。
- 绕过框架及适配器标准入口、直接发起自定义 SDK/HTTP 请求的插件，需要增加相应发送桥接才能记录。
- 同时监听发送上报并去重；回执早于 HTTP 返回也合并到原发送记录。发送请求使用唯一标识，连接中断不会自动重发。
- 多段发送返回的各个消息 ID 都登记到同一记录；后台账号消息和 SSE 断线补同步保留账号及会话隔离。批量上传途中切换账号时，整批附件仍放入原会话草稿。
- 显示发送中、已发送、失败、部分失败和结果未确认。30 秒未取得回执时显示未确认，后台继续等待回执，避免误触导致重复发送。
- 官机遵循平台自身的回复窗口、主动发送次数和文件能力等限制，面板不绕过这些规则。框架/适配器未上报或已过滤的消息无法在面板中恢复。
- 引用与撤回需要适配器返回有效消息 ID。ICQQ 和 OneBot 的合并转发展开时读取内容，支持嵌套转发、图片预览、缓存和失败重试；未知或暂不可解析的消息段显示占位。

## 配置

首次加载创建 `config/config.yaml`，默认值见 `config/default.yaml`。记录、上传和缓存限制可以从页面设置；其他配置修改后重启框架。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 |
| `retentionDays` | `7` | 消息、实时事件与媒体保留天数 |
| `uploadMaxMB` | `20` | 单文件及媒体下载大小上限 |
| `mediaCacheMB` | `512` | 媒体缓存总量；超出时清理最早缓存 |
| `sessionHours` | `24` | 管理员会话有效期 |
| `publicUrl` | `''` | 登录命令的自定义入口，支持完整域名或 `/bot-web/` 地址，也可填写多个 URL 的数组；其他地址仍自动生成 |
| `allowedOrigins` | `[]` | 反向代理使用的完整外部地址，例如 `https://chat.example.com` |
| `mediaHosts` | `[]` | 允许访问的本地适配器媒体服务，填写精确 `host:port` |

例如 NapCat 的媒体地址使用 `http://127.0.0.1:3000` 时，将 `127.0.0.1:3000` 加入 `mediaHosts`。普通公网媒体无需配置；本地地址默认阻止，防止将面板用作任意内网代理。仅被消息登记的媒体可被下载。

消息库位于 `data/panel.sqlite`，媒体位于 `data/media`。停用框架后可备份整个 `data`。SQLite 使用 WAL；不要在框架运行时只复制主数据库文件而忽略 WAL。

QQ 图片下载时动态获取对应账号的 rkey，区分私聊和群聊；兼容 ICQQ、LLOneBot 及 NapCat 的接口格式。视频、语音通过文件标识刷新下载链接，已有历史记录会尝试从原消息或合并转发恢复文件标识。本地媒体缓存可用时直接返回缓存；平台原消息或文件记录已过期时，可能无法重新取得下载链接。

## 反向代理

实时通道使用 SSE。反代需要关闭缓冲并允许长连接；无需额外配置 WebSocket 或开新端口。

```nginx
location /bot-web/ {
    proxy_pass http://127.0.0.1:2536;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 20m;
}
```

HTTPS 反代时把实际 `https://域名` 写入 `allowedOrigins`。不要把数据库、初始密码或插件源码目录作为静态网站公开。

## 前端来源

使用 Stapxs QQ Lite `7a895b964a67faf72f912370eb769adce16e37cc` 的原始 `view.css`、`chat.css`、`msg.css`、图标及联系人组件。聊天窗口、消息组件、图片预览与表情面板沿用其结构并适配多机器人数据和能力限制。原始页面保存在 `web/upstream-source` 供对照；没有引入桌面客户端、空间、账号登录管理等功能。

原始样式保持独立，布局适配集中在 `web/src/panel.css`。源码来源及子模块提交见 `UPSTREAM.md`。本插件按 AGPL-3.0-only 提供，保留上游版权和独立资源许可证。

## 开发和验证

```powershell
# 首次修改前端前安装其独立依赖
cd plugins/bot-web-panel/web
npm ci --workspaces=false
npm run build
# 监听构建，不启动 Vite 端口
npm run watch
```

从框架根目录运行后端测试：

```powershell
npm --prefix plugins/bot-web-panel test
```

浏览器集成测试使用真正的框架 HTTP 服务与测试机器人，绝不连接真实账号。它只使用配置示例端口 2536；若已有服务占用，立即退出，不替换正在运行的机器人：

```powershell
node plugins/bot-web-panel/tests/browser.mjs
```

当前环境的 Chromium 路径写在浏览器测试中；换机器时将其调整为本机 Playwright Chromium。截图生成在 `tests/output`。

只检查表情和 @ 成员面板时，可保持框架运行，执行下列浏览器回归。它复用框架提供的静态资源，拦截全部面板 API 使用本地测试数据，不读取真实会话或向真实账号发送消息：

```powershell
node plugins/bot-web-panel/tests/composer-panels.mjs
```

覆盖多人纵向列表、搜索、键盘选择、面板边界、点击外部关闭、请求取消和跨机器人隔离。`BOT_WEB_URL` 可指定现有框架地址。

登录命令的浏览器回归可运行 `node plugins/bot-web-panel/tests/login-browser.mjs`。它复用运行中框架的静态资源，将全部 API 请求转到临时数据库，验证桌面及手机自动登录、地址栏令牌清理、退出、链接失效和密码登录，不操作真实账号。

真实框架运行期间可以执行只读冒烟检查（仅登录、读取和退出，不发送聊天消息）：

```powershell
node plugins/bot-web-panel/tests/live-smoke.mjs
```

默认读取初始密码文件；修改密码后通过 `BOT_WEB_PASSWORD` 环境变量提供密码。`BOT_WEB_URL` 可覆盖框架地址。验证范围和实际结果见 `VALIDATION.md`。

后端只调用 `Bot.express.use()` 挂载路由；`tests/browser.mjs` 中由框架自身的 `serverLoad()` 启动测试宿主。插件关闭时只撤销自身路由、监听和计时器，不关闭共享服务器。
