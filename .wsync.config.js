module.exports = {
  // 源目录: WSL2 中的项目路径 (相对于配置文件)
  source: '.',

  // 目标目录: Windows 路径 (必需)
  // 统一使用 /mnt/c/... 格式
  target: '/mnt/d/Workspace/browser',

  // 同步到目标目录的子文件夹下 (可选)
  prefix: '',

  // 白名单: 即使被 .gitignore 忽略，也强制同步
  whitelist: [
    // 'dist/',
  ],

  // 黑名单: 即使 .gitignore 没忽略，也强制排除
  blacklist: [
    '.env',
    '*.log',
    'tmp/',
    '.DS_Store'
  ],

  // 额外要遵循的 ignore 文件
  additionalIgnoreFiles: ['.gitignore'],

  // 保留目标端文件/文件夹: 这些路径不会被 wsync 删除或覆盖
  // 以目标目录为根，支持 glob 模式
  keepTarget: [
    'node_modules/',
    'package-lock.json'
  ],

  // 同步选项
  options: {
    // 删除目标端多余文件
    delete: true,
    // 试运行模式
    dryRun: false,
    // 详细日志
    verbose: false
  }
};
