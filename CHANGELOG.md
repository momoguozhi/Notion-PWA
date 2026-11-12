# 版本更新记录

## v0.4.5 — 2026-11-12
- 创建流程改为要求并保存用户输入的 Database 名称；Notion Page 仅作为创建 parent，Database ID 作为连接、Workspace 与 recovery 身份，同名 Database 可独立初始化。
- initialization-recovery 改为按目标 Database ID 独立列出，并保留名称、状态、短 ID、时间、阶段、Data Source ID 与结构化错误；“暂不处理”不写入或删除记录，多条 recovery 不阻止新建。
- 恢复流程严格重新读取原目标 Database，校验已保存 Data Source 的 parent，复用目标内正确对象、仅创建缺失对象、按实际 Relation 目标补建并执行最终 Schema 验证；成功提交 connection 后只清除选中的 recovery。
- 初始化阶段增加精确进度与 409 错误定位；移除具体资料 `unique_id` 的固定 `ITEM` prefix，改由 Notion 使用空 prefix 配置，并避免对已正确 Relation 无条件重复 PATCH。该修改已通过无网络请求构造测试，真实 Notion 409 是否消失仍待人工复测。
- 连接切换／断开不再删除旧 Workspace 的业务数据、照片、同步元数据或 Refresh staging；目标 Workspace 在 connection 提交前读取，读取或提交失败时原 active connection 与 Workspace 保持不变。
- 设置页增加 Database 名称、状态与短 ID，并加入只读本机诊断：区分全部 recovery、各类 staging 与当前 Workspace 数量／pending／dirty／busy，不输出 Token、密码、Photo Blob 或完整业务正文。
- 保持 `SCHEMA_VERSION = 5`，未增加远程版本字段或新版本体系；页面与 Service Worker Cache 更新为 v0.4.5，继续沿用 `notion-pwa-v041` IndexedDB。
- 9 个 JavaScript 文件通过 `node --check`；直接调用实际 `notion-api.js`、`storage.js`、`logic.js` 的无网络隔离测试覆盖双 Database 请求隔离、恢复复用、409 阶段、0／1／多 recovery、精确清理、连接事务与诊断脱敏。未操作真实浏览器、IndexedDB、Notion、账号或设备。

## v0.4.4 — 2026-11-12
- 初始化恢复页支持列出多个 recovery，并可逐项继续或放弃；放弃仅删除目标 recovery 标记，全部处理后可返回创建流程。初始化、恢复和连接的关键异步阶段锁定返回、关闭、重复开始及 Escape 取消。
- 为同一 Workspace 的所有 Upload 与冲突重试增加批次互斥，并为同一 local UUID 增加记录级合并；失败时释放锁且保留 pending。小分类所属大分类、具体资料小分类、配对母本／父本在照片或页面远程写入前强制验证，子代仍允许为空。
- 具体资料普通输入框与下拉框中的 Enter 不再提交或关闭表单；保存操作增加重复提交保护。具体资料与照片的保存、替换及删除改为同一 IndexedDB 事务，并继续受 Workspace／session gate 约束。
- 分类管理改为可展开树形视图，支持独立编辑入口、小分类改挂、占用／已同步删除保护、同级拖动草稿与显式保存；取消或关闭不写入未确认排序，触摸拖动仅由手柄触发。
- 分类浏览默认显示全部；大分类筛选显示其全部小分类资料，小分类继续收窄，且浏览筛选状态与分类管理状态分离。卡片显示字段中移除正式编号选项与“本地待编号”占位，表格和记录详情仍保留正式编号。
- 从当前具体资料表单、本地保存、Upload、Refresh 与远程必需 Schema 中移除扦插日期；正常保存会清理旧本地字段，连接验证允许远程保留该历史额外字段。
- 页面和 Service Worker Cache 更新为 v0.4.4；继续沿用 `notion-pwa-v041` IndexedDB。9 个 JavaScript 文件通过语法检查；上传互斥／Relation、恢复隔离、Item/Photo 事务、分类筛选排序及旧远程额外字段通过无网络隔离测试。未执行真实浏览器、真实 Notion、真实账号或设备测试。

## v0.4.3 — 2026-11-11
- 修正通用 Notion URL／UUID 提取，支持带标题的页面 URL、纯紧凑 ID 与标准 UUID，避免标题中的十六进制字符污染目标 ID。
- 从当前具体资料业务 Schema、表单、显示、搜索、Refresh 和 Upload 映射中移除旧状态、旧录入类型与旧直接来源；普通来源、扦插日期及配对记录保留。
- 修复 Refresh Relation 合并：保留 local 时不再被残留远程 Page ID 覆盖；采用 remote 时按最终 Workspace 的 Page ID 精确解析，非空目标无法解析即停止，数组不再按位置回退，合法空子代仍可应用。
- 增加具体资料“大分类 → 小分类”级联选择与表单内分类补建；增加小分类改挂大分类，保持原 localId／Notion Page 身份，所有分类修改只保存本地并标记待上传。
- 无 active Database 时禁用或阻止业务新增、分类管理、刷新与上传；Token 配置提供明确关闭入口，Token、创建、连接和恢复错误显示在当前弹窗内。
- 页面版本和 Service Worker Cache 命名空间更新为 v0.4.3；请求及离线 fallback 只查询当前 Cache，继续沿用 `notion-pwa-v041` IndexedDB。
- 调整手机输入字号、动态 viewport、弹窗滚动与底部操作、分类导航高度、图片比例和长文本约束；未执行真实 iPhone 或其他设备实测。
- 最低检查：8 个 JavaScript 文件通过 `node --check`；4 种 Notion ID 输入、废弃字段清理及 4 个 Refresh Relation 场景通过本地无网络函数级断言。未执行浏览器、真实 Notion、Windows 或 iPhone 实机验证。

## v0.4.2 — 2026-11-11
- 修复同库重连、换库或断开进入本地提交阶段后，旧 Refresh、Upload、照片及记录写入仍可能排在连接事务之后重新写回 Workspace 的竞态：旧 session 先失效，Workspace 写入和连接切换共用串行提交 gate。
- 保持连接事务失败时原 active connection 与 Workspace 不丢失，并为原连接建立新的可用 session；已失效旧 session 仍不能继续提交。
- 发现唯一 `initialization-recovery` 时，用户取消恢复会直接结束本次创建，不删除恢复点，也不调用新 Database 创建流程。
- Service Worker 改为只打开并查询 V0.4.2 当前 Cache；请求与离线 `index.html` fallback 均不再使用跨 Cache 的全局 `caches.match()`。
- 页面版本与 Cache 前缀更新为 V0.4.2；继续沿用 V0.4.1 的 `notion-pwa-v041` IndexedDB、Workspace 数据结构和 migration flag，不执行新业务数据迁移。
- 最低检查：`storage.js`、`sync.js`、`app.js`、`sw.js` 已通过 `node --check`；未执行浏览器、真实 Notion、Windows 或 iPhone 实机验证。

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
