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

## 常见错误

- 路径写成绝对路径：一律用仓库根出发的相对路径。
- 登记了目录：只接受单个文件，目录请逐个登记。
