# 版本更新记录

## v0.4.1 — 2026-11-11
- 基于 `v0.3` 修复，不继承 `v0.4`；使用独立的 IndexedDB、localStorage、迁移标记和 Service Worker Cache 命名空间。
- 首次启动只检查并一次性迁移 V0.3 的加密 Token、connection 和可选显示偏好，不迁移业务数据、dirty／pending、同步元数据或 staging。
- 将业务记录、照片、同步元数据和 Refresh staging 限定到规范化 Database ID 对应的 Workspace；断开、同库重连和换库统一删除当前 Workspace，同时保留加密 Token。
- 连接已有 Database 改为先只读验证、后确认并原子提交；创建新 Database 在远程初始化成功前保留旧连接，连接提交失败时保留初始化恢复点。
- 增加连接 session ID，使同库重连、换库或断开后的旧 Refresh、Upload 和照片保存结果失效；区分按 Workspace 保存的 `remote-refresh` 与按目标 Database 保存的 `initialization-recovery`。
- Refresh 改为当前 Workspace 单事务合并：保留仅本地 dirty／pending、Remote Missing 记录及其照片，并基于最终合并结果解析 Relation。
- Relation 上传严格校验来源、目标 Workspace、目标 entity 和 Page ID；失效 Relation 明确停止写入，不按名称替代或静默转空。
- Windows 工具栏恢复大分类、小分类、新增分类和分类管理入口；保存本地后若记录被当前分类或搜索隐藏，会明确提示已保存及所属分类。
- 保持具体资料以 `localId`／UUID 为身份，未增加按名称覆盖、去重或 Relation 匹配；删除无引用的 `.demo-notice` 样式。
- 最低检查：`storage.js`、`sync.js`、`app.js`、`notion-api.js`、`sw.js` 已通过 `node --check`；未执行浏览器、真实 Notion、Windows 或 iPhone 实机验证。

## v0.4 — 2026-11-10
- 修正通用 Notion URL／UUID 解析，支持带页面标题的 `app.notion.com` URL、紧凑 ID 和标准 UUID。
- 新增空数据库下在具体资料表单内连续创建大分类、小分类和状态的流程，并补齐分类归属修改、排序和占用删除保护。
- 将状态从具体资料 Select 改为独立状态 Data Source，通过 Relation 双向同步名称、颜色和排序，并新增 Notion 风格状态标签。
- 优化主图标记和切换，完善配对选项的正式编号／本地记录提示，以及亲本查看并跳转子代。
- 新增 IndexedDB v0.4 升级迁移和 Persistent Storage 请求／状态显示，清除连接时继续保留业务草稿。
- 将初始化和连接错误完整显示在当前弹窗内，并修正移动端输入字号、动态 viewport、弹窗滚动、底部操作和卡片尺寸稳定性。
- 保持 Windows 表格／卡片框架与手动同步边界；未执行真实 Notion、GUI、iPhone 或 Windows 实机验证。

## v0.3 — 2026-11-10
- 将数据层改为 Notion API `2026-03-11` 的 Database、四个 Data Source、Page 与 Property ID 分层模型，并集中定义 Schema。
- 新增 Token 加密本机保存、创建新库／连接既有库、初始化中断恢复、连接设置与清除本机连接配置。
- 新增 IndexedDB 本地优先存储，以及用户主动触发的分页刷新、差异预览、冲突选择、依赖顺序上传和单条保存并上传。
- 新增具体资料与配对记录编辑、最多五张照片、直接来源防循环、亲本／子代关系、已上传资料的本地二维码、桌面表格与图片卡片、手机分类图片浏览和显示字段设置。
- 更新 PWA 离线缓存清单；没有内置 Token、没有自动同步，也没有执行真实 Notion 写入或浏览器实机测试。
- 局部修正二维码及“打开 Notion 页面”链接：保存并使用 Notion API 返回的真实 Page URL，不再根据 Page ID 自行拼接。
- 局部修正 Notion API 404 提示，同时说明资源不存在和 Integration 未获授权两种可能。
- 局部修正分类过滤，使手机图片列表、Windows 表格和 Windows 卡片模式共同使用同一分类范围与搜索结果。

## v0.2 — 2026-10-27
- 新增大分类、小分类与具体记录的三级分类浏览、管理、排序和批量重分类。
- 新增分类导航、图片图库、自定义组合三种手机首页布局及本机显示偏好。
- 新增多图、照片日期来源、日期排序、手动首图与无名称／无照片记录支持。
- 新增 IndexedDB 本地暂存与防抖待同步队列演示，明确保持未连接 Notion 状态。
- 保留并扩展 Windows 表格、搜索筛选、Excel 粘贴和双向关联操作。

## v0.1 — 2026-10-26
- 首次发布适配 iPhone 与 Windows 的原生 Web PWA 模拟界面。
- 新增采购清单（16 字段）与售出记录（7 字段）的虚构数据操作。
- 支持搜索、筛选、新增、编辑、复制、文本及 Excel 表格粘贴。
- 支持多对多双向关联、关联跳转编辑与返回。
- 新增 Manifest、应用图标与离线缓存 Service Worker。
