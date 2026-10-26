<!-- redline-ok-file -->
# 随包文件怎么登记

在 `package.json` 里加一个 `assets` 字段，按「源文件 → 输出路径」逐条登记：

```json
{
  "assets": {
    "templates/init.md": "templates/init.md",
    "examples/basic.json": "examples/basic.json"
  }
}
```

构建时 `shipAssets` 按这张表把文件写进输出目录；源文件不在仓库里，构建直接失败。

## 关于字段名

`assets` 这个名字是 0.3 定下来的。取名时讨论过要不要跟 npm 的 `files` 字段对齐，最后没跟：`files` 管的是「哪些文件进包」，这里管的是「哪些文件进输出目录」，两件事，共用一个名字容易混。

## 常见错误

- 路径写成绝对路径：一律用仓库根出发的相对路径。
- 登记了目录：只接受单个文件，目录请逐个登记。
