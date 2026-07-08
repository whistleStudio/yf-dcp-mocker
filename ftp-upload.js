/**
 * FTP文件上传示例
 * 使用basic-ftp库连接到FTP服务器并上传文件
 */

const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');

// FTP配置
const FTP_CONFIG = {
  host: '127.0.0.1',
  port: 21,
  user: 'firefly',
  password: 'firefly'
};

// 创建FTP客户端
const client = new ftp.Client();
client.ftp.verbose = false;

/**
 * 连接到FTP服务器
 */
async function connect() {
  try {
    await client.access({
      host: FTP_CONFIG.host,
      port: FTP_CONFIG.port,
      user: FTP_CONFIG.user,
      password: FTP_CONFIG.password,
      secure: false
    });
    console.log('FTP连接成功');
  } catch (err) {
    console.error('FTP连接错误:', err);
    throw err;
  }
}

/**
 * 上传文件到FTP服务器（带清理逻辑）
 * @param {string} localPath - 本地文件绝对路径
 * @param {string} remotePath - 远程文件相对路径（基于FTP根目录）
 */
async function uploadFile(localPath, remotePath) {
  // 检查本地文件是否存在
  if (!fs.existsSync(localPath)) {
    throw new Error(`本地文件不存在: ${localPath}`);
  }

  // 必须指定远程路径
  if (!remotePath) {
    throw new Error('必须指定远程路径，例如: plan/app/file.plan');
  }

  // 确保是相对路径（去掉开头的 /）
  remotePath = remotePath.replace(/^\/+/, '');

  // 获取本地文件大小用于验证
  const localSize = fs.statSync(localPath).size;
  console.log(`开始上传: ${localPath} -> ${remotePath} (${localSize} bytes)`);

  try {
    // 确保远程目录存在
    const remoteDir = path.dirname(remotePath);
    await client.ensureDir(remoteDir);

    // 上传文件
    await client.uploadFrom(localPath, remotePath);

    // 验证上传文件大小
    const remoteSize = await client.size(remotePath);
    if (remoteSize === localSize) {
      console.log(`上传成功 (${remoteSize} bytes):`, remotePath);
      return remotePath;
    } else {
      throw new Error(`文件大小不匹配 (本地${localSize} vs 远程${remoteSize})`);
    }
  } catch (err) {
    console.error('上传失败:', err.message);

    // 清理残缺文件
    console.log('尝试清理残缺文件...');
    try {
      await client.remove(remotePath);
      console.log('已清理残缺文件:', remotePath);
    } catch (deleteErr) {
      console.log('清理失败（文件可能不存在）');
    }

    throw err;
  }
}

/**
 * 上传文件（可选：不覆盖已存在文件）
 * @param {string} localPath - 本地文件路径
 * @param {string} remotePath - 远程文件路径
 * @param {object} options - 选项 { overwrite: true/false }
 */
async function uploadFileEx(localPath, remotePath, options = {}) {
  const { overwrite = true } = options;

  if (!overwrite) {
    const exists = await fileExists(remotePath);
    if (exists) {
      console.log(`跳过（已存在）: ${remotePath}`);
      return remotePath;
    }
  }

  return uploadFile(localPath, remotePath);
}

/**
 * 批量上传文件（原子性：全部成功或全部回滚）
 * @param {Array} files - [{localPath, remotePath}, ...]
 */
async function uploadFiles(files) {
  const uploaded = []; // 记录已上传成功的文件

  try {
    for (const file of files) {
      const result = await uploadFile(file.localPath, file.remotePath);
      uploaded.push(result);
    }
    console.log(`✅ 批量上传成功: ${uploaded.length}个文件`);
    return uploaded;
  } catch (err) {
    console.error('❌ 批量上传失败，开始回滚...');

    // 回滚：删除所有已上传的文件
    for (const remotePath of uploaded) {
      try {
        await deleteFile(remotePath);
        console.log('已回滚:', remotePath);
      } catch (deleteErr) {
        console.error('回滚失败:', remotePath, deleteErr.message);
      }
    }

    throw err;
  }
}

/**
 * 下载文件从FTP服务器
 * @param {string} remotePath - 远程文件路径（相对路径）
 * @param {string} localPath - 本地文件路径
 */
async function downloadFile(remotePath, localPath) {
  // 规范化路径：去掉开头的 /
  remotePath = remotePath.replace(/^\/+/, '');

  console.log(`开始下载: ${remotePath} -> ${localPath}`);

  // 确保本地目录存在
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await client.downloadTo(localPath, remotePath);
  console.log('下载成功:', localPath);
  return localPath;
}

