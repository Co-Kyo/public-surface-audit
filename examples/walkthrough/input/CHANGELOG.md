# 更新日志

## 0.4.0

- **feat(cli)**：`shipAssets check` 新增 `--json` 输出，可直接接进 CI 脚本。
- **feat(cli)**：新增 `shipAssets verify`，构建后核对输出目录与名单是否一致。
- **docs**：`docs/guide/publish.md` 补一节「随包文件怎么登记」。

## 0.3.2

- **fix(copy)**：清单里的文件缺失时，`check` 报错退出（退出码 2）。
- **fix(copy)**：目标路径含空格时写入失败——路径没有加引号。

## 0.3.1

- **fix(copy)**：`--dry-run` 不再写盘。

## 0.3.0

- **feat(cli)**：`shipAssets copy` 支持 `--dry-run`。
- **feat(build)**：构建后自动核对名单与输出目录，不一致即失败。

## 下一步

- `verify` 目前只比对文件名与路径，0.5 会比对文件内容（哈希）。
- 构建缓存还没做，大仓库里重复拷贝偏慢，排在 0.5 之后。
