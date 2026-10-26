# 更新日志

## 0.5.0

- **feat(cli)**：新增 `shipAssets verify`，构建后核对输出目录与名单是否一致，退出码非 0 即不一致。
- **feat(config)**：`assets` 支持 `{"from": ..., "to": ...}` 写法，可把源文件改名后再放进输出目录。
- **docs**：`docs/guide/publish.md` 补 `verify` 的用法。

## 0.4.0

- **feat(cli)**：`shipAssets check` 新增 `--json` 输出，可直接接进 CI 脚本。

## 0.3.2

- **fix(copy)**：清单里的文件缺失时，`check` 现在报错退出（退出码 2），不再只打印一行提示。
