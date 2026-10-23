# 单文件替换

在源文件的卡片、列表操作栏或手机操作菜单中点击“替换文件”，浏览文件夹并选择一个被替换文件，再点击“确认替换”。不提供文件夹或批量替换。

- 默认保留源文件，效果类似复制；勾选“替换成功后删除源文件”，效果类似移动。
- 目标保留固定 ID、永久链接、历史路径、名称、目录、标签、上传时间与访问名单。内容、存储渠道、大小、图片尺寸和内容审查标签取自源文件；不会沿用目标的旧尺寸。目标类型须与源文件 MIME 类型一致，例如 PNG 替换 PNG、PDF 替换 PDF。
- 删除源文件后，源文件自己的固定链接和历史链接失效；它们不会改为跳转到目标文件。目标原有链接继续指向目标的新内容。
- 替换只保证本项目 `/file/...` 链接保持不变。直接复制的第三方存储地址不属于此保证，可能因旧内容清理而失效。

## 存储和失败处理

先创建独立内容副本，检查源和目标没有变化，再更新目标记录，最后按选择删除源记录、清理旧存储内容。R2、S3、WebDAV 使用独立对象；Discord 使用新消息；HuggingFace 使用新路径。Telegram 使用不可变的文件 ID，图库的删除操作不会删除 Telegram 中的文件内容。

R2 替换后的记录用 `R2FileKey` 指向独立对象；读取、改名、移动和删除均兼容该字段。后续改名或移动会重新把对象放到对应路径并清除这个字段。

复制失败不会覆盖目标或删除源文件。目标已经更新但源记录删除、索引更新或远端旧内容清理失败时，界面显示具体的部分成功提示。数据库写入结果不确定时保留已复制内容，避免目标记录可能已生效但内容被回滚删除。

Discord、HuggingFace 复制需要重新上传，当前限制每个文件或分片不超过 20 MiB。WebDAV 服务需支持 COPY。外链及 Telegraph 不支持作为替换源；旧 Telegram 文件 ID 在复制时转为显式存储凭据。目标的新内容使用源文件的渠道，可能与目标原来的渠道不同。

替换调用现有缓存清理逻辑，覆盖目标固定链接和历史路径，删除源文件时也清理源引用缓存。Cloudflare 缓存清理需要已有 Zone ID、邮箱和 API Key 配置；浏览器已缓存的旧内容无法远程撤回。管理端的预览带内容版本参数，以便刷新后读取新内容；复制的永久地址保持原样。

进程内重叠替换会被拒绝，提交前及删除源文件前检查记录快照，旧界面中的内容版本也会被拒绝。KV/D1 与外部对象存储之间没有跨服务事务；KV 还具有最终一致性，因此不应在多个客户端同时替换、移动或删除同一文件。这些检查不能提供跨实例原子互斥。

## 管理接口

`POST /api/manage/replace/{sourcePathOrFixedId}`，JSON 示例：

```json
{
  "target": "documents/report.pdf",
  "deleteSource": false,
  "expectedSourcePath": "incoming/new-report.pdf",
  "expectedTargetPath": "documents/report.pdf",
  "sourceVersion": "",
  "targetVersion": ""
}
```

版本取自列表元数据 `ContentVersion`，未替换过的文件传空字符串。响应包含 `success`、`targetPath`、目标 `fixedId`、实际 `sourceDeleted` 和 `warnings`。替换需要独立的“内容替换”（`replace`）权限；删除源文件还需“文件删除”（`delete`），两项在替换前检查。浏览并选择文件另需“文件浏览”（`list`）。文件整理与新 Token 的系统管理权限均不包含内容替换。旧管理 Token 的原有替换能力展开为显式 `replace` 授权，编辑时可取消；旧整理 Token 不获得替换能力。`/api/agent` 仍只提供浏览和整理接口，其能力发现会提示已授权的替换接口。

## 验证

```sh
node --import ./deploy/server/register.mjs --test tests/file-replacement.test.mjs tests/file-replacement-ui.test.mjs tests/file-identity.test.mjs tests/permanent-link-integration.test.mjs tests/agent-organization.test.mjs tests/unified-names.test.mjs tests/file-details.test.mjs tests/overview.test.mjs
npx wrangler pages functions build functions --outdir .wrangler/replacement-build
cd frontend && npm run build
```

测试使用 KV/D1 和第三方存储模拟，覆盖新旧引用读取、PDF、独立副本、源文件删除、R2 后续操作、权限、冲突和失败恢复；不代表已对生产存储完成在线验证。
