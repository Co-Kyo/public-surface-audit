<!-- redline-ok-file -->
# 更新日志

## 0.5.0

- **feat(cli)**：新增 `shipAssets verify`，构建后核对输出目录与名单是否一致，退出码非 0 即不一致。
- **feat(config)**：`assets` 支持 `{"from": ..., "to": ...}` 写法，可把源文件改名后再放进输出目录。
- **docs**：`docs/guide/publish.md` 补 `verify` 的用法。

## 0.4.0

- **feat(cli)**：`shipAssets check` 新增 `--json` 输出，可直接接进 CI 脚本。

## 0.3.2

- **fix(copy)**：清单里的文件缺失时，`check` 现在报错退出（退出码 2），不再只打印一行提示。

## 下一步

- `verify` 目前只比对文件名与路径，0.6 会比对文件内容（哈希），那时才能发现「路径对但内容被替换」。
- 计划把 `assets` 的登记表从 `package.json` 抽到独立的 `ship.config.json`，具体版本待定。
- 构建缓存还没做，大仓库里重复拷贝偏慢，排在 0.6 之后。
