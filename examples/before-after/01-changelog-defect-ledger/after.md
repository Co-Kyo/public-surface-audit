# 更新日志

## 0.4.0

- **feat(cli)**：`shipAssets check` 新增 `--json` 输出，可直接接进 CI 脚本。
- **fix(cli)**：`--json` 输出不再带彩色转义。
- **docs**：`docs/guide/publish.md` 补一节「随包文件怎么登记」。

## 0.3.2

- **fix(copy)**：清单里的文件缺失时，`check` 报错退出（退出码 2）。
- **fix(copy)**：目标路径含空格时写入失败——路径没有加引号。
- **docs**：`docs/guide/cli.md` 的命令表补 `check` 的退出码说明。

## 0.3.1

- **fix(copy)**：`--dry-run` 不再写盘。
- **chore**：依赖升级。

## 0.3.0

- **feat(cli)**：`shipAssets copy` 支持 `--dry-run`。