/**
 * 列出远程目录内容
 * @param {string} remotePath - 远程目录路径（相对路径）
 */
async function listDir(remotePath = '') {
  // 规范化路径：去掉开头的 /
  remotePath = remotePath.replace(/^\/+/, '');

  const list = await client.list(remotePath);
  console.log(`目录内容 (${remotePath || '/'}):`);
  list.forEach(item => {
    const type = item.isDirectory ? '[DIR]' : '[FILE]';
    const size = item.size ? `(${item.size} bytes)` : '';
    console.log(`  ${type} ${item.name} ${size}`);
  });
  return list;
}

/**
 * 检查远程文件是否存在
 * @param {string} remotePath - 远程文件路径
 */
async function fileExists(remotePath) {
  try {
    await client.size(remotePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取远程文件大小
 * @param {string} remotePath - 远程文件路径
 */
async function getFileSize(remotePath) {
  return await client.size(remotePath);
}

/**
 * 创建远程目录
 * @param {string} remotePath - 远程目录路径（相对路径）
 */
async function mkdir(remotePath) {
  // 规范化路径：去掉开头的 /
  remotePath = remotePath.replace(/^\/+/, '');

  await client.ensureDir(remotePath);
  console.log('创建目录成功:', remotePath);
  return remotePath;
}

/**
 * 删除远程文件
 * @param {string} remotePath - 远程文件路径（相对路径）
 */
async function deleteFile(remotePath) {
  // 规范化路径：去掉开头的 /
  remotePath = remotePath.replace(/^\/+/, '');

  await client.remove(remotePath);
  console.log('删除文件成功:', remotePath);
  return remotePath;
}

/**
 * 断开FTP连接
 */
function disconnect() {
  client.close();
  console.log('FTP连接已断开');
}

/**
 * 测试上传速度
 * @param {number} sizeMB - 测试文件大小(MB)
 */
async function testUploadSpeed(sizeMB = 1) {
  const testFile = path.join(__dirname, `speed-test-${sizeMB}MB.bin`);
  const remotePath = `speed-test-${sizeMB}MB.bin`;

  try {
    // 生成测试文件
    console.log(`生成 ${sizeMB}MB 测试文件...`);
    const bufferSize = 1024 * 1024; // 1MB
    const buffer = Buffer.alloc(bufferSize, 0x41); // 填充 'A'
    const writeStream = fs.createWriteStream(testFile);

    for (let i = 0; i < sizeMB; i++) {
      writeStream.write(buffer);
    }
    writeStream.end();

    await new Promise(resolve => writeStream.on('finish', resolve));

    const fileSize = fs.statSync(testFile).size;
    console.log(`文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    // 上传测速
    console.log('开始上传...');
    const uploadStart = Date.now();
    await uploadFile(testFile, remotePath);
    const uploadTime = Date.now() - uploadStart;

    // 计算速度
    const speed = (fileSize / 1024 / 1024) / (uploadTime / 1000);
    console.log(`\n=== 测试结果 ===`);
    console.log(`上传时间: ${uploadTime}ms`);
    console.log(`上传速度: ${speed.toFixed(2)} MB/s`);

    // 清理
    await deleteFile(remotePath);
    fs.unlinkSync(testFile);

    return { time: uploadTime, speed };
  } catch (err) {
    // 清理
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    throw err;
  }
}

// 导出函数供外部使用
module.exports = {
  connect,
  uploadFile,
  uploadFileEx,
  uploadFiles,
  downloadFile,
  listDir,
  mkdir,
  deleteFile,
  fileExists,
  getFileSize,
  disconnect,
  testUploadSpeed,
  FTP_CONFIG
};

// 如果直接运行此文件，执行测试
if (require.main === module) {
  (async () => {
    try {
      await connect();
      console.log('=== FTP上传测试 ===\n');

      // 测试上传
      const testFile = path.join(__dirname, 'test-upload.txt');
      fs.writeFileSync(testFile, `测试文件\n时间: ${new Date().toISOString()}`);
      await uploadFile(testFile, 'test/test-upload.txt');

      // 列出目录
      console.log('');
      await listDir();

      // 清理
      await deleteFile('test/test-upload.txt');
      fs.unlinkSync(testFile);

      console.log('\n=== 测试完成 ===');
      disconnect();
    } catch (err) {
      console.error('测试失败:', err);
      disconnect();
      process.exit(1);
    }
  })();
}
