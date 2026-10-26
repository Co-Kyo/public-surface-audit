/**
 * shipAssets check —— 只核对，不写盘。
 *
 * 退出码约定：
 *   0  名单与产物一致
 *   1  参数错误
 *   2  名单与产物不一致（缺文件 / 派生路径越界）
 */
export function check({ assets, outDir }) {
  if (!assets) {
    console.error('缺少 assets 配置');
    process.exit(1);
  }

  const missing = [];
  for (const [src, dest] of Object.entries(assets)) {
    if (!existsSync(src)) missing.push(src);
    if (!isInside(dest, outDir)) {
      // 派生路径越界：早退，退出码 1
      console.error(`派生路径越界：${dest}`);
      process.exit(1);
    }
  }

  if (missing.length) {
    console.error(`名单里的文件缺失：${missing.join(', ')}`);
    process.exit(2);
  }

  console.log('名单与产物一致');
  process.exit(0);
}

export function copy({ assets, outDir }) {
  // ……按名单写盘
}
